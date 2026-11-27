"""
Flask Backend for Modern Restaurant KOT System with Running Table Bills.
Features:
- Single consolidated bill for dining tables (Round 1, Round 2 add-ons)
- Distinct kitchen KOT sub-tickets per round
- Real-time station isolation (Manager POS, Kitchen KDS, Service Expediter, Customer TVs)
- Full menu CRUD (Add, Edit, Delete, 86 Toggle)
- GST & Discount calculation
"""

import os
import sys
import re
import socket
import json
import time
import queue
import threading
import hashlib
import base64
import struct
import socketserver
import shutil
import sqlite3
import atexit
import urllib.request
import urllib.error
from functools import wraps
from datetime import datetime
from flask import (
    Flask, request, jsonify, session, redirect, url_for,
    send_from_directory, Response
)
import db


def get_resource_path(relative_path: str) -> str:
    """Resolve bundled static/asset paths for both source and PyInstaller .exe builds."""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


PUBLIC_DIR = get_resource_path('public')

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path='')
app.secret_key = os.environ.get('SECRET_KEY', 'kot-super-secret-key-change-in-prod-12345')

@app.after_request
def add_cache_headers(response):
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# Ensure DB is ready & take a rolling startup safety backup
db.init_db()
db.create_startup_safety_backup()
atexit.register(db.checkpoint_db)


# -------------------------------------------------------------
# REAL-TIME INSTANT EVENT BUS & SERVER-SENT EVENTS (SSE)
# -------------------------------------------------------------

class EventBus:
    def __init__(self):
        self.version = 1
        self.lock = threading.Lock()
        self.queues = []

    def register(self):
        q = queue.Queue(maxsize=100)
        with self.lock:
            self.queues.append(q)
        return q

    def unregister(self, q):
        with self.lock:
            if q in self.queues:
                self.queues.remove(q)

    def publish(self, event_type, data=None):
        with self.lock:
            self.version += 1
            v = self.version
            payload = {'version': v, 'type': event_type, 'data': data, 'timestamp': datetime.now().isoformat()}
            for q in list(self.queues):
                try:
                    q.put_nowait(payload)
                except Exception:
                    pass
        return self.version

event_bus = EventBus()

@app.route('/api/stream')
def stream_events():
    """Real-time SSE stream for all monitors (0ms refresh latency)."""
    def gen():
        q = event_bus.register()
        try:
            yield f"data: {json.dumps({'type': 'CONNECTED', 'version': event_bus.version})}\n\n"
            while True:
                try:
                    msg = q.get(timeout=20)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        except GeneratorExit:
            event_bus.unregister(q)
        finally:
            event_bus.unregister(q)

    return Response(gen(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
    })

@app.route('/api/sync')
def sync_poll():
    """Fast version checker."""
    client_v = int(request.args.get('v', 0))
    return jsonify({
        'changed': client_v < event_bus.version,
        'version': event_bus.version
    })


# -------------------------------------------------------------
# INTERCOM — WALKIE-TALKIE VOICE RELAY VIA WEBSOCKET
# Runs as a standalone TCP WebSocket server on port 3001.
# Audio blobs sent by one station are broadcast to all others.
# Control signals (mic_on / mic_off) are also relayed.
# No external dependencies — uses Python's built-in socketserver.
# -------------------------------------------------------------

_intercom_clients = {}      # socket → station label
_intercom_lock = threading.Lock()


def _ws_handshake(conn, data):
    """Perform HTTP → WebSocket upgrade handshake (RFC 6455)."""
    headers = {}
    lines = data.decode('utf-8', errors='ignore').split('\r\n')
    for line in lines[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()

    key = headers.get('sec-websocket-key', '')
    magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    accept = base64.b64encode(
        hashlib.sha1((key + magic).encode()).digest()
    ).decode()

    response = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n'
        '\r\n'
    )
    conn.sendall(response.encode())
    return True


def _ws_recv_frame(conn):
    """Read one WebSocket frame. Returns (opcode, payload_bytes) or (None, None)."""
    try:
        header = b''
        while len(header) < 2:
            chunk = conn.recv(2 - len(header))
            if not chunk:
                return None, None
            header += chunk

        byte1, byte2 = header[0], header[1]
        opcode = byte1 & 0x0F
        masked = bool(byte2 & 0x80)
        length = byte2 & 0x7F

        if length == 126:
            ext = b''
            while len(ext) < 2:
                chunk = conn.recv(2 - len(ext))
                if not chunk:
                    return None, None
                ext += chunk
            length = struct.unpack('!H', ext)[0]
        elif length == 127:
            ext = b''
            while len(ext) < 8:
                chunk = conn.recv(8 - len(ext))
                if not chunk:
                    return None, None
                ext += chunk
            length = struct.unpack('!Q', ext)[0]

        mask_key = b''
        if masked:
            while len(mask_key) < 4:
                chunk = conn.recv(4 - len(mask_key))
                if not chunk:
                    return None, None
                mask_key += chunk

        payload = b''
        while len(payload) < length:
            chunk = conn.recv(min(4096, length - len(payload)))
            if not chunk:
                return None, None
            payload += chunk

        if masked:
            payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

        return opcode, payload
    except Exception:
        return None, None


def _ws_send_frame(conn, data, binary=False):
    """Send one WebSocket frame (unmasked, server→client)."""
    try:
        opcode = 0x02 if binary else 0x01   # 2=binary, 1=text
        length = len(data)
        header = bytes([0x80 | opcode])
        if length < 126:
            header += bytes([length])
        elif length < 65536:
            header += bytes([126]) + struct.pack('!H', length)
        else:
            header += bytes([127]) + struct.pack('!Q', length)
        conn.sendall(header + (data if isinstance(data, bytes) else data.encode()))
        return True
    except Exception:
        return False


def _intercom_broadcast(sender_conn, data, binary):
    """Relay data to every connected station except the sender."""
    with _intercom_lock:
        dead = []
        for conn, station in list(_intercom_clients.items()):
            if conn is sender_conn:
                continue
            ok = _ws_send_frame(conn, data, binary=binary)
            if not ok:
                dead.append(conn)
        for d in dead:
            _intercom_clients.pop(d, None)


class _IntercomHandler(socketserver.BaseRequestHandler):
    """Handles one WebSocket intercom connection."""

    def handle(self):
        conn = self.request
        conn.settimeout(60)
        # Read HTTP upgrade request
        buf = b''
        try:
            while b'\r\n\r\n' not in buf:
                chunk = conn.recv(1024)
                if not chunk:
                    return
                buf += chunk
        except Exception:
            return

        # Parse station from query string
        station = 'unknown'
        try:
            first_line = buf.decode('utf-8', errors='ignore').split('\r\n')[0]
            if '?' in first_line:
                qs = first_line.split('?', 1)[1].split(' ')[0]
                for part in qs.split('&'):
                    if part.startswith('station='):
                        station = part.split('=', 1)[1]
        except Exception:
            pass

        # WebSocket handshake
        try:
            _ws_handshake(conn, buf)
        except Exception:
            return

        with _intercom_lock:
            _intercom_clients[conn] = station

        try:
            conn.settimeout(300)
            while True:
                opcode, payload = _ws_recv_frame(conn)
                if opcode is None:
                    break
                if opcode == 0x08:  # Close frame
                    break
                if opcode in (0x01, 0x02):  # Text or Binary
                    binary = (opcode == 0x02)
                    _intercom_broadcast(conn, payload, binary)
                # Ping/pong ignored — clients handle their own keepalive
        finally:
            with _intercom_lock:
                _intercom_clients.pop(conn, None)
            try:
                conn.close()
            except Exception:
                pass


class _IntercomServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _start_intercom_server(port=3001):
    """Start the intercom WebSocket server in a background daemon thread."""
    server = _IntercomServer(('0.0.0.0', port), _IntercomHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


# -------------------------------------------------------------
# AUTH & ROLE-BASED ACCESS CONTROL (RBAC) - MULTI-MONITOR ISOLATION
# -------------------------------------------------------------

def verify_pin_role(role, pin):
    if not role or not pin:
        return False
    conn = db.get_db()
    user = conn.execute(
        "SELECT id FROM users WHERE role = ? AND pin_hash = ? AND (is_active = 1 OR is_active IS NULL)",
        (str(role).lower(), db.hash_pin(pin))
    ).fetchone()
    conn.close()
    return user is not None

def get_request_role():
    # 1. Check isolated station headers (per-window sessionStorage)
    h_role = request.headers.get('X-Station-Role')
    h_pin = request.headers.get('X-Station-Pin')
    if h_role and h_pin and verify_pin_role(h_role, h_pin):
        return h_role.lower()

    # 2. Check URL parameter ?pin=... for direct multi-monitor window launch
    q_pin = request.args.get('pin')
    if q_pin:
        conn = db.get_db()
        user = conn.execute("SELECT * FROM users WHERE pin_hash = ?", (db.hash_pin(q_pin),)).fetchone()
        conn.close()
        if user:
            return user['role']

    # 3. Fallback to Flask session cookie
    return session.get('user_role')

def login_required(allowed_roles=None):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            user_role = get_request_role()
            if not user_role:
                if request.path.startswith('/api/'):
                    return jsonify({'success': False, 'error': 'Authentication required', 'auth_required': True}), 401
                return redirect(url_for('login_page', next=request.path))

            if allowed_roles and user_role not in allowed_roles:
                if request.path.startswith('/api/'):
                    return jsonify({'success': False, 'error': f'Access denied for role: {user_role}'}), 403
                if user_role == 'owner':
                    return redirect('/owner')
                elif user_role == 'kitchen':
                    return redirect('/kitchen')
                elif user_role in ('service', 'captain'):
                    return redirect('/captain')
                elif user_role == 'manager':
                    return redirect('/pos')
                return redirect('/')

            return f(*args, **kwargs)
        return decorated_function
    return decorator


@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    role = (data.get('role') or '').strip().lower()
    pin = (data.get('pin') or '').strip()
    user_id = data.get('user_id')

    if not role or not pin:
        return jsonify({'success': False, 'error': 'Role and PIN are required'}), 400

    conn = db.get_db()
    pin_hash = db.hash_pin(pin)
    user = None

    if role == 'captain':
        # If specific captain user_id is provided, match that captain
        if user_id:
            user = conn.execute(
                "SELECT * FROM users WHERE id = ? AND role = 'captain' AND is_active = 1",
                (user_id,)
            ).fetchone()
        else:
            # Match any active captain with this specific personal PIN
            user = conn.execute(
                "SELECT * FROM users WHERE role = 'captain' AND pin_hash = ? AND is_active = 1",
                (pin_hash,)
            ).fetchone()
            if not user:
                # If only 1 captain exists in DB, check against that captain
                captains = conn.execute("SELECT * FROM users WHERE role = 'captain' AND is_active = 1").fetchall()
                if len(captains) == 1 and captains[0]['pin_hash'] == pin_hash:
                    user = captains[0]
    else:
        user = conn.execute(
            "SELECT * FROM users WHERE role = ? AND (is_active = 1 OR is_active IS NULL)",
            (role,)
        ).fetchone()

    conn.close()

    if not user:
        if role == 'captain':
            return jsonify({'success': False, 'error': 'Incorrect PIN or captain not found'}), 401
        return jsonify({'success': False, 'error': 'Invalid role'}), 400

    if user['pin_hash'] != pin_hash:
        return jsonify({'success': False, 'error': 'Incorrect PIN'}), 401

    session['user_id'] = user['id']
    session['user_role'] = user['role']
    session['user_name'] = user['display_name']

    redirects = {
        'owner': '/owner',
        'manager': '/pos',
        'kitchen': '/kitchen',
        'service': '/service',
        'captain': '/captain'
    }
    return jsonify({
        'success': True,
        'role': user['role'],
        'display_name': user['display_name'],
        'redirect': redirects.get(user['role'], '/')
    })


@app.route('/api/auth/logout', methods=['POST', 'GET'])
def api_logout():
    session.clear()
    if request.path.startswith('/api/'):
        return jsonify({'success': True, 'redirect': '/login'})
    return redirect('/login')


@app.route('/api/auth/me', methods=['GET'])
def api_me():
    if not session.get('user_role'):
        return jsonify({'authenticated': False}), 200
    return jsonify({
        'authenticated': True,
        'user_id': session.get('user_id'),
        'role': session.get('user_role'),
        'display_name': session.get('user_name')
    })


@app.route('/api/auth/change-pin', methods=['POST'])
@login_required(allowed_roles=['manager'])
def api_change_pin():
    data = request.get_json() or {}
    target_role = (data.get('role') or '').strip().lower()
    new_pin = (data.get('new_pin') or '').strip()

    if not target_role or not new_pin or len(new_pin) < 4:
        return jsonify({'success': False, 'error': 'Role and PIN (min 4 digits) required'}), 400

    conn = db.get_db()
    with conn:
        conn.execute(
            "UPDATE users SET pin_hash = ? WHERE role = ?",
            (db.hash_pin(new_pin), target_role)
        )
    conn.close()
    return jsonify({'success': True, 'message': f'PIN updated for {target_role}'})


# -------------------------------------------------------------
# CAPTAINS & WAITER STAFF MANAGEMENT APIS
# -------------------------------------------------------------

@app.route('/api/captains', methods=['GET'])
def get_captains_endpoint():
    return jsonify({'success': True, 'captains': db.get_captains()})


@app.route('/api/captains', methods=['POST'])
@login_required(allowed_roles=['manager', 'owner'])
def create_captain_endpoint():
    data = request.get_json(silent=True) or {}
    display_name = (data.get('display_name') or '').strip()
    pin = (data.get('pin') or '').strip()

    if not display_name:
        return jsonify({'success': False, 'message': 'Captain name is required'}), 400
    if len(pin) < 4:
        return jsonify({'success': False, 'message': 'PIN must be at least 4 digits'}), 400

    try:
        new_id = db.create_captain(display_name, pin)
        event_bus.publish('CAPTAINS_UPDATED', {'id': new_id, 'name': display_name, 'action': 'created'})
        return jsonify({
            'success': True,
            'message': f"Captain '{display_name}' added successfully.",
            'captain': {'id': new_id, 'display_name': display_name, 'role': 'captain'}
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


@app.route('/api/captains/<int:user_id>', methods=['PUT'])
@login_required(allowed_roles=['manager', 'owner'])
def update_captain_endpoint(user_id):
    data = request.get_json(silent=True) or {}
    display_name = (data.get('display_name') or '').strip()
    pin = (data.get('pin') or '').strip() or None

    if not display_name:
        return jsonify({'success': False, 'message': 'Captain name is required'}), 400
    if pin and len(pin) < 4:
        return jsonify({'success': False, 'message': 'New PIN must be at least 4 digits'}), 400

    try:
        db.update_captain(user_id, display_name, pin)
        event_bus.publish('CAPTAINS_UPDATED', {'id': user_id, 'name': display_name, 'action': 'updated'})
        return jsonify({
            'success': True,
            'message': f"Captain '{display_name}' updated successfully."
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


@app.route('/api/captains/<int:user_id>', methods=['DELETE'])
@login_required(allowed_roles=['manager', 'owner'])
def delete_captain_endpoint(user_id):
    captains = db.get_captains()
    if len(captains) <= 1:
        return jsonify({'success': False, 'message': 'Cannot delete the only remaining captain.'}), 400

    try:
        db.delete_captain(user_id)
        event_bus.publish('CAPTAINS_UPDATED', {'id': user_id, 'action': 'deleted'})
        return jsonify({
            'success': True,
            'message': 'Captain removed successfully.'
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


# -------------------------------------------------------------
# STATIC PAGE ROUTES
# -------------------------------------------------------------

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(PUBLIC_DIR, 'favicon.ico', mimetype='image/vnd.microsoft.icon')

@app.route('/')
def index_page():
    role = get_request_role()
    if role == 'owner':
        return redirect('/owner')
    elif role == 'kitchen':
        return redirect('/kitchen')
    elif role == 'service':
        return redirect('/service')
    elif role == 'captain':
        return redirect('/captain')
    elif role == 'manager':
        return redirect('/pos')
    return redirect('/login')

@app.route('/launch')
@login_required(allowed_roles=['manager', 'owner'])
def launch_page():
    return send_from_directory(PUBLIC_DIR, 'launch.html')

@app.route('/login')
def login_page():
    return send_from_directory(PUBLIC_DIR, 'login.html')

@app.route('/pos')
@login_required(allowed_roles=['manager'])
def pos_page():
    return send_from_directory(PUBLIC_DIR, 'pos.html')

@app.route('/kitchen')
@login_required(allowed_roles=['manager', 'kitchen'])
def kitchen_page():
    return send_from_directory(PUBLIC_DIR, 'kitchen.html')

@app.route('/service')
@login_required(allowed_roles=['manager', 'service'])
def service_page():
    return send_from_directory(PUBLIC_DIR, 'service.html')

@app.route('/captain')
@app.route('/waiter')
@login_required(allowed_roles=['manager', 'service', 'captain'])
def captain_page():
    return send_from_directory(PUBLIC_DIR, 'captain.html')

@app.route('/display')
def display_page():
    return send_from_directory(PUBLIC_DIR, 'display.html')

@app.route('/tv1')
def tv1_page():
    return send_from_directory(PUBLIC_DIR, 'display.html')

@app.route('/tv2')
def tv2_page():
    return send_from_directory(PUBLIC_DIR, 'display.html')

@app.route('/settings')
@login_required(allowed_roles=['manager', 'owner'])
def settings_page():
    return send_from_directory(PUBLIC_DIR, 'settings.html')

@app.route('/owner')
@login_required(allowed_roles=['manager', 'owner'])
def owner_page():
    return send_from_directory(PUBLIC_DIR, 'owner.html')

@app.route('/api/settings/pins', methods=['POST'])
@login_required(allowed_roles=['manager'])
def update_pins_endpoint():
    data = request.get_json() or {}
    conn = db.get_db()
    with conn:
        if data.get('pin_owner') and len(data['pin_owner']) >= 4:
            conn.execute("UPDATE users SET pin_hash = ? WHERE role = 'owner'", (db.hash_pin(data['pin_owner']),))
        if data.get('pin_manager') and len(data['pin_manager']) >= 4:
            conn.execute("UPDATE users SET pin_hash = ? WHERE role = 'manager'", (db.hash_pin(data['pin_manager']),))
        if data.get('pin_kitchen') and len(data['pin_kitchen']) >= 4:
            conn.execute("UPDATE users SET pin_hash = ? WHERE role = 'kitchen'", (db.hash_pin(data['pin_kitchen']),))
        if data.get('pin_service') and len(data['pin_service']) >= 4:
            conn.execute("UPDATE users SET pin_hash = ? WHERE role = 'service'", (db.hash_pin(data['pin_service']),))
        if data.get('pin_captain') and len(data['pin_captain']) >= 4:
            conn.execute("UPDATE users SET pin_hash = ? WHERE role = 'captain'", (db.hash_pin(data['pin_captain']),))
    conn.close()
    return jsonify({'success': True, 'message': 'Station security PINs updated successfully'})


# -------------------------------------------------------------
# SETTINGS API
# -------------------------------------------------------------

@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify({'success': True, 'settings': db.get_settings_dict()})

@app.route('/api/settings', methods=['POST'])
@login_required(allowed_roles=['manager'])
def update_settings_endpoint():
    updates = request.get_json() or {}
    db.update_settings(updates)
    event_bus.publish('SETTINGS_UPDATED', updates)
    return jsonify({'success': True, 'settings': db.get_settings_dict()})


# -------------------------------------------------------------
# MENU MANAGEMENT (CRUD + 86 Toggle)
# -------------------------------------------------------------

@app.route('/api/categories', methods=['GET'])
def get_categories():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC"
    ).fetchall()
    conn.close()
    return jsonify({'success': True, 'categories': [dict(r) for r in rows]})

@app.route('/api/categories', methods=['POST'])
@login_required(allowed_roles=['manager'])
def save_category():
    data = request.get_json() or {}
    cat_id = data.get('id')
    name = (data.get('name') or '').strip()
    icon = (data.get('icon') or '🍽️').strip()
    try:
        sort_order = int(data.get('sort_order') or 0)
    except (ValueError, TypeError):
        sort_order = 0

    if not name:
        return jsonify({'success': False, 'error': 'Category name is required'}), 400

    code = (data.get('code') or '').strip().lower()
    if not code:
        code = re.sub(r'[^a-zA-Z0-9]+', '_', name.lower()).strip('_')
    if not code:
        code = f"cat_{int(time.time())}"

    conn = db.get_db()
    with conn:
        if cat_id:
            dup = conn.execute("SELECT id FROM categories WHERE code = ? AND id != ?", (code, cat_id)).fetchone()
            if dup:
                conn.close()
                return jsonify({'success': False, 'error': f'Category code "{code}" already exists'}), 400
            conn.execute(
                "UPDATE categories SET name = ?, code = ?, icon = ?, sort_order = ? WHERE id = ?",
                (name, code, icon, sort_order, cat_id)
            )
        else:
            dup = conn.execute("SELECT id FROM categories WHERE code = ?", (code,)).fetchone()
            if dup:
                code = f"{code}_{int(time.time()) % 1000}"
            c = conn.cursor()
            c.execute(
                "INSERT INTO categories (name, code, icon, sort_order, is_active) VALUES (?, ?, ?, ?, 1)",
                (name, code, icon, sort_order)
            )
            cat_id = c.lastrowid
    conn.close()
    event_bus.publish('MENU_UPDATED', {'action': 'category_saved', 'category_id': cat_id, 'name': name})
    return jsonify({'success': True, 'category': {'id': cat_id, 'name': name, 'code': code, 'icon': icon, 'sort_order': sort_order}})

@app.route('/api/categories/<int:cat_id>', methods=['DELETE'])
@login_required(allowed_roles=['manager'])
def delete_category(cat_id):
    conn = db.get_db()
    active_dishes = conn.execute(
        "SELECT count(*) as count FROM menu_items WHERE category_id = ? AND is_deleted = 0",
        (cat_id,)
    ).fetchone()
    if active_dishes and active_dishes['count'] > 0:
        conn.close()
        return jsonify({
            'success': False,
            'error': f"Cannot delete: category has {active_dishes['count']} active dish(es). Move or delete dishes first."
        }), 400

    with conn:
        conn.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
    conn.close()
    event_bus.publish('MENU_UPDATED', {'action': 'category_deleted', 'category_id': cat_id})
    return jsonify({'success': True, 'message': 'Category deleted successfully'})

@app.route('/api/menu', methods=['GET'])
def get_menu():
    conn = db.get_db()
    cats = conn.execute(
        "SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC"
    ).fetchall()
    items = conn.execute(
        """SELECT m.*, c.name AS category_name, c.code AS category_code
           FROM menu_items m
           JOIN categories c ON m.category_id = c.id
           WHERE m.is_deleted = 0
           ORDER BY c.sort_order ASC, m.sort_order ASC, m.name ASC"""
    ).fetchall()
    conn.close()
    return jsonify({
        'success': True,
        'categories': [dict(c) for c in cats],
        'items': [dict(i) for i in items]
    })

@app.route('/api/menu/item', methods=['POST'])
@login_required(allowed_roles=['manager'])
def save_menu_item():
    data = request.get_json() or {}
    item_id = data.get('id')
    cat_id = data.get('category_id')
    name = (data.get('name') or '').strip()
    desc = (data.get('description') or '').strip()
    price = float(data.get('price') or 0)
    food_type = (data.get('food_type') or 'veg').strip()

    if not name or price <= 0 or not cat_id:
        return jsonify({'success': False, 'error': 'Name, category, and valid price are required'}), 400

    conn = db.get_db()
    with conn:
        if item_id:
            conn.execute(
                """UPDATE menu_items
                   SET category_id = ?, name = ?, description = ?, price = ?, food_type = ?
                   WHERE id = ?""",
                (cat_id, name, desc, price, food_type, item_id)
            )
        else:
            conn.execute(
                """INSERT INTO menu_items (category_id, name, description, price, food_type, is_available)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (cat_id, name, desc, price, food_type)
            )
    conn.close()
    event_bus.publish('MENU_UPDATED', {'name': name})
    return jsonify({'success': True, 'message': 'Item saved'})

@app.route('/api/menu/item/<int:item_id>', methods=['DELETE'])
@login_required(allowed_roles=['manager'])
def delete_menu_item(item_id):
    conn = db.get_db()
    with conn:
        conn.execute("UPDATE menu_items SET is_deleted = 1 WHERE id = ?", (item_id,))
    conn.close()
    event_bus.publish('MENU_UPDATED', {'deleted_id': item_id})
    return jsonify({'success': True, 'message': 'Item deleted'})

@app.route('/api/menu/toggle-availability', methods=['POST'])
@login_required(allowed_roles=['manager', 'kitchen'])
def toggle_availability():
    data = request.get_json() or {}
    item_id = data.get('itemId')
    is_available = 1 if data.get('isAvailable') else 0

    conn = db.get_db()
    with conn:
        conn.execute(
            "UPDATE menu_items SET is_available = ? WHERE id = ?",
            (is_available, item_id)
        )
    conn.close()
    event_bus.publish('MENU_UPDATED', {'item_id': item_id, 'is_available': is_available})
    return jsonify({'success': True, 'is_available': is_available})


@app.route('/api/menu/seed-samples', methods=['POST'])
@login_required(allowed_roles=['manager'])
def seed_sample_menu():
    conn = db.get_db()
    c = conn.cursor()
    c.execute("SELECT id, code FROM categories")
    cat_map = {row['code']: row['id'] for row in c.fetchall()}

    samples = [
        ('starters', 'Crispy Paneer 65', 'Crunchy marinated cottage cheese cubes with curry leaves & green chilies', 220, 'veg'),
        ('starters', 'Chilli Garlic Mushroom', 'Button mushrooms wok-tossed in pungent crushed garlic & light soy', 210, 'veg'),
        ('starters', 'Chicken 65 Special', 'Fiery deep-fried spiced chicken bites with tempered mustard & curry leaves', 260, 'non_veg'),
        ('starters', 'Crispy Corn Salt & Pepper', 'Golden fried sweet corn tossed with freshly cracked black peppercorn', 180, 'veg'),
        ('tandoor', 'Paneer Tikka Angara', 'Char-grilled cottage cheese cubes infused with smoked tandoori spices', 250, 'veg'),
        ('tandoor', 'Tandoori Chicken (Half)', 'Tender chicken marinated in yogurt & Kashmiri chili, slow roasted in clay oven', 320, 'non_veg'),
        ('tandoor', 'Murgh Malai Kebab', 'Creamy melt-in-mouth chicken chunks blended with cardamom & fresh cream', 310, 'non_veg'),
        ('biryani', 'Hyderabadi Dum Chicken Biryani', 'Aromatic long-grain basmati cooked with marinated chicken & saffron herbs', 280, 'non_veg'),
        ('biryani', 'Paneer Makhani Biryani', 'Fragrant basmati layered with rich spiced paneer tikka & caramelized onions', 240, 'veg'),
        ('biryani', 'Egg Dum Biryani', 'Golden-roasted eggs served with spiced aromatic slow-dum basmati rice', 210, 'egg'),
        ('curries', 'Butter Chicken Masala', 'Tandoori pulled chicken in silky, rich tomato cream cashew gravy', 310, 'non_veg'),
        ('curries', 'Paneer Butter Masala', 'Fresh cottage cheese simmered in buttery makhani gravy with fenugreek', 250, 'veg'),
        ('curries', 'Dal Makhani Dum Pukht', 'Overnight slow-simmered whole black lentils with churned butter & cream', 220, 'veg'),
        ('breads', 'Butter Naan', 'Clay-oven leavened flatbread brushed with farm-fresh dairy butter', 50, 'veg'),
        ('breads', 'Garlic Butter Naan', 'Fluffy clay-oven flatbread brushed with butter and roasted minced garlic', 70, 'veg'),
        ('chinese', 'Veg Hakka Noodles', 'Wok-tossed noodles with colorful julienned vegetables in savory sauce', 190, 'veg'),
        ('chinese', 'Chicken Schezwan Fried Rice', 'Spicy aromatic rice wok-tossed with chili flakes & tender chicken bites', 240, 'non_veg'),
        ('beverages', 'Fresh Lime Soda (Sweet/Salt)', 'Sparkling citrus refresher served chilled', 70, 'veg'),
        ('beverages', 'Mango Lassi Premium', 'Thick churned creamy yogurt blended with real Alphonso mango pulp', 110, 'veg'),
        ('desserts', 'Gulab Jamun with Ice Cream', 'Warm fried khoya dumplings in cardamom rose syrup with vanilla scoop', 120, 'veg'),
        ('desserts', 'Sizzling Brownie with Vanilla', 'Warm Belgian chocolate brownie on sizzling iron skillet with hot fudge', 180, 'veg'),
    ]

    with conn:
        conn.execute("DELETE FROM menu_items")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'menu_items'")
        for cat_code, name, desc, price, food_type in samples:
            cat_id = cat_map.get(cat_code)
            if cat_id:
                conn.execute(
                    """INSERT INTO menu_items (category_id, name, description, price, food_type, is_available)
                       VALUES (?, ?, ?, ?, ?, 1)""",
                    (cat_id, name, desc, price, food_type)
                )
    conn.close()
    event_bus.publish('MENU_UPDATED', {'action': 'seeded'})
    return jsonify({'success': True, 'count': len(samples), 'message': f'{len(samples)} sample dishes loaded!'})

@app.route('/api/menu/clear-all', methods=['POST'])
@login_required(allowed_roles=['manager'])
def clear_all_menu():
    conn = db.get_db()
    with conn:
        conn.execute("DELETE FROM menu_items")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'menu_items'")
    conn.close()
    event_bus.publish('MENU_UPDATED', {'action': 'cleared'})
    return jsonify({'success': True, 'message': 'All dishes cleared'})

# -------------------------------------------------------------
# TABLES & RUNNING BILLS
# -------------------------------------------------------------

@app.route('/api/tables', methods=['GET'])
def get_tables():
    conn = db.get_db()
    tables = conn.execute(
        "SELECT * FROM dining_tables WHERE is_active = 1 ORDER BY id ASC"
    ).fetchall()

    active_orders = conn.execute(
        """SELECT o.id, o.order_number, o.token_number, o.channel, o.table_name,
                  o.waiter_name, o.customer_name, o.status, o.payment_status,
                  o.grand_total, o.created_at,
                  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count,
                  (SELECT MAX(round_number) FROM order_items WHERE order_id = o.id) as current_round
           FROM orders o
           WHERE o.channel = 'dine_in'
             AND o.payment_status = 'unpaid'
             AND o.status NOT IN ('cancelled', 'completed')"""
    ).fetchall()
    conn.close()

    occ_map = {o['table_name']: dict(o) for o in active_orders if o['table_name']}

    result = []
    for t in tables:
        td = dict(t)
        active_ord = occ_map.get(td['name'])
        td['is_occupied'] = bool(active_ord)
        td['active_order'] = active_ord
        result.append(td)

    return jsonify({'success': True, 'tables': result})


@app.route('/api/tables/<string:table_name>/active-order', methods=['GET'])
def get_table_active_order(table_name):
    """Retrieve full running bill with items for a table."""
    conn = db.get_db()
    order = conn.execute(
        """SELECT * FROM orders
           WHERE channel = 'dine_in'
             AND table_name = ?
             AND payment_status = 'unpaid'
             AND status NOT IN ('cancelled', 'completed')
           ORDER BY id DESC LIMIT 1""",
        (table_name,)
    ).fetchone()

    if not order:
        conn.close()
        return jsonify({'success': True, 'has_active_order': False, 'order': None})

    order_dict = dict(order)
    items = conn.execute(
        """SELECT oi.*, c.name as category_name
           FROM order_items oi
           LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
           LEFT JOIN categories c ON mi.category_id = c.id
           WHERE oi.order_id = ?
           ORDER BY oi.round_number ASC, oi.id ASC""",
        (order_dict['id'],)
    ).fetchall()

    kot_tickets = conn.execute(
        """SELECT * FROM kot_tickets
           WHERE order_id = ?
           ORDER BY round_number ASC, id ASC""",
        (order_dict['id'],)
    ).fetchall()

    conn.close()

    order_dict['items'] = [dict(i) for i in items]
    order_dict['kot_tickets'] = [dict(k) for k in kot_tickets]

    return jsonify({
        'success': True,
        'has_active_order': True,
        'order': order_dict
    })


def recalc_order_totals(conn, order_id):
    """
    Helper to recalculate order subtotal, discounts, CGST, SGST, round off, and grand total.
    Ensures math consistency whenever items are added, edited, or removed.
    """
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        return None

    all_items = conn.execute(
        """SELECT price, quantity FROM order_items
           WHERE order_id = ? AND (status IS NULL OR status != 'cancelled')""",
        (order_id,)
    ).fetchall()

    subtotal = sum(float(r['price']) * int(r['quantity']) for r in all_items)
    disc_type = order['discount_type'] or 'percentage'
    disc_val = float(order['discount_value'] or 0)
    if disc_type == 'percentage':
        discount_amount = (subtotal * disc_val) / 100.0
    else:
        discount_amount = min(disc_val, subtotal)

    taxable = max(0.0, subtotal - discount_amount)
    cgst_rate = float(order['cgst_rate'] or 2.5)
    sgst_rate = float(order['sgst_rate'] or 2.5)
    cgst_amount = round((taxable * cgst_rate) / 100.0, 2)
    sgst_amount = round((taxable * sgst_rate) / 100.0, 2)

    total_before_round = taxable + cgst_amount + sgst_amount
    grand_total = round(total_before_round)
    round_off = round(grand_total - total_before_round, 2)

    conn.execute(
        """UPDATE orders
           SET subtotal = ?, discount_amount = ?, cgst_amount = ?,
               sgst_amount = ?, round_off = ?, grand_total = ?
           WHERE id = ?""",
        (subtotal, discount_amount, cgst_amount, sgst_amount, round_off, grand_total, order_id)
    )
    return {
        'subtotal': subtotal,
        'discount_amount': discount_amount,
        'cgst_amount': cgst_amount,
        'sgst_amount': sgst_amount,
        'round_off': round_off,
        'grand_total': grand_total
    }


@app.route('/api/tables/shift', methods=['POST'])
@login_required(allowed_roles=['manager', 'service', 'captain'])
def shift_table():
    """
    Shift active table running order and KOT tickets to a new table.
    Supports shifting to an empty table, or swapping/merging if target is occupied.
    """
    data = request.get_json() or {}
    source_table = (data.get('source_table') or '').strip().upper()
    target_table = (data.get('target_table') or '').strip().upper()
    action = (data.get('action') or 'shift').strip().lower()  # 'shift', 'swap', 'merge'
    reason = (data.get('reason') or '').strip()

    if not source_table or not target_table:
        return jsonify({'success': False, 'error': 'Source table and target table are required'}), 400

    if source_table == target_table:
        return jsonify({'success': False, 'error': 'Source and target table cannot be the same'}), 400

    conn = db.get_db()

    # Find active order on source table
    src_order = conn.execute(
        """SELECT * FROM orders
           WHERE UPPER(table_name) = ? AND channel = 'dine_in'
             AND payment_status = 'unpaid' AND status NOT IN ('cancelled', 'completed')
           ORDER BY id DESC LIMIT 1""",
        (source_table,)
    ).fetchone()

    if not src_order:
        conn.close()
        return jsonify({'success': False, 'error': f'No active unpaid order found on {source_table}'}), 404

    # Check target table
    tgt_order = conn.execute(
        """SELECT * FROM orders
           WHERE UPPER(table_name) = ? AND channel = 'dine_in'
             AND payment_status = 'unpaid' AND status NOT IN ('cancelled', 'completed')
           ORDER BY id DESC LIMIT 1""",
        (target_table,)
    ).fetchone()

    if tgt_order and action not in ('swap', 'merge'):
        conn.close()
        return jsonify({
            'success': False,
            'target_occupied': True,
            'target_order_number': tgt_order['order_number'],
            'target_grand_total': tgt_order['grand_total'],
            'error': f'Target {target_table} is already occupied (Bill #{tgt_order["order_number"]}). Choose "swap" or "merge".'
        }), 409

    with conn:
        if not tgt_order:
            # Direct shift to vacant table
            conn.execute(
                "UPDATE orders SET table_name = ? WHERE id = ?",
                (target_table, src_order['id'])
            )
            conn.execute(
                "UPDATE kot_tickets SET table_name = ? WHERE order_id = ? AND status != 'served'",
                (target_table, src_order['id'])
            )
            shift_msg = f"Table shifted successfully from {source_table} to {target_table}"
        elif action == 'swap':
            # Swap the two active table orders and their active tickets
            conn.execute(
                "UPDATE orders SET table_name = ? WHERE id = ?",
                (target_table, src_order['id'])
            )
            conn.execute(
                "UPDATE kot_tickets SET table_name = ? WHERE order_id = ? AND status != 'served'",
                (target_table, src_order['id'])
            )
            conn.execute(
                "UPDATE orders SET table_name = ? WHERE id = ?",
                (source_table, tgt_order['id'])
            )
            conn.execute(
                "UPDATE kot_tickets SET table_name = ? WHERE order_id = ? AND status != 'served'",
                (source_table, tgt_order['id'])
            )
            shift_msg = f"Swapped {source_table} and {target_table} successfully"
        elif action == 'merge':
            # Merge source order into target order
            # 1. Reassign items to target order
            conn.execute(
                "UPDATE order_items SET order_id = ? WHERE order_id = ?",
                (tgt_order['id'], src_order['id'])
            )
            # 2. Reassign tickets to target order and update table_name
            conn.execute(
                "UPDATE kot_tickets SET order_id = ?, table_name = ? WHERE order_id = ?",
                (tgt_order['id'], target_table, src_order['id'])
            )
            # 3. Recalculate target order totals
            recalc_order_totals(conn, tgt_order['id'])
            # 4. Mark source order as cancelled / merged
            conn.execute(
                """UPDATE orders
                   SET status = 'cancelled',
                       cancel_reason = ?
                   WHERE id = ?""",
                (f"Merged into {target_table} (Order #{tgt_order['order_number']})", src_order['id'])
            )
            shift_msg = f"Merged {source_table} into {target_table} successfully"

    conn.close()

    event_bus.publish('TABLE_SHIFTED', {
        'source_table': source_table,
        'target_table': target_table,
        'action': action,
        'order_id': src_order['id'],
        'reason': reason
    })

    return jsonify({
        'success': True,
        'message': shift_msg,
        'source_table': source_table,
        'target_table': target_table,
        'action': action
    })


@app.route('/api/tables', methods=['POST'])
@login_required(allowed_roles=['manager'])
def add_table():
    """Add a new dining table."""
    data = request.get_json() or {}
    name = (data.get('name') or '').strip().upper()
    section = (data.get('section') or 'AC Hall').strip()
    try:
        capacity = int(data.get('capacity') or 4)
    except (ValueError, TypeError):
        capacity = 4

    if not name:
        return jsonify({'success': False, 'error': 'Table name/number is required (e.g. T-15, VIP-3)'}), 400

    conn = db.get_db()
    existing = conn.execute("SELECT id FROM dining_tables WHERE UPPER(name) = ?", (name,)).fetchone()
    if existing:
        conn.close()
        return jsonify({'success': False, 'error': f'Table "{name}" already exists'}), 400

    c = conn.cursor()
    c.execute(
        "INSERT INTO dining_tables (name, section, capacity, is_active) VALUES (?, ?, ?, 1)",
        (name, section, capacity)
    )
    new_id = c.lastrowid
    conn.commit()
    conn.close()

    event_bus.publish('TABLE_UPDATED', {'table_id': new_id, 'name': name, 'action': 'create'})
    return jsonify({'success': True, 'table': {'id': new_id, 'name': name, 'section': section, 'capacity': capacity}})


@app.route('/api/tables/<int:table_id>', methods=['PUT'])
@login_required(allowed_roles=['manager'])
def edit_table(table_id):
    """Edit dining table details."""
    data = request.get_json() or {}
    name = (data.get('name') or '').strip().upper()
    section = (data.get('section') or 'AC Hall').strip()
    try:
        capacity = int(data.get('capacity') or 4)
    except (ValueError, TypeError):
        capacity = 4

    if not name:
        return jsonify({'success': False, 'error': 'Table name is required'}), 400

    conn = db.get_db()
    duplicate = conn.execute("SELECT id FROM dining_tables WHERE UPPER(name) = ? AND id != ?", (name, table_id)).fetchone()
    if duplicate:
        conn.close()
        return jsonify({'success': False, 'error': f'Another table already has name "{name}"'}), 400

    old_table = conn.execute("SELECT name FROM dining_tables WHERE id = ?", (table_id,)).fetchone()
    if not old_table:
        conn.close()
        return jsonify({'success': False, 'error': 'Table not found'}), 404

    # If renamed, update active orders table_name
    if old_table['name'] != name:
        conn.execute("UPDATE orders SET table_name = ? WHERE table_name = ? AND payment_status = 'unpaid'", (name, old_table['name']))

    conn.execute(
        "UPDATE dining_tables SET name = ?, section = ?, capacity = ? WHERE id = ?",
        (name, section, capacity, table_id)
    )
    conn.commit()
    conn.close()

    event_bus.publish('TABLE_UPDATED', {'table_id': table_id, 'name': name, 'action': 'update'})
    return jsonify({'success': True, 'table': {'id': table_id, 'name': name, 'section': section, 'capacity': capacity}})


@app.route('/api/tables/<int:table_id>', methods=['DELETE'])
@login_required(allowed_roles=['manager'])
def delete_table(table_id):
    """Delete a dining table (if not actively occupied)."""
    conn = db.get_db()
    table = conn.execute("SELECT * FROM dining_tables WHERE id = ?", (table_id,)).fetchone()
    if not table:
        conn.close()
        return jsonify({'success': False, 'error': 'Table not found'}), 404

    active_ord = conn.execute(
        """SELECT id, order_number FROM orders 
           WHERE channel = 'dine_in' 
             AND table_name = ? 
             AND payment_status = 'unpaid' 
             AND status NOT IN ('cancelled', 'completed')""",
        (table['name'],)
    ).fetchone()

    if active_ord:
        conn.close()
        return jsonify({
            'success': False, 
            'error': f"Cannot delete table {table['name']} because Bill #{active_ord['order_number']} is currently seated. Please settle or cancel it first."
        }), 400

    conn.execute("DELETE FROM dining_tables WHERE id = ?", (table_id,))
    conn.commit()
    conn.close()

    event_bus.publish('TABLE_UPDATED', {'table_id': table_id, 'name': table['name'], 'action': 'delete'})
    return jsonify({'success': True, 'message': f"Table {table['name']} deleted successfully"})



# -------------------------------------------------------------
# ORDERS & MULTI-ROUND KOT TICKETS
# -------------------------------------------------------------

def fetch_order_with_items(order_id: int):
    conn = db.get_db()
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        conn.close()
        return None
    items = conn.execute(
        "SELECT * FROM order_items WHERE order_id = ? ORDER BY round_number ASC, id ASC",
        (order_id,)
    ).fetchall()
    kot_tickets = conn.execute(
        "SELECT * FROM kot_tickets WHERE order_id = ? ORDER BY round_number ASC, id ASC",
        (order_id,)
    ).fetchall()
    conn.close()
    od = dict(order)
    od['items'] = [dict(i) for i in items]
    od['kot_tickets'] = [dict(k) for k in kot_tickets]
    return od


@app.route('/api/orders/<int:order_id>', methods=['GET'])
def get_single_order(order_id):
    od = fetch_order_with_items(order_id)
    if not od:
        return jsonify({'success': False, 'error': 'Order not found'}), 404
    return jsonify({'success': True, 'order': od})


@app.route('/api/orders', methods=['GET'])
def get_orders():
    filter_mode = request.args.get('filter', 'active')
    conn = db.get_db()

    if filter_mode == 'active':
        orders = conn.execute(
            """SELECT * FROM orders
               WHERE payment_status = 'unpaid' AND status NOT IN ('cancelled', 'completed')
               ORDER BY id DESC"""
        ).fetchall()
    elif filter_mode == 'today':
        orders = conn.execute(
            """SELECT * FROM orders
               WHERE date(created_at) = date('now', 'localtime')
               ORDER BY id DESC"""
        ).fetchall()
    else:
        orders = conn.execute("SELECT * FROM orders ORDER BY id DESC LIMIT 100").fetchall()

    order_ids = [o['id'] for o in orders]
    items_map = {}
    if order_ids:
        placeholders = ','.join('?' for _ in order_ids)
        items = conn.execute(
            f"SELECT * FROM order_items WHERE order_id IN ({placeholders}) ORDER BY id ASC",
            order_ids
        ).fetchall()
        for it in items:
            items_map.setdefault(it['order_id'], []).append(dict(it))

    conn.close()

    result = []
    for o in orders:
        od = dict(o)
        od['items'] = items_map.get(od['id'], [])
        result.append(od)

    return jsonify({'success': True, 'orders': result})


@app.route('/api/orders', methods=['POST'])
@login_required(allowed_roles=['manager', 'service', 'captain'])
def punch_order():
    """
    Punches a KOT.
    CRITICAL: If channel is 'dine_in' and the table already has an active unpaid bill,
    this adds the new items as 'Round 2 / Add-On KOT' to the SAME BILL!
    """
    data = request.get_json() or {}
    channel = data.get('channel')
    table_name = data.get('table_name')
    waiter_name = data.get('waiter_name') or session.get('user_name') or 'Captain'
    customer_name = data.get('customer_name')
    customer_phone = data.get('customer_phone')
    online_order_id = data.get('online_order_id')
    new_items = data.get('items') or []
    discount_type = data.get('discount_type') or 'percentage'
    discount_value = float(data.get('discount_value') or 0)
    notes = (data.get('notes') or '').strip()
    payment_method = data.get('payment_method') or 'cash'

    # Check if target order ID is explicitly given
    target_order_id = data.get('order_id')

    if not channel or not new_items:
        return jsonify({'success': False, 'error': 'Channel and items are required'}), 400

    conn = db.get_db()

    # Resolve items against menu_items if menu_item_id is provided
    resolved_items = []
    for it in new_items:
        m_id = it.get('menu_item_id')
        name = it.get('item_name') or it.get('name')
        price = it.get('price')
        food_type = it.get('food_type')
        if m_id and (not name or price is None or not food_type):
            m_row = conn.execute("SELECT name, price, food_type FROM menu_items WHERE id = ?", (m_id,)).fetchone()
            if m_row:
                name = name or m_row['name']
                price = price if price is not None else m_row['price']
                food_type = food_type or m_row['food_type']
        resolved_items.append({
            'menu_item_id': m_id,
            'item_name': name or 'Item',
            'price': float(price or 0),
            'quantity': int(it.get('quantity') or 1),
            'food_type': food_type or 'veg',
            'notes': it.get('notes') or ''
        })
    new_items = resolved_items

    existing_order = None

    if target_order_id:
        existing_order = conn.execute("SELECT * FROM orders WHERE id = ?", (target_order_id,)).fetchone()
    elif channel == 'dine_in' and table_name:
        existing_order = conn.execute(
            """SELECT * FROM orders
               WHERE channel = 'dine_in'
                 AND table_name = ?
                 AND payment_status = 'unpaid'
                 AND status NOT IN ('cancelled', 'completed')
               ORDER BY id DESC LIMIT 1""",
            (table_name,)
        ).fetchone()

    settings = db.get_settings_dict()
    cgst_rate = float(settings.get('cgst_rate', '2.5'))
    sgst_rate = float(settings.get('sgst_rate', '2.5'))

    with conn:
        if existing_order:
            # === ADDING ITEMS TO EXISTING RUNNING TABLE BILL (ROUND 2+) === #
            order_id = existing_order['id']
            prev_round = conn.execute(
                "SELECT COALESCE(MAX(round_number), 1) as max_r FROM kot_tickets WHERE order_id = ?",
                (order_id,)
            ).fetchone()['max_r']
            current_round = prev_round + 1

            kot_number = f"{existing_order['order_number']}-R{current_round}"

            # Create new KOT ticket specifically for this round
            cur = conn.execute(
                """INSERT INTO kot_tickets (
                    order_id, kot_number, round_number, channel, table_name, waiter_name,
                    status, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending_approval', ?, datetime('now', 'localtime'))""",
                (order_id, kot_number, current_round, channel, table_name, waiter_name or existing_order['waiter_name'], notes)
            )
            kot_ticket_id = cur.lastrowid

            # Insert new round items
            for it in new_items:
                conn.execute(
                    """INSERT INTO order_items (
                        order_id, kot_ticket_id, round_number, menu_item_id, item_name,
                        price, quantity, food_type, notes, is_ready, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_approval')""",
                    (
                        order_id, kot_ticket_id, current_round, it.get('menu_item_id'),
                        it.get('item_name') or it.get('name'), float(it.get('price') or 0),
                        int(it.get('quantity') or 1), it.get('food_type') or 'veg',
                        it.get('notes') or ''
                    )
                )

            # Re-compute total bill from ALL order items
            all_items = conn.execute(
                "SELECT price, quantity FROM order_items WHERE order_id = ?", (order_id,)
            ).fetchall()
            subtotal = sum(row['price'] * row['quantity'] for row in all_items)

            # Recalculate discount
            disc_type = discount_type or existing_order['discount_type']
            disc_val = discount_value if discount_value > 0 else existing_order['discount_value']
            if disc_type == 'percentage':
                discount_amount = (subtotal * disc_val) / 100.0
            else:
                discount_amount = min(disc_val, subtotal)

            taxable = max(0.0, subtotal - discount_amount)
            cgst_amount = round((taxable * cgst_rate) / 100.0, 2)
            sgst_amount = round((taxable * sgst_rate) / 100.0, 2)

            total_before_round = taxable + cgst_amount + sgst_amount
            grand_total = round(total_before_round)
            round_off = round(grand_total - total_before_round, 2)

            # Update master bill totals & reset status to pending_approval for new round
            conn.execute(
                """UPDATE orders
                   SET subtotal = ?, discount_type = ?, discount_value = ?,
                       discount_amount = ?, cgst_rate = ?, cgst_amount = ?,
                       sgst_rate = ?, sgst_amount = ?, round_off = ?,
                       grand_total = ?, status = 'pending_approval'
                   WHERE id = ?""",
                (
                    subtotal, disc_type, disc_val, discount_amount,
                    cgst_rate, cgst_amount, sgst_rate, sgst_amount,
                    round_off, grand_total, order_id
                )
            )

        else:
            # === INITIAL ORDER / ROUND 1 === #
            subtotal = sum(float(it.get('price') or 0) * int(it.get('quantity') or 1) for it in new_items)

            if discount_type == 'percentage':
                discount_amount = (subtotal * discount_value) / 100.0
            else:
                discount_amount = min(discount_value, subtotal)

            taxable = max(0.0, subtotal - discount_amount)
            cgst_amount = round((taxable * cgst_rate) / 100.0, 2)
            sgst_amount = round((taxable * sgst_rate) / 100.0, 2)

            total_before_round = taxable + cgst_amount + sgst_amount
            grand_total = round(total_before_round)
            round_off = round(grand_total - total_before_round, 2)

            token_number = db.get_next_token_number()
            # Ensure unique order_number against any existing records
            while True:
                order_number = f"KOT-{datetime.now().strftime('%Y%m%d')}-{token_number}"
                exists = conn.execute("SELECT 1 FROM orders WHERE order_number = ?", (order_number,)).fetchone()
                if not exists:
                    break
                token_number += 1

            cur = conn.execute(
                """INSERT INTO orders (
                    order_number, token_number, channel, table_name, waiter_name,
                    customer_name, customer_phone, online_order_id, status,
                    payment_status, payment_method, subtotal, discount_type,
                    discount_value, discount_amount, cgst_rate, cgst_amount,
                    sgst_rate, sgst_amount, round_off, grand_total, notes, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, 'pending_approval',
                    'unpaid', ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, datetime('now', 'localtime')
                )""",
                (
                    order_number, token_number, channel, table_name, waiter_name,
                    customer_name, customer_phone, online_order_id,
                    payment_method, subtotal, discount_type,
                    discount_value, discount_amount, cgst_rate, cgst_amount,
                    sgst_rate, sgst_amount, round_off, grand_total, notes
                )
            )
            order_id = cur.lastrowid

            # Create Round 1 KOT ticket
            kot_number = f"{order_number}-R1"
            k_cur = conn.execute(
                """INSERT INTO kot_tickets (
                    order_id, kot_number, round_number, channel, table_name, waiter_name,
                    status, notes, created_at
                ) VALUES (?, ?, 1, ?, ?, ?, 'pending_approval', ?, datetime('now', 'localtime'))""",
                (order_id, kot_number, channel, table_name, waiter_name, notes)
            )
            kot_ticket_id = k_cur.lastrowid

            for it in new_items:
                conn.execute(
                    """INSERT INTO order_items (
                        order_id, kot_ticket_id, round_number, menu_item_id, item_name,
                        price, quantity, food_type, notes, is_ready, status
                    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, 'pending_approval')""",
                    (
                        order_id, kot_ticket_id, it.get('menu_item_id'),
                        it.get('item_name') or it.get('name'), float(it.get('price') or 0),
                        int(it.get('quantity') or 1), it.get('food_type') or 'veg',
                        it.get('notes') or ''
                    )
                )

    conn.close()
    full_order = fetch_order_with_items(order_id)
    event_bus.publish('ORDER_CREATED', full_order)
    return jsonify({
        'success': True,
        'is_add_on': bool(existing_order),
        'order': full_order
    })


# -------------------------------------------------------------
# KITCHEN KDS TICKETS API (PER-ROUND TICKETS)
# -------------------------------------------------------------

@app.route('/api/kitchen/tickets', methods=['GET'])
def get_kitchen_tickets():
    """
    Returns active KOT tickets for the kitchen.
    Chefs see tickets grouped by KOT round so add-on items are clear!
    """
    conn = db.get_db()
    tickets = conn.execute(
        """SELECT kt.*, o.token_number, o.created_at as order_created_at
           FROM kot_tickets kt
           JOIN orders o ON kt.order_id = o.id
           WHERE kt.status IN ('pending_approval', 'preparing')
           ORDER BY CASE kt.status WHEN 'pending_approval' THEN 1 ELSE 2 END, kt.id ASC"""
    ).fetchall()

    ticket_ids = [t['id'] for t in tickets]
    items_map = {}
    if ticket_ids:
        placeholders = ','.join('?' for _ in ticket_ids)
        items = conn.execute(
            f"""SELECT oi.* FROM order_items oi
                WHERE oi.kot_ticket_id IN ({placeholders})
                ORDER BY oi.id ASC""",
            ticket_ids
        ).fetchall()
        for it in items:
            items_map.setdefault(it['kot_ticket_id'], []).append(dict(it))

    conn.close()

    result = []
    for t in tickets:
        td = dict(t)
        td['items'] = items_map.get(td['id'], [])
        result.append(td)

    return jsonify({'success': True, 'tickets': result})


@app.route('/api/kitchen/tickets/<int:ticket_id>/approve', methods=['POST'])
@login_required(allowed_roles=['manager', 'kitchen'])
def approve_kitchen_ticket(ticket_id):
    conn = db.get_db()
    ticket = conn.execute("SELECT * FROM kot_tickets WHERE id = ?", (ticket_id,)).fetchone()
    if not ticket:
        conn.close()
        return jsonify({'success': False, 'error': 'Ticket not found'}), 404

    with conn:
        conn.execute(
            """UPDATE kot_tickets
               SET status = 'preparing', approved_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (ticket_id,)
        )
        conn.execute(
            """UPDATE order_items
               SET status = 'preparing'
               WHERE kot_ticket_id = ?""",
            (ticket_id,)
        )
        # Update parent order status to preparing
        conn.execute(
            """UPDATE orders
               SET status = 'preparing', approved_at = COALESCE(approved_at, datetime('now', 'localtime'))
               WHERE id = ?""",
            (ticket['order_id'],)
        )
    conn.close()
    event_bus.publish('TICKET_APPROVED', {'ticket_id': ticket_id, 'order_id': ticket['order_id']})
    return jsonify({'success': True})


@app.route('/api/kitchen/tickets/<int:ticket_id>/ready', methods=['POST'])
@login_required(allowed_roles=['manager', 'kitchen'])
def ready_kitchen_ticket(ticket_id):
    conn = db.get_db()
    ticket = conn.execute("SELECT * FROM kot_tickets WHERE id = ?", (ticket_id,)).fetchone()
    if not ticket:
        conn.close()
        return jsonify({'success': False, 'error': 'Ticket not found'}), 404

    with conn:
        conn.execute(
            """UPDATE kot_tickets
               SET status = 'ready', ready_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (ticket_id,)
        )
        conn.execute(
            """UPDATE order_items
               SET is_ready = 1, status = 'ready'
               WHERE kot_ticket_id = ?""",
            (ticket_id,)
        )
        # Check if all tickets for this order are ready
        pending = conn.execute(
            """SELECT COUNT(*) as c FROM kot_tickets
               WHERE order_id = ? AND status IN ('pending_approval', 'preparing')""",
            (ticket['order_id'],)
        ).fetchone()['c']

        if pending == 0:
            conn.execute(
                """UPDATE orders
                   SET status = 'ready', ready_at = datetime('now', 'localtime')
                   WHERE id = ?""",
                (ticket['order_id'],)
            )
    conn.close()
    event_bus.publish('TICKET_READY', {'ticket_id': ticket_id, 'order_id': ticket['order_id']})
    return jsonify({'success': True})


@app.route('/api/kitchen/items/<int:item_id>/toggle-out', methods=['POST'])
@login_required(allowed_roles=['manager', 'kitchen'])
def toggle_kitchen_item_out(item_id):
    """
    Toggle individual dish OUT / ready in the kitchen KDS.
    Dishes take different cooking times; when all are OUT, ticket is completed.
    """
    conn = db.get_db()
    item = conn.execute("SELECT * FROM order_items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({'success': False, 'error': 'Item not found'}), 404

    current_ready = bool(item['is_ready'])
    new_ready = 0 if current_ready else 1
    new_status = 'ready' if new_ready else 'preparing'
    ticket_id = item['kot_ticket_id']

    ticket = None
    if ticket_id:
        ticket = conn.execute("SELECT * FROM kot_tickets WHERE id = ?", (ticket_id,)).fetchone()

    with conn:
        conn.execute(
            "UPDATE order_items SET is_ready = ?, status = ? WHERE id = ?",
            (new_ready, new_status, item_id)
        )
        if ticket:
            # If ticket was pending_approval, marking any item OUT starts cooking
            if ticket['status'] == 'pending_approval':
                conn.execute(
                    """UPDATE kot_tickets
                       SET status = 'preparing', approved_at = COALESCE(approved_at, datetime('now', 'localtime'))
                       WHERE id = ?""",
                    (ticket_id,)
                )
                conn.execute(
                    """UPDATE orders
                       SET status = 'preparing', approved_at = COALESCE(approved_at, datetime('now', 'localtime'))
                       WHERE id = ?""",
                    (ticket['order_id'],)
                )

        all_out = False
        total_items = 0
        ready_items = 0
        if ticket_id:
            counts = conn.execute(
                """SELECT 
                    COUNT(*) as total,
                    COUNT(CASE WHEN is_ready = 1 THEN 1 END) as ready_count
                   FROM order_items WHERE kot_ticket_id = ?""",
                (ticket_id,)
            ).fetchone()
            total_items = counts['total']
            ready_items = counts['ready_count']
            all_out = (total_items > 0 and ready_items == total_items)

    conn.close()

    event_bus.publish('ITEM_OUT_TOGGLED', {
        'item_id': item_id,
        'ticket_id': ticket_id,
        'is_ready': bool(new_ready),
        'all_out': all_out,
        'ready_items': ready_items,
        'total_items': total_items
    })

    return jsonify({
        'success': True,
        'item_id': item_id,
        'is_ready': bool(new_ready),
        'all_out': all_out,
        'ready_items': ready_items,
        'total_items': total_items,
        'ticket_id': ticket_id
    })


# -------------------------------------------------------------
# SERVICE AREA API
# -------------------------------------------------------------

@app.route('/api/service/tickets', methods=['GET'])
def get_service_tickets():
    conn = db.get_db()
    tickets = conn.execute(
        """SELECT kt.*, o.token_number, o.created_at as order_created_at
           FROM kot_tickets kt
           JOIN orders o ON kt.order_id = o.id
           WHERE kt.status IN ('preparing', 'ready')
           ORDER BY CASE kt.status WHEN 'ready' THEN 1 ELSE 2 END, kt.id ASC"""
    ).fetchall()

    ticket_ids = [t['id'] for t in tickets]
    items_map = {}
    if ticket_ids:
        placeholders = ','.join('?' for _ in ticket_ids)
        items = conn.execute(
            f"""SELECT oi.* FROM order_items oi
                WHERE oi.kot_ticket_id IN ({placeholders})
                ORDER BY oi.id ASC""",
            ticket_ids
        ).fetchall()
        for it in items:
            items_map.setdefault(it['kot_ticket_id'], []).append(dict(it))

    conn.close()

    result = []
    for t in tickets:
        td = dict(t)
        td['items'] = items_map.get(td['id'], [])
        result.append(td)

    return jsonify({'success': True, 'tickets': result})


@app.route('/api/service/tickets/<int:ticket_id>/serve', methods=['POST'])
@login_required(allowed_roles=['manager', 'service'])
def serve_service_ticket(ticket_id):
    conn = db.get_db()
    ticket = conn.execute("SELECT * FROM kot_tickets WHERE id = ?", (ticket_id,)).fetchone()
    if not ticket:
        conn.close()
        return jsonify({'success': False, 'error': 'Ticket not found'}), 404

    with conn:
        conn.execute(
            """UPDATE kot_tickets
               SET status = 'served', served_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (ticket_id,)
        )
        conn.execute(
            """UPDATE order_items
               SET status = 'served'
               WHERE kot_ticket_id = ?""",
            (ticket_id,)
        )
        # Check if all tickets for parent order are served
        unserved = conn.execute(
            """SELECT COUNT(*) as c FROM kot_tickets
               WHERE order_id = ? AND status != 'served'""",
            (ticket['order_id'],)
        ).fetchone()['c']

        if unserved == 0:
            conn.execute(
                """UPDATE orders
                   SET status = 'served', served_at = datetime('now', 'localtime')
                   WHERE id = ?""",
                (ticket['order_id'],)
            )
    conn.close()
    event_bus.publish('TICKET_SERVED', {'ticket_id': ticket_id, 'order_id': ticket['order_id']})
    return jsonify({'success': True})


# -------------------------------------------------------------
# SETTLE BILL & VACATE TABLE
# -------------------------------------------------------------

@app.route('/api/orders/<int:order_id>/settle', methods=['POST'])
@login_required(allowed_roles=['manager'])
def settle_and_vacate(order_id):
    """
    Settles final bill for an order.
    Marks order as paid and completed.
    Table is now instantly vacant for next guests!
    """
    data = request.get_json() or {}
    payment_method = data.get('payment_method') or 'cash'

    conn = db.get_db()
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        conn.close()
        return jsonify({'success': False, 'error': 'Order not found'}), 404

    with conn:
        conn.execute(
            """UPDATE orders
               SET payment_status = 'paid', payment_method = ?,
                   status = 'completed'
               WHERE id = ?""",
            (payment_method, order_id)
        )
        # Mark all pending KOT tickets as served
        conn.execute(
            "UPDATE kot_tickets SET status = 'served' WHERE order_id = ?",
            (order_id,)
        )
    conn.close()
    full_order = fetch_order_with_items(order_id)
    event_bus.publish('BILL_SETTLED', full_order)
    return jsonify({'success': True, 'order': full_order})


@app.route('/api/orders/<int:order_id>/items/<int:item_id>', methods=['PUT'])
@login_required(allowed_roles=['manager', 'service', 'captain'])
def update_order_item(order_id, item_id):
    """
    Update quantity, notes, or status of an existing order item in a running bill.
    Automatically recalculates subtotal, taxes, and grand total.
    """
    data = request.get_json() or {}
    conn = db.get_db()
    item = conn.execute(
        "SELECT * FROM order_items WHERE id = ? AND order_id = ?",
        (item_id, order_id)
    ).fetchone()

    if not item:
        conn.close()
        return jsonify({'success': False, 'error': 'Item not found in this order'}), 404

    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order or order['payment_status'] == 'paid' or order['status'] == 'cancelled':
        conn.close()
        return jsonify({'success': False, 'error': 'Cannot edit settled or cancelled order'}), 400

    new_qty = data.get('quantity')
    new_notes = data.get('notes')

    with conn:
        if new_qty is not None:
            new_qty = int(new_qty)
            if new_qty <= 0:
                conn.execute("DELETE FROM order_items WHERE id = ?", (item_id,))
            else:
                conn.execute(
                    "UPDATE order_items SET quantity = ?, notes = COALESCE(?, notes) WHERE id = ?",
                    (new_qty, new_notes, item_id)
                )
        elif new_notes is not None:
            conn.execute("UPDATE order_items SET notes = ? WHERE id = ?", (new_notes, item_id))

        totals = recalc_order_totals(conn, order_id)

    full_order = fetch_order_with_items(order_id)
    conn.close()

    event_bus.publish('ORDER_UPDATED', {'order_id': order_id, 'item_id': item_id, 'totals': totals})
    return jsonify({
        'success': True,
        'message': 'Order item updated successfully',
        'order': full_order,
        'totals': totals
    })


@app.route('/api/orders/<int:order_id>/items/<int:item_id>', methods=['DELETE'])
@login_required(allowed_roles=['manager', 'service', 'captain'])
def delete_order_item(order_id, item_id):
    """
    Void/Remove an item from an active order.
    Automatically recalculates subtotal, taxes, and grand total.
    """
    data = request.get_json(silent=True) or {}
    reason = (data.get('reason') or 'Item voided').strip()

    conn = db.get_db()
    item = conn.execute(
        "SELECT * FROM order_items WHERE id = ? AND order_id = ?",
        (item_id, order_id)
    ).fetchone()

    if not item:
        conn.close()
        return jsonify({'success': False, 'error': 'Item not found in this order'}), 404

    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order or order['payment_status'] == 'paid' or order['status'] == 'cancelled':
        conn.close()
        return jsonify({'success': False, 'error': 'Cannot edit settled or cancelled order'}), 400

    with conn:
        conn.execute("DELETE FROM order_items WHERE id = ?", (item_id,))
        totals = recalc_order_totals(conn, order_id)

    full_order = fetch_order_with_items(order_id)
    conn.close()

    event_bus.publish('ORDER_UPDATED', {'order_id': order_id, 'voided_item_id': item_id, 'reason': reason, 'totals': totals})
    return jsonify({
        'success': True,
        'message': f"Item '{item['item_name']}' removed from order",
        'order': full_order,
        'totals': totals
    })


@app.route('/api/orders/<int:order_id>/edit', methods=['POST'])
@login_required(allowed_roles=['manager', 'service', 'captain'])
def edit_full_order(order_id):
    """
    Batch edit active order details (items, discount, notes, customer/waiter name).
    """
    data = request.get_json() or {}
    conn = db.get_db()

    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order or order['payment_status'] == 'paid' or order['status'] == 'cancelled':
        conn.close()
        return jsonify({'success': False, 'error': 'Cannot edit settled or cancelled order'}), 400

    waiter_name = data.get('waiter_name')
    customer_name = data.get('customer_name')
    customer_phone = data.get('customer_phone')
    notes = data.get('notes')
    discount_type = data.get('discount_type')
    discount_value = data.get('discount_value')
    items_to_update = data.get('items') or []

    with conn:
        for it in items_to_update:
            i_id = it.get('id')
            qty = it.get('quantity')
            i_notes = it.get('notes')
            if i_id and qty is not None:
                if int(qty) <= 0:
                    conn.execute("DELETE FROM order_items WHERE id = ? AND order_id = ?", (i_id, order_id))
                else:
                    conn.execute(
                        "UPDATE order_items SET quantity = ?, notes = COALESCE(?, notes) WHERE id = ? AND order_id = ?",
                        (int(qty), i_notes, i_id, order_id)
                    )

        if waiter_name is not None:
            conn.execute("UPDATE orders SET waiter_name = ? WHERE id = ?", (waiter_name, order_id))
        if customer_name is not None:
            conn.execute("UPDATE orders SET customer_name = ? WHERE id = ?", (customer_name, order_id))
        if customer_phone is not None:
            conn.execute("UPDATE orders SET customer_phone = ? WHERE id = ?", (customer_phone, order_id))
        if notes is not None:
            conn.execute("UPDATE orders SET notes = ? WHERE id = ?", (notes, order_id))
        if discount_type is not None and discount_value is not None:
            conn.execute(
                "UPDATE orders SET discount_type = ?, discount_value = ? WHERE id = ?",
                (discount_type, float(discount_value), order_id)
            )

        totals = recalc_order_totals(conn, order_id)

    full_order = fetch_order_with_items(order_id)
    conn.close()

    event_bus.publish('ORDER_UPDATED', {'order_id': order_id, 'totals': totals})
    return jsonify({
        'success': True,
        'message': 'Order updated successfully',
        'order': full_order,
        'totals': totals
    })


@app.route('/api/orders/<int:order_id>/cancel', methods=['POST'])
@login_required(allowed_roles=['manager'])
def cancel_order(order_id):
    data = request.get_json() or {}
    reason = data.get('reason') or 'Cancelled by Manager'
    conn = db.get_db()
    with conn:
        conn.execute(
            """UPDATE orders
               SET status = 'cancelled', cancelled_at = datetime('now', 'localtime'), cancel_reason = ?
               WHERE id = ?""",
            (reason, order_id)
        )
        conn.execute(
            "UPDATE kot_tickets SET status = 'cancelled' WHERE order_id = ?",
            (order_id,)
        )
    conn.close()
    event_bus.publish('ORDER_CANCELLED', {'order_id': order_id, 'reason': reason})
    return jsonify({'success': True})


# -------------------------------------------------------------
# DISPLAY BOARD TOKENS (Burger King Style TV - Public)
# -------------------------------------------------------------

@app.route('/api/display/tokens', methods=['GET'])
def display_tokens():
    conn = db.get_db()
    # Preparing tokens: active orders in cooking or pending
    prep = conn.execute(
        """SELECT o.id, o.order_number, o.token_number, o.channel, o.table_name,
                  o.online_order_id, o.created_at, o.approved_at,
                  (SELECT MAX(round_number) FROM kot_tickets WHERE order_id = o.id) as current_round
           FROM orders o
           WHERE o.payment_status = 'unpaid'
             AND o.status IN ('pending_approval', 'preparing')
           ORDER BY o.id ASC"""
    ).fetchall()

    # Ready tokens: orders where food is ready for pickup
    ready = conn.execute(
        """SELECT o.id, o.order_number, o.token_number, o.channel, o.table_name,
                  o.online_order_id, o.ready_at
           FROM orders o
           WHERE o.payment_status = 'unpaid'
             AND o.status = 'ready'
           ORDER BY o.ready_at DESC"""
    ).fetchall()

    served = conn.execute(
        """SELECT id, token_number, channel, table_name, served_at
           FROM orders
           WHERE status IN ('served', 'completed')
           ORDER BY COALESCE(served_at, created_at) DESC LIMIT 6"""
    ).fetchall()
    conn.close()

    return jsonify({
        'success': True,
        'preparing': [dict(p) for p in prep],
        'ready': [dict(r) for r in ready],
        'recentlyServed': [dict(s) for s in served],
        'serverTime': datetime.now().isoformat()
    })


# -------------------------------------------------------------
# AUDIT STATS
# -------------------------------------------------------------

@app.route('/api/stats/today', methods=['GET'])
def stats_today():
    conn = db.get_db()
    row = conn.execute(
        """SELECT
            COUNT(*) AS total_orders,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS paid_sales,
            COALESCE(SUM(grand_total), 0) AS total_sales,
            COALESCE(SUM(cgst_amount + sgst_amount), 0) AS total_gst,
            COALESCE(SUM(discount_amount), 0) AS total_discounts,
            COUNT(CASE WHEN channel = 'dine_in' THEN 1 END) AS dine_in_count,
            COUNT(CASE WHEN channel = 'takeaway' THEN 1 END) AS takeaway_count,
            COUNT(CASE WHEN channel = 'swiggy' THEN 1 END) AS swiggy_count,
            COUNT(CASE WHEN channel = 'zomato' THEN 1 END) AS zomato_count,
            COUNT(CASE WHEN status = 'pending_approval' THEN 1 END) AS pending_approval_count,
            COUNT(CASE WHEN status = 'preparing' THEN 1 END) AS preparing_count,
            COUNT(CASE WHEN status = 'ready' THEN 1 END) AS ready_count,
            COUNT(CASE WHEN status IN ('served', 'completed') THEN 1 END) AS served_count
           FROM orders
           WHERE date(created_at) = date('now', 'localtime')
             AND status != 'cancelled'"""
    ).fetchone()
    conn.close()
    return jsonify({'success': True, 'stats': dict(row)})


@app.route('/api/reports/daily-sales', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_daily_sales():
    limit = request.args.get('limit', 30, type=int)
    conn = db.get_db()
    rows = conn.execute(
        """SELECT 
            date(created_at) AS sale_date,
            COUNT(*) AS total_bills,
            COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS paid_bills,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_bills,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS total_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN subtotal ELSE 0 END), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN (cgst_amount + sgst_amount) ELSE 0 END), 0) AS tax_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'upi' THEN grand_total ELSE 0 END), 0) AS upi_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'card' THEN grand_total ELSE 0 END), 0) AS card_sales,
            COUNT(CASE WHEN channel = 'dine_in' THEN 1 END) AS dine_in_count,
            COUNT(CASE WHEN channel = 'takeaway' THEN 1 END) AS takeaway_count,
            COUNT(CASE WHEN channel IN ('swiggy', 'zomato') THEN 1 END) AS delivery_count
           FROM orders
           GROUP BY date(created_at)
           ORDER BY sale_date DESC
           LIMIT ?""",
        (limit,)
    ).fetchall()
    conn.close()
    return jsonify({'success': True, 'days': [dict(r) for r in rows]})


@app.route('/api/reports/daily-bills', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_daily_bills():
    target_date = (request.args.get('date') or '').strip()
    if not target_date:
        target_date = datetime.now().strftime('%Y-%m-%d')

    channel = request.args.get('channel', 'all')
    status = request.args.get('status', 'all')
    search = (request.args.get('search') or '').strip().lower()

    query = "SELECT * FROM orders WHERE date(created_at) = ?"
    params = [target_date]

    if channel != 'all':
        query += " AND channel = ?"
        params.append(channel)

    if status == 'paid':
        query += " AND payment_status = 'paid'"
    elif status == 'unpaid':
        query += " AND payment_status = 'unpaid' AND status != 'cancelled'"
    elif status == 'cancelled':
        query += " AND status = 'cancelled'"

    query += " ORDER BY id DESC"

    conn = db.get_db()
    orders = conn.execute(query, params).fetchall()
    order_ids = [o['id'] for o in orders]
    items_map = {}
    if order_ids:
        placeholders = ','.join('?' for _ in order_ids)
        items = conn.execute(
            f"SELECT * FROM order_items WHERE order_id IN ({placeholders}) ORDER BY id ASC",
            order_ids
        ).fetchall()
        for it in items:
            items_map.setdefault(it['order_id'], []).append(dict(it))

    # Day summary calculation directly via SQL aggregate
    summary_row = conn.execute(
        """SELECT
            COUNT(*) AS total_bills,
            COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS paid_bills,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_bills,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS total_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN subtotal ELSE 0 END), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN (cgst_amount + sgst_amount) ELSE 0 END), 0) AS tax_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN discount_amount ELSE 0 END), 0) AS discount_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'upi' THEN grand_total ELSE 0 END), 0) AS upi_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'card' THEN grand_total ELSE 0 END), 0) AS card_sales,
            COUNT(CASE WHEN channel = 'dine_in' THEN 1 END) AS dine_in_count,
            COUNT(CASE WHEN channel = 'takeaway' THEN 1 END) AS takeaway_count,
            COUNT(CASE WHEN channel IN ('swiggy', 'zomato') THEN 1 END) AS delivery_count
           FROM orders
           WHERE date(created_at) = ?""",
        (target_date,)
    ).fetchone()

    conn.close()

    result_bills = []
    for o in orders:
        od = dict(o)
        od_items = items_map.get(od['id'], [])
        od['items'] = od_items
        od['item_count'] = sum(i.get('quantity', 1) for i in od_items)
        od['items_summary'] = ', '.join(f"{i['item_name']} (x{i['quantity']})" for i in od_items[:4])
        if len(od_items) > 4:
            od['items_summary'] += f" +{len(od_items)-4} more"

        # Apply search filter if provided
        if search:
            match = (
                search in (od.get('order_number') or '').lower() or
                search in str(od.get('token_number') or '') or
                search in (od.get('table_name') or '').lower() or
                search in (od.get('customer_name') or '').lower() or
                search in od['items_summary'].lower()
            )
            if not match:
                continue

        result_bills.append(od)

    return jsonify({
        'success': True,
        'date': target_date,
        'summary': dict(summary_row) if summary_row else {},
        'bills': result_bills
    })


# -------------------------------------------------------------
# DAILY SETTLEMENT (EOD CLOSE) & CASH HANDOVER APIS
# -------------------------------------------------------------

@app.route('/api/reports/settlement', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_daily_settlement():
    target_date = (request.args.get('date') or '').strip()
    if not target_date:
        target_date = datetime.now().strftime('%Y-%m-%d')

    conn = db.get_db()
    existing = conn.execute(
        "SELECT * FROM daily_settlements WHERE settlement_date = ?",
        (target_date,)
    ).fetchone()

    # Live summary from orders
    summary = conn.execute(
        """SELECT
            COUNT(*) AS total_orders,
            COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS paid_orders,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_orders,
            COUNT(CASE WHEN payment_status = 'unpaid' AND status != 'cancelled' THEN 1 END) AS unpaid_orders,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN subtotal ELSE 0 END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN discount_amount ELSE 0 END), 0) AS discount_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN (cgst_amount + sgst_amount) ELSE 0 END), 0) AS tax_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN round_off ELSE 0 END), 0) AS round_off,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS net_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'upi' THEN grand_total ELSE 0 END), 0) AS upi_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'card' THEN grand_total ELSE 0 END), 0) AS card_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'dine_in' THEN grand_total ELSE 0 END), 0) AS dine_in_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'takeaway' THEN grand_total ELSE 0 END), 0) AS takeaway_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel IN ('swiggy', 'zomato') THEN grand_total ELSE 0 END), 0) AS delivery_sales
           FROM orders
           WHERE date(created_at) = ?""",
        (target_date,)
    ).fetchone()

    # Total items sold in paid orders
    items_row = conn.execute(
        """SELECT COALESCE(SUM(oi.quantity), 0) AS total_items
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE date(o.created_at) = ? AND o.payment_status = 'paid'""",
        (target_date,)
    ).fetchone()
    total_items = int(items_row['total_items']) if items_row else 0

    # Order Type Wise Summary (Dine In, Take Out, Delivery)
    order_type_summary = {}
    for ch_key, ch_filter in [('dine_in', "('dine_in')"), ('takeaway', "('takeaway')"), ('delivery', "('swiggy', 'zomato')")]:
        ch_row = conn.execute(
            f"""SELECT
                COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS total_bills,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS sales_amount,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN (cgst_amount + sgst_amount) ELSE 0 END), 0) AS tax_amount,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancel_bills,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN grand_total ELSE 0 END), 0) AS cancel_amount
               FROM orders
               WHERE date(created_at) = ? AND channel IN {ch_filter}""",
            (target_date,)
        ).fetchone()
        kot_row = conn.execute(
            f"""SELECT
                COUNT(*) AS total_kots,
                COUNT(CASE WHEN k.status = 'cancelled' THEN 1 END) AS cancel_kots
               FROM kot_tickets k
               JOIN orders o ON o.id = k.order_id
               WHERE date(o.created_at) = ? AND o.channel IN {ch_filter}""",
            (target_date,)
        ).fetchone()
        t_bills = int(ch_row['total_bills'] or 0)
        t_sales = float(ch_row['sales_amount'] or 0)
        order_type_summary[ch_key] = {
            'total_kots': int(kot_row['total_kots'] or 0),
            'cancel_kots': int(kot_row['cancel_kots'] or 0),
            'total_bills': t_bills,
            'sales_amount': t_sales,
            'avg_per_bill': round(t_sales / t_bills, 2) if t_bills > 0 else 0.0,
            'tax_amount': float(ch_row['tax_amount'] or 0),
            'cancel_bills': int(ch_row['cancel_bills'] or 0),
            'cancel_amount': float(ch_row['cancel_amount'] or 0)
        }

    # Check for any active open / unpaid tables
    unpaid_orders = conn.execute(
        """SELECT id, order_number, token_number, channel, table_name, grand_total, status, created_at
           FROM orders
           WHERE date(created_at) = ? AND payment_status = 'unpaid' AND status != 'cancelled'
           ORDER BY id ASC""",
        (target_date,)
    ).fetchall()

    # Check handovers recorded for this date
    handovers = conn.execute(
        "SELECT * FROM cash_handovers WHERE handover_date = ? ORDER BY id ASC",
        (target_date,)
    ).fetchall()
    handovers_list = [dict(h) for h in handovers]

    total_opening_float = sum(float(h['opening_float'] or 0) for h in handovers_list)
    total_petty_expenses = sum(float(h['petty_expenses'] or 0) for h in handovers_list)
    total_actual_cash = sum(float(h['actual_cash'] or 0) for h in handovers_list)
    total_cash_variance = sum(float(h['variance'] or 0) for h in handovers_list)
    latest_denominations = handovers_list[-1]['denominations_json'] if handovers_list else '{}'

    system_cash = float(summary['cash_sales']) if summary else 0.0
    opening_flt = float(existing['opening_float']) if (existing and existing['opening_float']) else total_opening_float
    petty_exp = float(existing['petty_expenses']) if (existing and existing['petty_expenses']) else total_petty_expenses
    act_cash = float(existing['actual_cash']) if (existing and existing['actual_cash']) else total_actual_cash
    exp_cash = opening_flt + system_cash - petty_exp
    vr_cash = float(existing['cash_variance']) if (existing and existing['cash_variance']) else (act_cash - exp_cash if act_cash > 0 else 0.0)

    cash_reconciliation = {
        'system_cash_sales': system_cash,
        'opening_float': opening_flt,
        'petty_expenses': petty_exp,
        'expected_cash': exp_cash,
        'actual_cash': act_cash,
        'variance': vr_cash,
        'denominations_json': existing['denominations_json'] if (existing and existing['denominations_json']) else latest_denominations,
        'handovers': handovers_list
    }

    conn.close()

    return jsonify({
        'success': True,
        'date': target_date,
        'is_settled': bool(existing),
        'settlement': dict(existing) if existing else None,
        'live_summary': dict(summary) if summary else {},
        'total_items': total_items,
        'order_type_summary': order_type_summary,
        'unpaid_orders': [dict(o) for o in unpaid_orders],
        'handover_count': len(handovers_list),
        'cash_reconciliation': cash_reconciliation
    })


@app.route('/api/reports/settlement', methods=['POST'])
@login_required(allowed_roles=['manager'])
def save_daily_settlement():
    data = request.get_json() or {}
    target_date = (data.get('date') or '').strip()
    if not target_date:
        target_date = datetime.now().strftime('%Y-%m-%d')

    settled_by = (data.get('settled_by') or 'Manager').strip()
    notes = (data.get('notes') or '').strip()
    opening_float = float(data.get('opening_float') or 0.0)
    petty_expenses = float(data.get('petty_expenses') or 0.0)
    actual_cash = float(data.get('actual_cash') or 0.0)
    
    denominations_data = data.get('denominations') or data.get('denominations_json') or {}
    if isinstance(denominations_data, dict):
        denominations_json = json.dumps(denominations_data)
    else:
        denominations_json = str(denominations_data)

    conn = db.get_db()
    # Calculate final stats from orders
    s = conn.execute(
        """SELECT
            COUNT(*) AS total_orders,
            COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS paid_orders,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled_orders,
            COUNT(CASE WHEN payment_status = 'unpaid' AND status != 'cancelled' THEN 1 END) AS unpaid_orders,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN subtotal ELSE 0 END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN discount_amount ELSE 0 END), 0) AS discount_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN (cgst_amount + sgst_amount) ELSE 0 END), 0) AS tax_amount,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN round_off ELSE 0 END), 0) AS round_off,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS net_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'upi' THEN grand_total ELSE 0 END), 0) AS upi_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'card' THEN grand_total ELSE 0 END), 0) AS card_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'dine_in' THEN grand_total ELSE 0 END), 0) AS dine_in_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'takeaway' THEN grand_total ELSE 0 END), 0) AS takeaway_sales,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel IN ('swiggy', 'zomato') THEN grand_total ELSE 0 END), 0) AS delivery_sales
           FROM orders
           WHERE date(created_at) = ?""",
        (target_date,)
    ).fetchone()

    expected_cash = opening_float + float(s['cash_sales']) - petty_expenses
    cash_variance = float(data.get('cash_variance') or (actual_cash - expected_cash if actual_cash > 0 else 0.0))

    with conn:
        conn.execute(
            """INSERT OR REPLACE INTO daily_settlements (
                settlement_date, settled_at, settled_by, total_orders, paid_orders,
                cancelled_orders, unpaid_orders, gross_sales, discount_amount,
                tax_amount, round_off, net_sales, cash_sales, upi_sales, card_sales,
                dine_in_sales, takeaway_sales, delivery_sales,
                opening_float, petty_expenses, actual_cash, cash_variance, denominations_json,
                notes, status
            ) VALUES (?, datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled')""",
            (
                target_date, settled_by, s['total_orders'], s['paid_orders'],
                s['cancelled_orders'], s['unpaid_orders'], s['gross_sales'],
                s['discount_amount'], s['tax_amount'], s['round_off'], s['net_sales'],
                s['cash_sales'], s['upi_sales'], s['card_sales'], s['dine_in_sales'],
                s['takeaway_sales'], s['delivery_sales'],
                opening_float, petty_expenses, actual_cash, cash_variance, denominations_json,
                notes
            )
        )

    settlement = conn.execute(
        "SELECT * FROM daily_settlements WHERE settlement_date = ?",
        (target_date,)
    ).fetchone()
    conn.close()

    event_bus.publish('DAY_SETTLED', {'date': target_date, 'net_sales': s['net_sales']})

    # Auto-Push to Cloud on Settlement if enabled
    try:
        c_cfg = get_cloud_config()
        if c_cfg.get('cloud_auto_settle') == '1':
            threading.Thread(
                target=perform_cloud_push,
                kwargs={
                    'trigger_type': 'settlement',
                    'pushed_by': settled_by,
                    'notes': f'Auto-backup on EOD Close for {target_date}'
                },
                daemon=True
            ).start()
    except Exception as e:
        print(f"[Cloud Auto-Push Warning]: {e}")

    return jsonify({
        'success': True,
        'message': f'Daily settlement for {target_date} saved successfully.',
        'settlement': dict(settlement)
    })


@app.route('/api/reports/cash-handover', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_cash_handovers():
    target_date = (request.args.get('date') or '').strip()
    if not target_date:
        target_date = datetime.now().strftime('%Y-%m-%d')

    conn = db.get_db()
    # Calculate live system cash sales for this date
    cash_sales = conn.execute(
        """SELECT COALESCE(SUM(grand_total), 0) AS total_cash
           FROM orders
           WHERE date(created_at) = ? AND payment_status = 'paid' AND payment_method = 'cash'""",
        (target_date,)
    ).fetchone()['total_cash']

    handovers = conn.execute(
        "SELECT * FROM cash_handovers WHERE handover_date = ? ORDER BY id DESC",
        (target_date,)
    ).fetchall()

    conn.close()

    return jsonify({
        'success': True,
        'date': target_date,
        'system_cash_sales': cash_sales,
        'handovers': [dict(h) for h in handovers]
    })


@app.route('/api/reports/cash-handover', methods=['POST'])
@login_required(allowed_roles=['manager'])
def save_cash_handover():
    data = request.get_json() or {}
    handover_date = (data.get('handover_date') or '').strip()
    if not handover_date:
        handover_date = datetime.now().strftime('%Y-%m-%d')

    shift_name = (data.get('shift_name') or 'Full Day Close').strip()
    handed_by = (data.get('handed_by') or 'Cashier').strip()
    received_by = (data.get('received_by') or 'Manager').strip()

    opening_float = float(data.get('opening_float') or 0.0)
    system_cash_sales = float(data.get('system_cash_sales') or 0.0)
    petty_expenses = float(data.get('petty_expenses') or 0.0)
    actual_cash = float(data.get('actual_cash') or 0.0)

    expected_cash = round(opening_float + system_cash_sales - petty_expenses, 2)
    variance = round(actual_cash - expected_cash, 2)

    denominations = data.get('denominations') or {}
    denominations_json = json.dumps(denominations)
    notes = (data.get('notes') or '').strip()

    conn = db.get_db()
    with conn:
        cur = conn.execute(
            """INSERT INTO cash_handovers (
                handover_date, shift_name, handed_by, received_by,
                opening_float, system_cash_sales, petty_expenses,
                expected_cash, actual_cash, variance,
                denominations_json, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))""",
            (
                handover_date, shift_name, handed_by, received_by,
                opening_float, system_cash_sales, petty_expenses,
                expected_cash, actual_cash, variance,
                denominations_json, notes
            )
        )
        new_id = cur.lastrowid

    new_row = conn.execute("SELECT * FROM cash_handovers WHERE id = ?", (new_id,)).fetchone()
    conn.close()

    event_bus.publish('CASH_HANDOVER_SAVED', {
        'id': new_id,
        'date': handover_date,
        'variance': variance
    })

    return jsonify({
        'success': True,
        'message': 'Cash handover recorded successfully.',
        'handover': dict(new_row)
    })


# -------------------------------------------------------------
# CLOUD BACKUP & DISASTER RECOVERY (PUSH & PULL)
# -------------------------------------------------------------

def get_cloud_vault_dir():
    """Return the resolved absolute path to the local/synced cloud vault directory."""
    conn = db.get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'cloud_vault_path'").fetchone()
    conn.close()
    custom_path = (row['value'] if row else '').strip()
    if custom_path and os.path.isabs(custom_path):
        vault_dir = custom_path
    elif custom_path:
        vault_dir = os.path.join(os.path.dirname(db.DB_DIR), custom_path)
    else:
        vault_dir = os.path.join(db.DB_DIR, 'cloud_vault')
    os.makedirs(vault_dir, exist_ok=True)
    return vault_dir


def get_cloud_config():
    """Return cloud sync configuration dictionary."""
    conn = db.get_db()
    keys = [
        'cloud_provider', 'cloud_vault_path', 'cloud_endpoint_url',
        'cloud_api_key', 'cloud_auto_settle', 'cloud_auto_hourly',
        'cloud_last_push', 'cloud_last_pull'
    ]
    rows = conn.execute(
        f"SELECT key, value FROM settings WHERE key IN ({','.join(['?']*len(keys))})",
        keys
    ).fetchall()
    conn.close()
    config = {r['key']: r['value'] for r in rows}
    config.setdefault('cloud_provider', 'cloud_vault')
    config.setdefault('cloud_vault_path', '')
    config.setdefault('cloud_endpoint_url', '')
    config.setdefault('cloud_api_key', '')
    config.setdefault('cloud_auto_settle', '1')
    config.setdefault('cloud_auto_hourly', '0')
    config.setdefault('cloud_last_push', '')
    config.setdefault('cloud_last_pull', '')
    config['vault_dir'] = get_cloud_vault_dir()
    return config


def take_sqlite_snapshot(dest_path: str):
    """Safely snapshot the SQLite database using SQLite's native backup API (WAL-safe)."""
    os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
    src_conn = sqlite3.connect(db.DB_PATH, timeout=30.0)
    dest_conn = sqlite3.connect(dest_path)
    try:
        with dest_conn:
            src_conn.backup(dest_conn)
    finally:
        dest_conn.close()
        src_conn.close()


def calculate_file_sha256(filepath: str) -> str:
    """Calculate SHA256 hex digest of a file."""
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def inspect_db_snapshot(snapshot_path: str):
    """Inspect snapshot to extract stats: orders, sales, paid orders."""
    conn = sqlite3.connect(snapshot_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        r = conn.execute("""
            SELECT 
                COUNT(*) as total_orders,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0) as paid_orders,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) as net_sales
            FROM orders
        """).fetchone()
        return {
            'total_orders': r['total_orders'] or 0,
            'paid_orders': r['paid_orders'] or 0,
            'net_sales': float(r['net_sales'] or 0.0)
        }
    finally:
        conn.close()


def perform_cloud_push(trigger_type='manual', pushed_by='Manager', notes=''):
    """
    Take an atomic snapshot of restaurant.db, save to cloud vault,
    optionally dispatch to remote cloud endpoint, and record in cloud_backups.
    """
    config = get_cloud_config()
    vault_dir = config['vault_dir']
    now_str = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"RestroKOT_Backup_{now_str}_{trigger_type}.db"
    dest_path = os.path.join(vault_dir, filename)

    # 1. Take atomic snapshot
    take_sqlite_snapshot(dest_path)

    # 2. Inspect stats & integrity
    file_size = os.path.getsize(dest_path)
    sha256_hash = calculate_file_sha256(dest_path)
    stats = inspect_db_snapshot(dest_path)

    cloud_status = 'synced'

    # 3. If remote endpoint configured, push to remote HTTP endpoint
    endpoint_url = config.get('cloud_endpoint_url', '').strip()
    if config.get('cloud_provider') == 'webhook_http' and endpoint_url:
        try:
            with open(dest_path, 'rb') as f:
                file_bytes = f.read()
            req = urllib.request.Request(
                endpoint_url,
                data=file_bytes,
                headers={
                    'Content-Type': 'application/octet-stream',
                    'X-RestroKOT-Filename': filename,
                    'X-RestroKOT-SHA256': sha256_hash,
                    'X-RestroKOT-Trigger': trigger_type,
                    'X-RestroKOT-Pushed-By': pushed_by,
                    'X-RestroKOT-Orders': str(stats['total_orders']),
                    'X-RestroKOT-Sales': str(stats['net_sales']),
                    'Authorization': f"Bearer {config.get('cloud_api_key', '').strip()}"
                },
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status in (200, 201, 204):
                    cloud_status = 'synced'
                else:
                    cloud_status = 'remote_error'
        except Exception as e:
            print(f"[Cloud Push] Remote upload warning: {e}")
            cloud_status = 'local_vault_only'
    elif config.get('cloud_provider') == 'cloud_vault':
        cloud_status = 'synced'

    # 4. Record to cloud_backups and update last_push
    conn = db.get_db()
    with conn:
        conn.execute("""
            INSERT INTO cloud_backups (
                backup_filename, file_size, sha256, total_orders, paid_orders,
                net_sales, trigger_type, cloud_status, pushed_by, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            filename, file_size, sha256_hash, stats['total_orders'], stats['paid_orders'],
            stats['net_sales'], trigger_type, cloud_status, pushed_by, notes
        ))
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_last_push', datetime('now', 'localtime'))"
        )
    conn.close()

    event_bus.publish('CLOUD_BACKUP_PUSHED', {
        'filename': filename,
        'size': file_size,
        'trigger': trigger_type,
        'orders': stats['total_orders'],
        'sales': stats['net_sales'],
        'sha256': sha256_hash
    })

    return {
        'filename': filename,
        'file_size': file_size,
        'sha256': sha256_hash,
        'total_orders': stats['total_orders'],
        'paid_orders': stats['paid_orders'],
        'net_sales': stats['net_sales'],
        'trigger_type': trigger_type,
        'cloud_status': cloud_status,
        'created_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }


def perform_cloud_pull(target_filename=None):
    """
    Restore the database from a cloud snapshot.
    Always creates a rollback backup first: data/restaurant_prerestore_YYYYMMDD_HHMMSS.bak
    """
    config = get_cloud_config()
    vault_dir = config['vault_dir']

    # If no filename specified, pick latest
    if not target_filename:
        conn = db.get_db()
        row = conn.execute("SELECT backup_filename FROM cloud_backups ORDER BY id DESC LIMIT 1").fetchone()
        conn.close()
        if row and row['backup_filename']:
            target_filename = row['backup_filename']
        else:
            candidates = [f for f in os.listdir(vault_dir) if f.startswith('RestroKOT_Backup_') and f.endswith('.db')]
            if not candidates:
                raise ValueError("No cloud backups found in vault or database.")
            candidates.sort(reverse=True)
            target_filename = candidates[0]

    snapshot_path = os.path.join(vault_dir, target_filename)
    if not os.path.isfile(snapshot_path):
        raise FileNotFoundError(f"Backup file '{target_filename}' not found in cloud vault.")

    # 1. Integrity check on snapshot before touching current DB!
    test_conn = sqlite3.connect(snapshot_path, timeout=10.0)
    try:
        check = test_conn.execute("PRAGMA integrity_check").fetchone()
        if not check or check[0] != 'ok':
            raise ValueError(f"Snapshot integrity check failed: {check}")
    finally:
        test_conn.close()

    # 2. Safety rollback backup of current live database
    now_str = datetime.now().strftime('%Y%m%d_%H%M%S')
    rollback_filename = f"restaurant_prerestore_{now_str}.bak"
    rollback_path = os.path.join(db.DB_DIR, rollback_filename)
    
    if os.path.isfile(db.DB_PATH):
        take_sqlite_snapshot(rollback_path)

    # 3. Clean up WAL / SHM files before restoring
    for ext in ['-wal', '-shm']:
        wal_file = db.DB_PATH + ext
        if os.path.exists(wal_file):
            try:
                os.remove(wal_file)
            except Exception:
                pass

    # Copy snapshot over current database
    shutil.copy2(snapshot_path, db.DB_PATH)

    # 4. Verify & re-initialize live DB
    db.init_db()

    # 5. Record pull timestamp
    conn = db.get_db()
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_last_pull', datetime('now', 'localtime'))"
        )
    conn.close()

    event_bus.publish('DATABASE_RESTORED', {
        'restored_from': target_filename,
        'rollback_file': rollback_filename,
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    })

    return {
        'restored_from': target_filename,
        'rollback_file': rollback_filename,
        'restored_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }


# Background hourly worker loop
def _cloud_hourly_sync_loop():
    while True:
        time.sleep(3600)  # Check every hour
        try:
            c_cfg = get_cloud_config()
            if c_cfg.get('cloud_auto_hourly') == '1':
                perform_cloud_push(trigger_type='hourly', pushed_by='System Scheduler', notes='Hourly auto-sync')
        except Exception as e:
            print(f"[Cloud Hourly Sync Warning]: {e}")

_hourly_thread = threading.Thread(target=_cloud_hourly_sync_loop, daemon=True)
_hourly_thread.start()


@app.route('/api/cloud/status', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_cloud_status():
    config = get_cloud_config()
    conn = db.get_db()
    backup_count = conn.execute("SELECT COUNT(*) AS c FROM cloud_backups").fetchone()['c']
    latest_backup = conn.execute("SELECT * FROM cloud_backups ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()

    vault_dir = config['vault_dir']
    vault_files = []
    if os.path.isdir(vault_dir):
        vault_files = [f for f in os.listdir(vault_dir) if f.startswith('RestroKOT_Backup_') and f.endswith('.db')]

    return jsonify({
        'success': True,
        'config': {
            'provider': config['cloud_provider'],
            'vault_path': config['cloud_vault_path'],
            'resolved_vault_dir': vault_dir,
            'endpoint_url': config['cloud_endpoint_url'],
            'auto_settle': config['cloud_auto_settle'] == '1',
            'auto_hourly': config['cloud_auto_hourly'] == '1',
            'last_push': config['cloud_last_push'],
            'last_pull': config['cloud_last_pull']
        },
        'backup_count': backup_count,
        'vault_files_count': len(vault_files),
        'latest_backup': dict(latest_backup) if latest_backup else None
    })


@app.route('/api/cloud/config', methods=['POST'])
@login_required(allowed_roles=['manager'])
def update_cloud_config():
    data = request.get_json(silent=True) or {}
    conn = db.get_db()
    with conn:
        for k in ['cloud_provider', 'cloud_vault_path', 'cloud_endpoint_url', 'cloud_api_key']:
            if k in data:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(data[k]).strip()))
        if 'cloud_auto_settle' in data:
            val = '1' if data['cloud_auto_settle'] in (True, '1', 1) else '0'
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_auto_settle', ?)", (val,))
        if 'cloud_auto_hourly' in data:
            val = '1' if data['cloud_auto_hourly'] in (True, '1', 1) else '0'
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_auto_hourly', ?)", (val,))
    conn.close()

    return jsonify({
        'success': True,
        'message': 'Cloud configuration saved successfully.'
    })


@app.route('/api/cloud/push', methods=['POST'])
@login_required(allowed_roles=['manager', 'owner'])
def api_cloud_push():
    data = request.get_json(silent=True) or {}
    notes = (data.get('notes') or '').strip()
    trigger_type = (data.get('trigger_type') or 'manual').strip()
    pushed_by = session.get('display_name') or 'Manager'

    try:
        result = perform_cloud_push(trigger_type=trigger_type, pushed_by=pushed_by, notes=notes)
        return jsonify({
            'success': True,
            'message': f"Snapshot pushed successfully to cloud: {result['filename']}",
            'backup': result
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f"Cloud push failed: {str(e)}"}), 500


@app.route('/api/cloud/backups', methods=['GET'])
@login_required(allowed_roles=['manager', 'owner'])
def get_cloud_backups():
    conn = db.get_db()
    rows = conn.execute("SELECT * FROM cloud_backups ORDER BY id DESC").fetchall()
    conn.close()
    
    vault_dir = get_cloud_vault_dir()
    db_map = {r['backup_filename']: dict(r) for r in rows}

    # Also list any physical .db backup files in vault that may have been placed there manually
    if os.path.isdir(vault_dir):
        for f in os.listdir(vault_dir):
            if f.startswith('RestroKOT_Backup_') and f.endswith('.db') and f not in db_map:
                fpath = os.path.join(vault_dir, f)
                try:
                    fsize = os.path.getsize(fpath)
                    mtime = datetime.fromtimestamp(os.path.getmtime(fpath)).strftime('%Y-%m-%d %H:%M:%S')
                    db_map[f] = {
                        'id': None,
                        'backup_filename': f,
                        'file_size': fsize,
                        'sha256': '',
                        'total_orders': 0,
                        'paid_orders': 0,
                        'net_sales': 0.0,
                        'trigger_type': 'external',
                        'cloud_status': 'local_only',
                        'created_at': mtime,
                        'pushed_by': 'System',
                        'notes': 'Imported from cloud vault'
                    }
                except Exception:
                    pass

    backups = sorted(db_map.values(), key=lambda x: str(x.get('created_at') or ''), reverse=True)
    return jsonify({
        'success': True,
        'backups': backups,
        'count': len(backups)
    })


@app.route('/api/cloud/pull', methods=['POST'])
@login_required(allowed_roles=['manager'])
def api_cloud_pull():
    data = request.get_json(silent=True) or {}
    target_filename = (data.get('filename') or '').strip() or None

    try:
        result = perform_cloud_pull(target_filename=target_filename)
        return jsonify({
            'success': True,
            'message': f"Database successfully restored from {result['restored_from']}. Rollback backup saved as {result['rollback_file']}.",
            'result': result
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f"Cloud pull/restore failed: {str(e)}"}), 500


@app.route('/api/cloud/download/<filename>', methods=['GET'])
@login_required(allowed_roles=['manager'])
def download_cloud_backup(filename):
    safe_name = os.path.basename(filename)
    if not (safe_name.startswith('RestroKOT_Backup_') and safe_name.endswith('.db')):
        return jsonify({'success': False, 'message': 'Invalid backup filename'}), 400
    
    vault_dir = get_cloud_vault_dir()
    filepath = os.path.join(vault_dir, safe_name)
    if not os.path.isfile(filepath):
        return jsonify({'success': False, 'message': 'Backup file not found'}), 404

    return send_from_directory(vault_dir, safe_name, as_attachment=True)


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


@app.route('/api/network-info', methods=['GET'])
def get_network_info():
    """Return LAN IP and clickable URLs for accessing all portals from other devices on Wi-Fi."""
    port = int(os.environ.get('PORT', 3000))
    lan_ip = get_local_ip()
    base_url = f"http://{lan_ip}:{port}"
    return jsonify({
        'success': True,
        'lan_ip': lan_ip,
        'port': port,
        'base_url': base_url,
        'portals': [
            {'id': 'pos', 'name': 'Manager POS', 'path': '/pos', 'url': f'{base_url}/pos', 'pin': '1234', 'device': 'Main Billing PC / Laptop'},
            {'id': 'captain', 'name': 'Captain Mobile', 'path': '/captain', 'url': f'{base_url}/captain', 'pin': 'Captain PIN', 'device': 'Waiter Phones & Tablets'},
            {'id': 'kitchen', 'name': 'Kitchen KDS', 'path': '/kitchen', 'url': f'{base_url}/kitchen', 'pin': '2222', 'device': 'Kitchen Tablet / TV'},
            {'id': 'service', 'name': 'Service Expediter', 'path': '/service', 'url': f'{base_url}/service', 'pin': '3333', 'device': 'Pickup Counter PC / Tablet'},
            {'id': 'display1', 'name': 'Customer TV 1', 'path': '/display', 'url': f'{base_url}/display', 'pin': 'Public', 'device': 'Dining Hall Smart TV'},
            {'id': 'display2', 'name': 'Takeaway TV 2', 'path': '/display?station=counter', 'url': f'{base_url}/display?station=counter', 'pin': 'Public', 'device': 'Counter Queue TV'},
            {'id': 'owner', 'name': 'Owner Live Desk', 'path': '/owner', 'url': f'{base_url}/owner', 'pin': 'Owner PIN', 'device': 'Owner Phone / Laptop'},
            {'id': 'settings', 'name': 'Settings & Cloud', 'path': '/settings', 'url': f'{base_url}/settings', 'pin': '1234', 'device': 'Manager PC / Laptop'},
        ]
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    intercom_port = int(os.environ.get('INTERCOM_PORT', 3001))
    local_ip = get_local_ip()

    # Start intercom WebSocket server on port 3001 (background thread)
    _start_intercom_server(intercom_port)

    print("=" * 65)
    print("  🛎️  HOTEL & RESTAURANT KOT SYSTEM (RUNNING BILL ARCHITECTURE)")
    print("=" * 65)
    print(f"  Localhost:        http://localhost:{port}")
    print(f"  Local Network:    http://{local_ip}:{port}")
    print("-" * 65)
    print(f"  🔑 Login:         http://localhost:{port}/login")
    print(f"  🖥️  Manager POS:   http://localhost:{port}/pos       (PIN: 1234)")
    print(f"  👨‍🍳 Kitchen KDS:   http://localhost:{port}/kitchen   (PIN: 2222)")
    print(f"  🛎️  Service Area:  http://localhost:{port}/service   (PIN: 3333)")
    print(f"  📺 TV Displays:   http://localhost:{port}/display   (Public)")
    print(f"  ⚙️  Settings:      http://localhost:{port}/settings  (Manager only)")
    print(f"  🎤 Intercom WS:   ws://localhost:{intercom_port}  (auto)")
    print("=" * 65)
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
