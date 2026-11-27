"""
Knite KOT — Multi-Hotel Cloud Hub & Super Admin Portal
Version 2.0 — rms.kniteinfotech.in

Features:
- Super Admin: provision & monitor all hotel POS clients, inspect backups, global analytics.
- Hotel Owner Login: username + password (no PIN, no Shop ID needed).
- POS Backup Vault: SHA-256 verified, WAL-mode SQLite, automatic disaster recovery.
- Manager → Owner Messaging: messages from POS Manager land in the Owner's cloud dashboard.
- UPI QR Upload: owners can upload their UPI QR code for reference.
- 0% data-loss design: WAL mode, checksums, rotation keeps last 50 backups per hotel.
"""
import os
import re
import io
import secrets
import hashlib
import sqlite3
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_file, Response

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB max upload

# --- Environment Configuration ---
CLOUD_PORT      = int(os.environ.get('CLOUD_PORT', 4000))
CLOUD_API_KEY   = os.environ.get('CLOUD_API_KEY', 'knite-cloud-secret').strip()
SUPERADMIN_USER = os.environ.get('SUPERADMIN_USER', 'admin').strip()
SUPERADMIN_PASS = os.environ.get('SUPERADMIN_PASSWORD', 'KniteKOT#SuperAdmin2026').strip()
STORAGE_DIR     = os.path.abspath(
    os.environ.get('STORAGE_DIR')
    or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cloud_storage')
)
META_DB_PATH = os.path.join(STORAGE_DIR, 'knite_cloud.db')
os.makedirs(STORAGE_DIR, exist_ok=True)


# =====================================================================
# DATABASE LAYER
# =====================================================================

def get_meta_db():
    conn = sqlite3.connect(META_DB_PATH, timeout=20.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous  = FULL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_secret(secret: str) -> str:
    return hashlib.sha256((secret or '').strip().encode('utf-8')).hexdigest()


def sanitize_shop_id(shop_id: str) -> str:
    cleaned = re.sub(r'[^a-zA-Z0-9_-]', '', (shop_id or '').strip().lower())
    return cleaned or 'default'


def get_shop_dir(shop_id: str) -> str:
    d = os.path.join(STORAGE_DIR, sanitize_shop_id(shop_id))
    os.makedirs(d, exist_ok=True)
    return d


def init_meta_db():
    conn = get_meta_db()
    with conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS super_admin (
            username     TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS hotels (
            shop_id       TEXT PRIMARY KEY,
            hotel_name    TEXT NOT NULL,
            owner_name    TEXT DEFAULT '',
            owner_phone   TEXT DEFAULT '',
            owner_email   TEXT DEFAULT '',
            owner_username TEXT DEFAULT '',
            owner_password_hash TEXT DEFAULT '',
            pin_hash      TEXT DEFAULT '',
            api_key       TEXT DEFAULT '',
            upi_qr_path   TEXT DEFAULT '',
            is_active     INTEGER DEFAULT 1,
            status        TEXT DEFAULT 'active',
            notes         TEXT DEFAULT '',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_synced_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS backup_logs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            shop_id       TEXT NOT NULL,
            filename      TEXT NOT NULL,
            file_size     INTEGER DEFAULT 0,
            sha256        TEXT DEFAULT '',
            orders_count  INTEGER DEFAULT 0,
            sales_total   REAL DEFAULT 0.0,
            trigger_type  TEXT DEFAULT 'manual',
            pushed_by     TEXT DEFAULT 'POS Machine',
            received_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            role       TEXT NOT NULL,
            shop_id    TEXT DEFAULT '',
            username   TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            shop_id    TEXT NOT NULL,
            sent_by    TEXT DEFAULT 'Manager',
            message    TEXT NOT NULL,
            is_read    INTEGER DEFAULT 0,
            sent_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_backup_logs_shop ON backup_logs(shop_id, received_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_messages_shop    ON messages(shop_id, sent_at);
        """)

        # Migrate: add columns for older DB schemas
        for col_def in [
            ("ALTER TABLE hotels ADD COLUMN owner_username TEXT DEFAULT ''", 'owner_username'),
            ("ALTER TABLE hotels ADD COLUMN owner_password_hash TEXT DEFAULT ''", 'owner_password_hash'),
            ("ALTER TABLE hotels ADD COLUMN upi_qr_path TEXT DEFAULT ''", 'upi_qr_path'),
            ("ALTER TABLE hotels ADD COLUMN status TEXT DEFAULT 'active'", 'status'),
        ]:
            sql, col = col_def
            try:
                cols = [r[1] for r in conn.execute("PRAGMA table_info(hotels)").fetchall()]
                if col not in cols:
                    conn.execute(sql)
            except Exception:
                pass

        # Ensure super-admin record exists / is refreshed from env
        conn.execute("""
            INSERT INTO super_admin (username, password_hash, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
        """, (SUPERADMIN_USER, hash_secret(SUPERADMIN_PASS)))

    conn.close()


init_meta_db()


# =====================================================================
# HELPERS
# =====================================================================

def get_latest_db_path(shop_id: str):
    d = get_shop_dir(shop_id)
    if not os.path.isdir(d):
        return None, None
    files = sorted([f for f in os.listdir(d) if f.endswith('.db')], reverse=True)
    if not files:
        return None, None
    return files[0], os.path.join(d, files[0])


def verify_pos_auth(shop_id: str) -> bool:
    """Validate Bearer API key (global key OR per-hotel key)."""
    auth = (request.headers.get('Authorization') or '').strip()
    if not auth.startswith('Bearer '):
        return False
    token = auth[7:].strip()
    if CLOUD_API_KEY and token == CLOUD_API_KEY:
        return True
    conn = get_meta_db()
    try:
        h = conn.execute(
            "SELECT api_key, is_active FROM hotels WHERE shop_id = ?",
            (sanitize_shop_id(shop_id),)
        ).fetchone()
        return bool(h and h['is_active'] and h['api_key'] and h['api_key'] == token)
    finally:
        conn.close()


def get_session():
    auth = (request.headers.get('Authorization') or '').strip()
    token = ''
    if auth.startswith('Bearer '):
        token = auth[7:].strip()
    if not token:
        token = (
            request.cookies.get('knite_session')
            or request.args.get('token')
            or ''
        )
    if not token:
        return None
    conn = get_meta_db()
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')",
            (token,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def require_super_admin():
    sess = get_session()
    return sess if (sess and sess['role'] == 'super_admin') else None


def inspect_sqlite_snapshot(db_path: str, target_date: str = None):
    """Read-only inspection of a POS SQLite snapshot for sales stats and messages."""
    if not target_date:
        target_date = datetime.now().strftime('%Y-%m-%d')

    result = {
        'restaurant_name': '',
        'owner_name': '',
        'owner_pin_hash': '',
        'target_date': target_date,
        'summary': {
            'paid_orders': 0, 'total_orders': 0, 'net_sales': 0.0,
            'cash_sales': 0.0, 'upi_sales': 0.0, 'card_sales': 0.0,
            'dine_in_sales': 0.0, 'takeaway_sales': 0.0, 'delivery_sales': 0.0
        },
        'recent_orders': [],
        'messages': [],
        'settlement': None,
        'past_days': []
    }

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            # Restaurant name from settings
            r = conn.execute("SELECT value FROM settings WHERE key = 'restaurant_name'").fetchone()
            if r:
                result['restaurant_name'] = r['value']

            # Owner info
            u = conn.execute(
                "SELECT display_name, pin_hash FROM users WHERE role = 'owner' LIMIT 1"
            ).fetchone()
            if u:
                result['owner_name']     = u['display_name']
                result['owner_pin_hash'] = u['pin_hash']

            # Daily sales summary
            s = conn.execute("""
                SELECT
                    COUNT(*) AS total_orders,
                    COUNT(CASE WHEN payment_status='paid' THEN 1 END) AS paid_orders,
                    COALESCE(SUM(CASE WHEN payment_status='paid' THEN grand_total ELSE 0 END),0) AS net_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='cash'  THEN grand_total ELSE 0 END),0) AS cash_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='upi'   THEN grand_total ELSE 0 END),0) AS upi_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='card'  THEN grand_total ELSE 0 END),0) AS card_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND channel='dine_in'      THEN grand_total ELSE 0 END),0) AS dine_in_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND channel='takeaway'     THEN grand_total ELSE 0 END),0) AS takeaway_sales,
                    COALESCE(SUM(CASE WHEN payment_status='paid' AND channel IN ('swiggy','zomato') THEN grand_total ELSE 0 END),0) AS delivery_sales
                FROM orders WHERE date(created_at) = ?
            """, (target_date,)).fetchone()
            if s:
                result['summary'] = dict(s)

            # Recent 15 orders
            orders = conn.execute("""
                SELECT id, order_number, channel,
                       COALESCE(table_name,'') AS table_name,
                       grand_total, payment_status, payment_method, created_at
                FROM orders ORDER BY id DESC LIMIT 15
            """).fetchall()
            result['recent_orders'] = [dict(o) for o in orders]

            # Today's Daily Settlement (if closed/settled in POS)
            try:
                st_row = conn.execute(
                    "SELECT * FROM daily_settlements WHERE settlement_date = ? LIMIT 1",
                    (target_date,)
                ).fetchone()
                if st_row:
                    result['settlement'] = dict(st_row)
            except Exception:
                pass

            # Previous days history (all dates from settlements + orders)
            try:
                settle_map = {}
                for sr in conn.execute("SELECT * FROM daily_settlements ORDER BY settlement_date DESC LIMIT 90").fetchall():
                    settle_map[sr['settlement_date']] = dict(sr)

                order_days = conn.execute("""
                    SELECT
                        date(created_at) AS d,
                        COUNT(CASE WHEN payment_status='paid' THEN 1 END) AS paid_orders,
                        COALESCE(SUM(CASE WHEN payment_status='paid' THEN grand_total ELSE 0 END),0) AS net_sales,
                        COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='cash' THEN grand_total ELSE 0 END),0) AS cash_sales,
                        COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='upi' THEN grand_total ELSE 0 END),0) AS upi_sales,
                        COALESCE(SUM(CASE WHEN payment_status='paid' AND payment_method='card' THEN grand_total ELSE 0 END),0) AS card_sales
                    FROM orders
                    GROUP BY date(created_at)
                    ORDER BY d DESC LIMIT 90
                """).fetchall()
                day_map = {r['d']: dict(r) for r in order_days if r['d']}

                all_dates = sorted(set(list(settle_map.keys()) + list(day_map.keys())), reverse=True)
                past_days = []
                for dt in all_dates[:90]:
                    st = settle_map.get(dt)
                    od = day_map.get(dt, {})
                    past_days.append({
                        'date': dt,
                        'paid_orders': st['paid_orders'] if st else od.get('paid_orders', 0),
                        'net_sales': st['net_sales'] if st else od.get('net_sales', 0.0),
                        'cash_sales': st['cash_sales'] if st else od.get('cash_sales', 0.0),
                        'upi_sales': st['upi_sales'] if st else od.get('upi_sales', 0.0),
                        'card_sales': st['card_sales'] if st else od.get('card_sales', 0.0),
                        'settled': bool(st),
                        'settled_by': st.get('settled_by', '') if st else '',
                        'cash_variance': st.get('cash_variance', 0.0) if st else None
                    })
                result['past_days'] = past_days
            except Exception:
                pass

            # Messages from manager (POS messages table if it exists)
            try:
                msgs = conn.execute("""
                    SELECT id, message, sent_by, sent_at
                    FROM messages
                    ORDER BY sent_at DESC LIMIT 20
                """).fetchall()
                result['messages'] = [dict(m) for m in msgs]
            except Exception:
                pass

        finally:
            conn.close()
    except Exception as e:
        result['error'] = str(e)

    return result


# =====================================================================
# POS BACKUP INGESTION
# =====================================================================

@app.route('/api/backups/<shop_id>', methods=['POST'])
def receive_backup(shop_id):
    clean_shop = sanitize_shop_id(shop_id)

    if not verify_pos_auth(clean_shop):
        return jsonify({'success': False, 'message': 'Unauthorized API key'}), 401

    meta = get_meta_db()
    try:
        h = meta.execute("SELECT is_active FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
        if h and not h['is_active']:
            return jsonify({'success': False, 'message': 'Hotel suspended by Super Admin'}), 403
    finally:
        meta.close()

    raw = request.get_data()
    if not raw:
        return jsonify({'success': False, 'message': 'Empty backup payload'}), 400

    # SHA-256 integrity check
    expected = (
        request.headers.get('X-KniteKOT-SHA256')
        or request.headers.get('X-RestroKOT-SHA256') or ''
    ).strip().lower()
    actual = hashlib.sha256(raw).hexdigest().lower()
    if expected and expected != actual:
        return jsonify({'success': False, 'message': 'SHA-256 integrity mismatch'}), 400

    filename = os.path.basename(
        request.headers.get('X-KniteKOT-Filename')
        or request.headers.get('X-RestroKOT-Filename')
        or f"KniteKOT_Backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    )
    if not filename.endswith('.db'):
        filename += '.db'

    shop_dir = get_shop_dir(clean_shop)
    dest = os.path.join(shop_dir, filename)
    with open(dest, 'wb') as f:
        f.write(raw)

    # Inspect snapshot
    snap  = inspect_sqlite_snapshot(dest)
    n_ord = int(request.headers.get('X-KniteKOT-Orders') or request.headers.get('X-RestroKOT-Orders') or snap['summary'].get('total_orders') or 0)
    sales = float(request.headers.get('X-KniteKOT-Sales') or request.headers.get('X-RestroKOT-Sales') or snap['summary'].get('net_sales') or 0.0)
    trig  = request.headers.get('X-KniteKOT-Trigger') or request.headers.get('X-RestroKOT-Trigger') or 'manual'
    pushed= request.headers.get('X-KniteKOT-Pushed-By') or request.headers.get('X-RestroKOT-Pushed-By') or 'POS Machine'

    meta = get_meta_db()
    with meta:
        meta.execute("""
            INSERT INTO backup_logs (shop_id, filename, file_size, sha256, orders_count, sales_total, trigger_type, pushed_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (clean_shop, filename, len(raw), actual, n_ord, sales, trig, pushed))

        ex = meta.execute("SELECT shop_id FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
        rest_name  = snap.get('restaurant_name') or clean_shop.replace('-', ' ').title()
        owner_name = snap.get('owner_name') or 'Owner'
        pin_hash   = snap.get('owner_pin_hash') or hash_secret('9999')

        if not ex:
            meta.execute("""
                INSERT INTO hotels (shop_id, hotel_name, owner_name, pin_hash, is_active, last_synced_at)
                VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            """, (clean_shop, rest_name, owner_name, pin_hash))
        else:
            meta.execute(
                "UPDATE hotels SET last_synced_at = CURRENT_TIMESTAMP WHERE shop_id = ?",
                (clean_shop,)
            )

        # Sync messages from snapshot into cloud messages table
        for msg in snap.get('messages', []):
            exists = meta.execute(
                "SELECT id FROM messages WHERE shop_id = ? AND message = ? AND sent_by = ?",
                (clean_shop, msg['message'], msg.get('sent_by', 'Manager'))
            ).fetchone()
            if not exists:
                meta.execute("""
                    INSERT INTO messages (shop_id, sent_by, message, sent_at)
                    VALUES (?, ?, ?, ?)
                """, (clean_shop, msg.get('sent_by', 'Manager'), msg['message'],
                      msg.get('sent_at', datetime.now().strftime('%Y-%m-%d %H:%M:%S'))))

    meta.close()

    # Rotate: keep only last 50 backups per hotel
    all_dbs = sorted([f for f in os.listdir(shop_dir) if f.endswith('.db')], reverse=True)
    for old in all_dbs[50:]:
        try:
            os.remove(os.path.join(shop_dir, old))
        except OSError:
            pass

    return jsonify({
        'success': True, 'shop_id': clean_shop,
        'filename': filename, 'size': len(raw), 'sha256': actual,
        'received_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }), 201


@app.route('/api/backups/<shop_id>/latest', methods=['GET'])
def download_latest_backup(shop_id):
    clean_shop = sanitize_shop_id(shop_id)
    if not verify_pos_auth(clean_shop):
        sess = get_session()
        if not sess or (sess['role'] != 'super_admin' and sess.get('shop_id') != clean_shop):
            return jsonify({'success': False, 'message': 'Unauthorized'}), 401

    filename, path = get_latest_db_path(clean_shop)
    if not path or not os.path.isfile(path):
        return jsonify({'success': False, 'message': 'No backups found'}), 404

    resp = send_file(path, as_attachment=True, download_name=filename)
    resp.headers['X-KniteKOT-Filename'] = filename
    return resp


# =====================================================================
# MESSAGING: POS → Cloud (called by POS app.py via REST or during backup)
# =====================================================================

@app.route('/api/messages/<shop_id>', methods=['POST'])
def receive_message(shop_id):
    """POS Manager posts a message to the cloud for the owner to see."""
    clean_shop = sanitize_shop_id(shop_id)
    if not verify_pos_auth(clean_shop):
        return jsonify({'success': False, 'message': 'Unauthorized'}), 401

    data    = request.get_json(silent=True) or {}
    message = (data.get('message') or '').strip()
    sent_by = (data.get('sent_by') or 'Manager').strip()

    if not message:
        return jsonify({'success': False, 'message': 'Message cannot be empty'}), 400

    conn = get_meta_db()
    with conn:
        conn.execute(
            "INSERT INTO messages (shop_id, sent_by, message) VALUES (?, ?, ?)",
            (clean_shop, sent_by, message)
        )
    conn.close()
    return jsonify({'success': True, 'message': 'Message sent to cloud'}), 201


@app.route('/api/messages/<shop_id>', methods=['GET'])
def get_messages(shop_id):
    """Retrieve messages for a hotel (owner or super admin only)."""
    clean_shop = sanitize_shop_id(shop_id)
    sess = get_session()
    if not sess:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401
    if sess['role'] != 'super_admin' and sess.get('shop_id') != clean_shop:
        return jsonify({'success': False, 'message': 'Access denied'}), 403

    conn = get_meta_db()
    try:
        msgs = conn.execute(
            "SELECT * FROM messages WHERE shop_id = ? ORDER BY sent_at DESC LIMIT 50",
            (clean_shop,)
        ).fetchall()
        # Mark all as read
        with conn:
            conn.execute(
                "UPDATE messages SET is_read = 1 WHERE shop_id = ?", (clean_shop,)
            )
        return jsonify({'success': True, 'messages': [dict(m) for m in msgs]})
    finally:
        conn.close()


# =====================================================================
# UPI QR UPLOAD
# =====================================================================

@app.route('/api/owner/upload-upi-qr', methods=['POST'])
def upload_upi_qr():
    sess = get_session()
    if not sess:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401

    shop_id = sess.get('shop_id') if sess['role'] == 'owner' else (request.form.get('shop_id') or '')
    if not shop_id:
        return jsonify({'success': False, 'message': 'Shop ID required'}), 400
    clean_shop = sanitize_shop_id(shop_id)

    if 'qr_file' not in request.files:
        return jsonify({'success': False, 'message': 'No file uploaded (field: qr_file)'}), 400

    f = request.files['qr_file']
    if not f.filename:
        return jsonify({'success': False, 'message': 'Empty filename'}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in {'.png', '.jpg', '.jpeg', '.gif', '.webp'}:
        return jsonify({'success': False, 'message': 'Only PNG/JPG/GIF/WEBP images allowed'}), 400

    shop_dir = get_shop_dir(clean_shop)
    qr_path  = os.path.join(shop_dir, f'upi_qr{ext}')

    # Remove any old QR files
    for old_ext in ['.png', '.jpg', '.jpeg', '.gif', '.webp']:
        old = os.path.join(shop_dir, f'upi_qr{old_ext}')
        if os.path.isfile(old) and old != qr_path:
            try:
                os.remove(old)
            except OSError:
                pass

    f.save(qr_path)

    conn = get_meta_db()
    with conn:
        conn.execute(
            "UPDATE hotels SET upi_qr_path = ? WHERE shop_id = ?",
            (qr_path, clean_shop)
        )
    conn.close()

    return jsonify({'success': True, 'message': 'UPI QR uploaded successfully'})


@app.route('/api/owner/upi-qr', methods=['GET'])
def serve_upi_qr():
    sess = get_session()
    if not sess:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401

    shop_id = sess.get('shop_id') if sess['role'] == 'owner' else (request.args.get('shop_id') or '')
    clean_shop = sanitize_shop_id(shop_id)

    conn = get_meta_db()
    h = conn.execute("SELECT upi_qr_path FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
    conn.close()

    qr_path = h['upi_qr_path'] if h else ''
    if not qr_path or not os.path.isfile(qr_path):
        # Look for any upi_qr file in shop dir
        shop_dir = get_shop_dir(clean_shop)
        for ext in ['.png', '.jpg', '.jpeg', '.gif', '.webp']:
            candidate = os.path.join(shop_dir, f'upi_qr{ext}')
            if os.path.isfile(candidate):
                qr_path = candidate
                break

    if not qr_path or not os.path.isfile(qr_path):
        return jsonify({'success': False, 'message': 'No UPI QR uploaded yet'}), 404

    return send_file(qr_path)


# =====================================================================
# AUTHENTICATION
# =====================================================================

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data     = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    if not username or not password:
        return jsonify({'success': False, 'message': 'Username and password are required'}), 400

    pwd_hash = hash_secret(password)
    conn = get_meta_db()
    try:
        # 1. Check Super Admin (KniteInfotech)
        admin = conn.execute(
            "SELECT * FROM super_admin WHERE username = ? AND password_hash = ?",
            (username, pwd_hash)
        ).fetchone()
        if admin:
            token   = secrets.token_hex(24)
            expires = datetime.now() + timedelta(days=7)
            with conn:
                conn.execute(
                    "INSERT INTO sessions (token, role, username, expires_at) VALUES (?, 'super_admin', ?, ?)",
                    (token, username, expires.strftime('%Y-%m-%d %H:%M:%S'))
                )
            resp = jsonify({'success': True, 'token': token, 'role': 'super_admin', 'username': username})
            resp.set_cookie('knite_session', token, max_age=30*86400, path='/', samesite='Lax')
            return resp

        # 2. Check Hotel Owner
        hotel = conn.execute(
            "SELECT * FROM hotels WHERE owner_username = ? AND owner_password_hash = ?",
            (username, pwd_hash)
        ).fetchone()
        if not hotel:
            return jsonify({'success': False, 'message': 'Invalid username or password'}), 401
        if not hotel['is_active']:
            h_status = (hotel['status'] if 'status' in hotel.keys() else '') or 'pending'
            if h_status == 'suspended':
                return jsonify({'success': False, 'message': 'Your restaurant account has been suspended by KniteInfotech Super Admin.'}), 403
            return jsonify({'success': False, 'message': 'Your restaurant account is pending Super Admin approval. Contact KniteInfotech.'}), 403

        token      = secrets.token_hex(24)
        expires    = datetime.now() + timedelta(days=7)
        hotel_name = hotel['hotel_name']
        shop_id    = hotel['shop_id']
        with conn:
            conn.execute(
                "INSERT INTO sessions (token, role, shop_id, username, expires_at) VALUES (?, 'owner', ?, ?, ?)",
                (token, shop_id, hotel_name, expires.strftime('%Y-%m-%d %H:%M:%S'))
            )
        resp = jsonify({
            'success': True, 'token': token,
            'role': 'owner', 'shop_id': shop_id, 'hotel_name': hotel_name
        })
        resp.set_cookie('knite_session', token, max_age=30*86400, path='/', samesite='Lax')
        return resp
    finally:
        conn.close()


@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    """Public restaurant self-registration. Created with is_active=0 until Super Admin approves."""
    data       = request.get_json(silent=True) or {}
    hotel_name = (data.get('hotel_name') or '').strip()
    shop_id    = sanitize_shop_id(data.get('shop_id') or hotel_name)
    owner_name = (data.get('owner_name') or '').strip() or 'Owner'
    owner_phone= (data.get('owner_phone') or '').strip()
    owner_user = (data.get('owner_username') or '').strip()
    owner_pass = (data.get('owner_password') or '').strip()

    if not hotel_name or not shop_id:
        return jsonify({'success': False, 'message': 'Restaurant Name and Shop ID are required'}), 400
    if not owner_user or not owner_pass:
        return jsonify({'success': False, 'message': 'Username and password are required'}), 400
    if len(owner_pass) < 4:
        return jsonify({'success': False, 'message': 'Password must be at least 4 characters'}), 400

    conn = get_meta_db()
    try:
        if conn.execute("SELECT shop_id FROM hotels WHERE shop_id = ?", (shop_id,)).fetchone():
            return jsonify({'success': False, 'message': f'Shop ID "{shop_id}" is already registered'}), 409
        if conn.execute("SELECT shop_id FROM hotels WHERE owner_username = ?", (owner_user,)).fetchone():
            return jsonify({'success': False, 'message': f'Username "{owner_user}" is already taken'}), 409
        if conn.execute("SELECT username FROM super_admin WHERE username = ?", (owner_user,)).fetchone():
            return jsonify({'success': False, 'message': f'Username "{owner_user}" is reserved'}), 409

        with conn:
            conn.execute("""
                INSERT INTO hotels
                    (shop_id, hotel_name, owner_name, owner_phone, owner_username,
                     owner_password_hash, is_active, status, notes)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 'Self-registered (Pending Super Admin Approval)')
            """, (shop_id, hotel_name, owner_name, owner_phone, owner_user, hash_secret(owner_pass)))
        get_shop_dir(shop_id)
        return jsonify({
            'success': True,
            'message': f'Registration submitted for "{hotel_name}"! Please wait for KniteInfotech Super Admin approval before signing in.'
        }), 201
    finally:
        conn.close()


@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    sess = get_session()
    if not sess:
        return jsonify({'authenticated': False}), 401
    return jsonify({
        'authenticated': True,
        'role':     sess['role'],
        'username': sess.get('username') or '',
        'shop_id':  sess.get('shop_id') or ''
    })


@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    sess = get_session()
    if sess:
        conn = get_meta_db()
        with conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (sess['token'],))
        conn.close()
    resp = jsonify({'success': True})
    resp.delete_cookie('knite_session', path='/')
    return resp


# =====================================================================
# SUPER ADMIN APIs
# =====================================================================

@app.route('/api/superadmin/overview', methods=['GET'])
def superadmin_overview():
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    conn = get_meta_db()
    try:
        hotels       = conn.execute("SELECT * FROM hotels").fetchall()
        total_hotels = len(hotels)
        active_cnt   = sum(1 for h in hotels if h['is_active'])

        total_backups = 0
        total_bytes   = 0
        global_sales  = 0.0
        today_str     = datetime.now().strftime('%Y-%m-%d')

        for h in hotels:
            s_dir = get_shop_dir(h['shop_id'])
            if os.path.isdir(s_dir):
                dbs = [f for f in os.listdir(s_dir) if f.endswith('.db')]
                total_backups += len(dbs)
                for f in dbs:
                    try:
                        total_bytes += os.path.getsize(os.path.join(s_dir, f))
                    except OSError:
                        pass
            _, path = get_latest_db_path(h['shop_id'])
            if path:
                snap          = inspect_sqlite_snapshot(path, today_str)
                global_sales += snap['summary'].get('net_sales', 0.0)

        return jsonify({
            'success': True,
            'total_hotels':       total_hotels,
            'active_hotels':      active_cnt,
            'total_backups':      total_backups,
            'total_storage_mb':   round(total_bytes / (1024 * 1024), 2),
            'global_today_sales': round(global_sales, 2)
        })
    finally:
        conn.close()


@app.route('/api/superadmin/hotels', methods=['GET'])
def superadmin_list_hotels():
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    today_str = datetime.now().strftime('%Y-%m-%d')
    conn = get_meta_db()
    try:
        hotels  = conn.execute("SELECT * FROM hotels ORDER BY created_at DESC").fetchall()
        results = []
        for h in hotels:
            item = dict(h)
            item.pop('pin_hash', None)
            item.pop('owner_password_hash', None)   # never expose hashes

            s_dir = get_shop_dir(h['shop_id'])
            files = [f for f in os.listdir(s_dir) if f.endswith('.db')] if os.path.isdir(s_dir) else []
            item['backup_count'] = len(files)

            lf, lp = get_latest_db_path(h['shop_id'])
            item['latest_backup_file'] = lf
            item['latest_backup_size'] = os.path.getsize(lp) if lp and os.path.isfile(lp) else 0

            if lp:
                snap = inspect_sqlite_snapshot(lp, today_str)
                item['today_sales']      = snap['summary'].get('net_sales', 0.0)
                item['today_paid_orders']= snap['summary'].get('paid_orders', 0)
                item['unread_messages']  = len([m for m in snap.get('messages', []) if not m.get('is_read')])
            else:
                item['today_sales'] = item['today_paid_orders'] = item['unread_messages'] = 0

            # Count unread cloud messages
            unread = conn.execute(
                "SELECT COUNT(*) AS cnt FROM messages WHERE shop_id = ? AND is_read = 0",
                (h['shop_id'],)
            ).fetchone()
            item['unread_messages'] = (unread['cnt'] if unread else 0)

            item['has_upi_qr'] = bool(h['upi_qr_path'] and os.path.isfile(h['upi_qr_path']))
            results.append(item)

        return jsonify({'success': True, 'hotels': results})
    finally:
        conn.close()


@app.route('/api/superadmin/hotels', methods=['POST'])
def superadmin_create_hotel():
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    data       = request.get_json(silent=True) or {}
    shop_id    = sanitize_shop_id(data.get('shop_id') or '')
    hotel_name = (data.get('hotel_name') or '').strip()
    owner_name = (data.get('owner_name') or 'Owner').strip()
    owner_phone= (data.get('owner_phone') or '').strip()
    owner_email= (data.get('owner_email') or '').strip()
    owner_user = (data.get('owner_username') or '').strip()
    owner_pass = (data.get('owner_password') or '').strip()
    api_key    = (data.get('api_key') or '').strip()
    notes      = (data.get('notes') or '').strip()

    if not shop_id or not hotel_name:
        return jsonify({'success': False, 'message': 'Shop ID and Hotel Name are required'}), 400
    if not owner_user or not owner_pass:
        return jsonify({'success': False, 'message': 'Owner username and password are required'}), 400

    conn = get_meta_db()
    try:
        if conn.execute("SELECT shop_id FROM hotels WHERE shop_id = ?", (shop_id,)).fetchone():
            return jsonify({'success': False, 'message': f'Shop ID "{shop_id}" already exists'}), 409
        if conn.execute("SELECT shop_id FROM hotels WHERE owner_username = ?", (owner_user,)).fetchone():
            return jsonify({'success': False, 'message': f'Username "{owner_user}" is already taken'}), 409

        pwd_hash = hash_secret(owner_pass)
        with conn:
            conn.execute("""
                INSERT INTO hotels
                    (shop_id, hotel_name, owner_name, owner_phone, owner_email,
                     owner_username, owner_password_hash, api_key, is_active, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """, (shop_id, hotel_name, owner_name, owner_phone, owner_email,
                  owner_user, pwd_hash, api_key, notes))

        get_shop_dir(shop_id)

        return jsonify({
            'success': True,
            'message': f'Hotel "{hotel_name}" registered successfully!',
            'hotel': {
                'shop_id':   shop_id,
                'hotel_name':hotel_name,
                'owner_username': owner_user,
                'api_key':   api_key or CLOUD_API_KEY
            }
        }), 201
    finally:
        conn.close()


@app.route('/api/superadmin/hotels/<shop_id>', methods=['PUT'])
def superadmin_update_hotel(shop_id):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop = sanitize_shop_id(shop_id)
    data       = request.get_json(silent=True) or {}

    conn = get_meta_db()
    try:
        h = conn.execute("SELECT * FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
        if not h:
            return jsonify({'success': False, 'message': 'Hotel not found'}), 404

        hotel_name  = data.get('hotel_name',   h['hotel_name'])
        owner_name  = data.get('owner_name',   h['owner_name'])
        owner_phone = data.get('owner_phone',  h['owner_phone'])
        owner_email = data.get('owner_email',  h['owner_email'])
        owner_user  = data.get('owner_username', h['owner_username'] or '').strip()
        api_key     = data.get('api_key',      h['api_key'])
        is_active   = int(data.get('is_active', h['is_active']))
        notes       = data.get('notes',        h['notes'])

        new_pass = (data.get('owner_password') or '').strip()
        pwd_hash = hash_secret(new_pass) if new_pass else h['owner_password_hash']

        if owner_user:
            dup = conn.execute(
                "SELECT shop_id FROM hotels WHERE owner_username = ? AND shop_id != ?",
                (owner_user, clean_shop)
            ).fetchone()
            if dup:
                return jsonify({'success': False, 'message': f'Username "{owner_user}" is already used by another hotel'}), 409
            if conn.execute("SELECT username FROM super_admin WHERE username = ?", (owner_user,)).fetchone():
                return jsonify({'success': False, 'message': f'Username "{owner_user}" is reserved'}), 409

        with conn:
            conn.execute("""
                UPDATE hotels
                SET hotel_name=?, owner_name=?, owner_phone=?, owner_email=?,
                    owner_username=?, owner_password_hash=?, api_key=?, is_active=?, notes=?
                WHERE shop_id=?
            """, (hotel_name, owner_name, owner_phone, owner_email,
                  owner_user, pwd_hash, api_key, is_active, notes, clean_shop))

        return jsonify({'success': True, 'message': 'Hotel updated'})
    finally:
        conn.close()


@app.route('/api/superadmin/hotels/<shop_id>/status', methods=['POST'])
def superadmin_toggle_hotel_status(shop_id):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop = sanitize_shop_id(shop_id)
    data       = request.get_json(silent=True) or {}
    is_active  = 1 if int(data.get('is_active', 1)) else 0

    conn = get_meta_db()
    try:
        h = conn.execute("SELECT hotel_name, api_key FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
        if not h:
            return jsonify({'success': False, 'message': 'Hotel not found'}), 404
        api_key = h['api_key']
        if is_active and not api_key:
            api_key = secrets.token_urlsafe(24)
        new_status = 'active' if is_active else 'suspended'
        with conn:
            conn.execute(
                "UPDATE hotels SET is_active = ?, status = ?, api_key = ? WHERE shop_id = ?",
                (is_active, new_status, api_key, clean_shop)
            )
        status_label = 'approved & activated' if is_active else 'suspended'
        return jsonify({'success': True, 'message': f'Hotel "{h["hotel_name"]}" {status_label}!'})
    finally:
        conn.close()


@app.route('/api/cloud/approval-status/<shop_id>', methods=['GET'])
def cloud_approval_status(shop_id):
    """Allow a registered POS terminal to check if Super Admin has approved it and auto-fetch its API key."""
    clean_shop = sanitize_shop_id(shop_id)
    conn = get_meta_db()
    try:
        h = conn.execute(
            "SELECT hotel_name, owner_username, is_active, status, api_key FROM hotels WHERE shop_id = ?",
            (clean_shop,)
        ).fetchone()
        if not h:
            return jsonify({'registered': False, 'approved': False, 'suspended': False})
        h_status = h['status'] or ('active' if h['is_active'] else 'pending')
        if not h['is_active']:
            return jsonify({
                'registered': True,
                'approved': False,
                'suspended': (h_status == 'suspended'),
                'status': h_status,
                'hotel_name': h['hotel_name'],
                'owner_username': h['owner_username'] or ''
            })
        return jsonify({
            'registered': True,
            'approved': True,
            'suspended': False,
            'status': 'active',
            'hotel_name': h['hotel_name'],
            'owner_username': h['owner_username'] or '',
            'api_key': h['api_key'] or CLOUD_API_KEY
        })
    finally:
        conn.close()


@app.route('/api/superadmin/hotels/<shop_id>', methods=['DELETE'])
def superadmin_delete_hotel(shop_id):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop = sanitize_shop_id(shop_id)
    conn = get_meta_db()
    with conn:
        conn.execute("DELETE FROM hotels   WHERE shop_id = ?", (clean_shop,))
        conn.execute("DELETE FROM backup_logs WHERE shop_id = ?", (clean_shop,))
        conn.execute("DELETE FROM messages WHERE shop_id = ?", (clean_shop,))
    conn.close()
    return jsonify({'success': True, 'message': f'Hotel {clean_shop} removed from registry'})


@app.route('/api/superadmin/hotels/<shop_id>/backups', methods=['GET'])
def superadmin_hotel_backups(shop_id):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop = sanitize_shop_id(shop_id)
    s_dir = get_shop_dir(clean_shop)
    files = sorted([f for f in os.listdir(s_dir) if f.endswith('.db')], reverse=True) if os.path.isdir(s_dir) else []
    backups = []
    for f in files:
        fp = os.path.join(s_dir, f)
        try:
            stat = os.stat(fp)
            backups.append({'filename': f, 'size': stat.st_size,
                            'modified': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S')})
        except OSError:
            pass
    return jsonify({'success': True, 'shop_id': clean_shop, 'backups': backups})


@app.route('/api/superadmin/hotels/<shop_id>/backups/<filename>', methods=['GET'])
def superadmin_download_backup(shop_id, filename):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop = sanitize_shop_id(shop_id)
    clean_fn   = os.path.basename(filename)
    path = os.path.join(get_shop_dir(clean_shop), clean_fn)
    if not os.path.isfile(path):
        return jsonify({'success': False, 'message': 'File not found'}), 404
    return send_file(path, as_attachment=True, download_name=clean_fn)


@app.route('/api/superadmin/hotels/<shop_id>/analytics', methods=['GET'])
def superadmin_hotel_analytics(shop_id):
    if not require_super_admin():
        return jsonify({'success': False, 'message': 'Super Admin required'}), 403

    clean_shop  = sanitize_shop_id(shop_id)
    target_date = (request.args.get('date') or datetime.now().strftime('%Y-%m-%d')).strip()
    _, path = get_latest_db_path(clean_shop)
    if not path:
        return jsonify({'success': False, 'message': 'No snapshots synced yet'}), 404

    return jsonify({'success': True, 'shop_id': clean_shop,
                    'data': inspect_sqlite_snapshot(path, target_date)})


# =====================================================================
# OWNER APIs
# =====================================================================

@app.route('/api/owner/dashboard', methods=['GET'])
def owner_dashboard():
    sess = get_session()
    if not sess:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401

    shop_id    = (request.args.get('shop_id') if sess['role'] == 'super_admin' else sess.get('shop_id')) or ''
    clean_shop = sanitize_shop_id(shop_id)
    target_date= (request.args.get('date') or datetime.now().strftime('%Y-%m-%d')).strip()

    conn  = get_meta_db()
    hotel = None
    try:
        hotel = conn.execute("SELECT * FROM hotels WHERE shop_id = ?", (clean_shop,)).fetchone()
    finally:
        conn.close()

    hotel_name = hotel['hotel_name'] if hotel else clean_shop.replace('-', ' ').title()
    owner_name = hotel['owner_name'] if hotel else 'Owner'
    has_upi_qr = bool(hotel and hotel['upi_qr_path'] and os.path.isfile(hotel['upi_qr_path']))

    fname, db_path = get_latest_db_path(clean_shop)
    if not db_path:
        return jsonify({
            'success': True, 'shop_id': clean_shop,
            'hotel_name': hotel_name, 'owner_name': owner_name,
            'has_snapshot': False, 'summary': {}, 'recent_orders': [],
            'settlement': None, 'past_days': [], 'has_upi_qr': has_upi_qr
        })

    stat = os.stat(db_path)
    snap = inspect_sqlite_snapshot(db_path, target_date)
    return jsonify({
        'success':       True,
        'shop_id':       clean_shop,
        'hotel_name':    snap.get('restaurant_name') or hotel_name,
        'owner_name':    snap.get('owner_name') or owner_name,
        'has_snapshot':  True,
        'snapshot_file': fname,
        'snapshot_size': stat.st_size,
        'snapshot_time': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
        'date':          target_date,
        'summary':       snap.get('summary', {}),
        'recent_orders': snap.get('recent_orders', []),
        'settlement':    snap.get('settlement'),
        'past_days':     snap.get('past_days', []),
        'has_upi_qr':    has_upi_qr
    })


@app.route('/api/owner/download-backup', methods=['GET'])
def owner_download_backup():
    sess = get_session()
    if not sess:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401

    shop_id    = (request.args.get('shop_id') if sess['role'] == 'super_admin' else sess.get('shop_id')) or ''
    clean_shop = sanitize_shop_id(shop_id)
    fname, path = get_latest_db_path(clean_shop)
    if not path or not os.path.isfile(path):
        return jsonify({'success': False, 'message': 'No snapshots found'}), 404

    resp = send_file(path, as_attachment=True, download_name=fname)
    resp.headers['X-KniteKOT-Filename'] = fname
    return resp


# Legacy PIN-based summary (backward compat with old POS owner view)
@app.route('/api/cloud-owner/summary', methods=['POST'])
def legacy_cloud_owner_summary():
    data        = request.get_json(silent=True) or {}
    shop_id     = sanitize_shop_id(data.get('shop_id') or '')
    pin         = (data.get('pin') or '').strip()
    target_date = (data.get('date') or '').strip() or datetime.now().strftime('%Y-%m-%d')

    if not shop_id or not pin:
        return jsonify({'success': False, 'error': 'Shop ID and PIN required'}), 400

    fname, db_path = get_latest_db_path(shop_id)
    if not db_path:
        return jsonify({'success': False, 'error': f'No snapshot for shop "{shop_id}"'}), 404

    snap     = inspect_sqlite_snapshot(db_path, target_date)
    pin_hash = hash_secret(pin)
    if snap.get('owner_pin_hash') and snap['owner_pin_hash'] != pin_hash:
        return jsonify({'success': False, 'error': 'Invalid Owner PIN'}), 401

    return jsonify({
        'success': True, 'shop_id': shop_id,
        'restaurant_name': snap.get('restaurant_name') or shop_id.upper(),
        'owner_name':      snap.get('owner_name') or 'Owner',
        'snapshot_file':   fname, 'date': target_date,
        'summary':         snap.get('summary', {})
    })


# =====================================================================
# EMBEDDED PORTAL HTML
# =====================================================================

HTML_PORTAL = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KNITE KOT — Restaurant Management System</title>
  <style>
    :root {
      --bg: #f1f5f9; --card-bg: #ffffff; --card-border: #e2e8f0;
      --primary: #2563eb; --primary-hover: #1d4ed8;
      --text: #0f172a; --text-muted: #64748b;
      --green: #10b981; --purple: #7c3aed; --orange: #f59e0b; --danger: #dc2626;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }

    /* Header */
    header { background: #ffffff; border-bottom: 1px solid var(--card-border); padding: .85rem 1.5rem; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 1px 3px rgba(15,23,42,.05); }
    .brand { display: flex; align-items: center; gap: .75rem; text-decoration: none; color: inherit; }
    .brand-icon { background: linear-gradient(135deg,#2563eb,#7c3aed); color: #fff; width: 36px; height: 36px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; font-weight: 900; }
    .brand-title { font-weight: 800; font-size: 1.15rem; color: #0f172a; }
    .brand-badge { background: #dbeafe; color: #1d4ed8; font-size: .7rem; font-weight: 700; padding: 2px 7px; border-radius: 6px; margin-left: 6px; text-transform: uppercase; }
    .nav-user { display: flex; align-items: center; gap: 1rem; }
    .badge-role { padding: 4px 10px; border-radius: 999px; font-size: .75rem; font-weight: 700; }
    .badge-super { background: #ede9fe; color: #6d28d9; border: 1px solid #ddd6fe; }
    .badge-hotel { background: #dbeafe; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .btn-sm { padding: .4rem .8rem; border-radius: 8px; font-size: .8rem; font-weight: 600; cursor: pointer; border: none; }
    .btn-logout { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-logout:hover { background: #e2e8f0; }

    /* Main */
    main { flex: 1; padding: 1.5rem; max-width: 1340px; margin: 0 auto; width: 100%; }

    /* Auth */
    .auth-wrap { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
    .auth-box { max-width: 440px; width: 100%; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 2rem; box-shadow: 0 10px 25px -5px rgba(15,23,42,.08); }
    .auth-title { text-align: center; margin-bottom: 1.5rem; }
    .auth-title h2 { font-size: 1.3rem; font-weight: 800; color: #0f172a; }
    .auth-title p  { font-size: .82rem; color: var(--text-muted); margin-top: .3rem; }
    .tabs-header { display: flex; background: #f1f5f9; border-radius: 10px; padding: 4px; margin-bottom: 1.5rem; }
    .tab-btn { flex: 1; padding: .6rem; border: none; background: transparent; color: var(--text-muted); font-weight: 700; font-size: .85rem; border-radius: 8px; cursor: pointer; }
    .tab-btn.active { background: var(--primary); color: #fff; }
    .form-group { margin-bottom: 1rem; }
    .form-group label { display: block; font-size: .8rem; font-weight: 700; color: #475569; margin-bottom: .35rem; }
    .form-control { width: 100%; padding: .7rem .9rem; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 9px; color: #0f172a; font-size: .95rem; }
    .form-control:focus { outline: none; border-color: var(--primary); background: #fff; }
    .btn-submit { width: 100%; padding: .8rem; background: var(--primary); color: #fff; border: none; border-radius: 9px; font-weight: 700; font-size: .95rem; cursor: pointer; margin-top: .5rem; }
    .btn-submit:hover { background: var(--primary-hover); }
    .auth-err { color: var(--danger); font-size: .85rem; margin-top: .75rem; text-align: center; min-height: 1.2rem; font-weight: 600; }

    /* KPI grid */
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 1.2rem; position: relative; overflow: hidden; box-shadow: 0 1px 3px rgba(15,23,42,.04); }
    .kpi-card::before { content: ""; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--primary); }
    .kpi-card.green::before { background: var(--green); }
    .kpi-card.purple::before { background: var(--purple); }
    .kpi-card.orange::before { background: var(--orange); }
    .kpi-card span   { font-size: .75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .kpi-card strong { display: block; font-size: 1.6rem; font-weight: 800; margin-top: .3rem; color: #0f172a; }
    .kpi-card small  { font-size: .75rem; color: #64748b; }

    /* Panels & tables */
    .panel { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; overflow: hidden; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(15,23,42,.04); }
    .panel-header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--card-border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; background: #fff; }
    .panel-title { font-size: 1.05rem; font-weight: 800; display: flex; align-items: center; gap: .5rem; color: #0f172a; }
    .table-responsive { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: .88rem; }
    th { background: #f8fafc; padding: .75rem 1rem; color: #475569; font-weight: 700; border-bottom: 1px solid var(--card-border); }
    td { padding: .85rem 1rem; border-bottom: 1px solid #f1f5f9; color: #1e293b; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    .badge-status { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: .75rem; font-weight: 700; }
    .status-active   { background: #dcfce7; color: #15803d; }
    .status-inactive { background: #fee2e2; color: #b91c1c; }

    /* Buttons */
    .btn { padding: .5rem 1rem; border-radius: 8px; font-weight: 700; font-size: .85rem; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: .4rem; }
    .btn-primary   { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success   { background: #059669; color: #fff; }
    .btn-success:hover { background: #047857; }
    .btn-secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fecaca; }
    .btn-warn { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }

    /* Modals */
    .modal-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.5); backdrop-filter: blur(2px); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 1rem; }
    .modal-overlay.active { display: flex; }
    .modal { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; width: 100%; max-width: 580px; overflow: hidden; box-shadow: 0 20px 40px rgba(15,23,42,.2); }
    .modal-header { padding: 1.1rem 1.4rem; border-bottom: 1px solid var(--card-border); display: flex; align-items: center; justify-content: space-between; }
    .modal-header h3 { font-size: 1.15rem; font-weight: 800; color: #0f172a; }
    .modal-close { background: transparent; border: none; color: #64748b; font-size: 1.3rem; cursor: pointer; }
    .modal-body { padding: 1.4rem; max-height: 75vh; overflow-y: auto; }
    .code-box { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 9px; padding: 1rem; font-family: monospace; font-size: .85rem; color: #0369a1; word-break: break-all; margin: .8rem 0; }

    /* UPI QR */
    .upi-upload-area { border: 2px dashed #cbd5e1; border-radius: 12px; padding: 1.5rem; text-align: center; cursor: pointer; transition: .2s; background: #f8fafc; }
    .upi-upload-area:hover { border-color: var(--primary); }
    .upi-qr-preview { max-width: 200px; max-height: 200px; border-radius: 10px; border: 2px solid #e2e8f0; }

    /* Messages */
    .msg-bubble { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: .75rem 1rem; margin-bottom: .6rem; }
    .msg-bubble .msg-meta { font-size: .72rem; color: #64748b; margin-bottom: .3rem; }
    .msg-bubble .msg-text { font-size: .9rem; color: #0f172a; }
    .msg-bubble.unread { border-color: #3b82f6; background: #eff6ff; }

    /* Settlement grid */
    .settle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: .85rem; padding: 1.15rem 1.25rem; }
    .settle-item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: .75rem .9rem; }
    .settle-item span { display: block; font-size: .72rem; font-weight: 700; color: #64748b; text-transform: uppercase; }
    .settle-item strong { display: block; font-size: 1.15rem; font-weight: 800; color: #0f172a; margin-top: .2rem; }

    /* Toast */
    #toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: .75rem 1.25rem; border-radius: 10px; font-weight: 700; font-size: .9rem; z-index: 9999; display: none; animation: fadeIn .2s ease; box-shadow: 0 4px 12px rgba(0,0,0,.15); }
    #toast.show { display: block; }
    #toast.success { background: #059669; color: #ffffff; }
    #toast.error   { background: #dc2626; color: #ffffff; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  </style>
</head>
<body>

  <!-- Top Nav -->
  <header>
    <a href="/" class="brand">
      <div class="brand-icon">K</div>
      <div>
        <div style="display:flex;align-items:center;">
          <span class="brand-title">KNITE KOT</span>
          <span class="brand-badge">Cloud Hub</span>
        </div>
        <div style="font-size:.68rem;color:#64748b;">Restaurant Management System — rms.kniteinfotech.in</div>
      </div>
    </a>
    <div id="navUser" class="nav-user" style="display:none;">
      <span id="navRoleBadge" class="badge-role"></span>
      <span id="navName" style="font-size:.85rem;font-weight:700;"></span>
      <button class="btn-sm btn-logout" onclick="logout()">Log Out</button>
    </div>
  </header>

  <main>

    <!-- AUTH VIEW -->
    <div id="authView" class="auth-wrap">
      <div class="auth-box">
        <div class="auth-title">
          <h2>🏨 KNITE KOT Cloud Portal</h2>
          <p>Powered by KniteInfotech · rms.kniteinfotech.in</p>
        </div>

        <!-- Unified Username + Password Login (No Role Selection) -->
        <form id="loginForm" onsubmit="handleLogin(event)">
          <div class="form-group">
            <label>Username</label>
            <input id="loginUsername" class="form-control" placeholder="Enter your username" required autocomplete="username">
          </div>
          <div class="form-group">
            <label>Password</label>
            <input id="loginPassword" class="form-control" type="password" placeholder="••••••••" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn-submit">Sign In →</button>
          <div style="text-align:center;margin-top:1rem;font-size:.83rem;color:var(--text-muted);">
            New restaurant? <a href="javascript:void(0)" onclick="toggleRegisterMode(true)" style="color:#2563eb;font-weight:700;text-decoration:none;">Register here →</a>
          </div>
        </form>

        <!-- Restaurant Self-Registration Form -->
        <form id="registerForm" style="display:none;" onsubmit="handleRegister(event)">
          <div class="form-group">
            <label>Restaurant / Hotel Name *</label>
            <input id="regHotelName" class="form-control" placeholder="e.g. Grand Palace" required oninput="autoSlugRegShopId()">
          </div>
          <div class="form-group">
            <label>Shop ID (Unique URL Slug) *</label>
            <input id="regShopId" class="form-control" placeholder="e.g. grand-palace" required>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">
            <div class="form-group">
              <label>Owner Name *</label>
              <input id="regOwnerName" class="form-control" placeholder="Your name" required>
            </div>
            <div class="form-group">
              <label>Phone *</label>
              <input id="regOwnerPhone" class="form-control" placeholder="+91 98765 43210" required>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">
            <div class="form-group">
              <label>Username *</label>
              <input id="regUsername" class="form-control" placeholder="Login username" required>
            </div>
            <div class="form-group">
              <label>Password *</label>
              <input id="regPassword" class="form-control" type="password" placeholder="Min 4 chars" required>
            </div>
          </div>
          <button type="submit" class="btn-submit" style="background:#059669;">Submit Registration →</button>
          <div style="text-align:center;margin-top:1rem;font-size:.83rem;color:var(--text-muted);">
            Already registered? <a href="javascript:void(0)" onclick="toggleRegisterMode(false)" style="color:#2563eb;font-weight:700;text-decoration:none;">← Back to Sign In</a>
          </div>
        </form>

        <div id="authErr" class="auth-err"></div>
        <div id="authOk" style="color:#34d399;font-size:.85rem;margin-top:.75rem;text-align:center;"></div>
      </div>
    </div>

    <!-- OWNER DASHBOARD -->
    <div id="ownerDashboard" style="display:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1.5rem;">
        <div>
          <h2 id="ownerRestTitle" style="font-size:1.4rem;font-weight:800;color:#38bdf8;"></h2>
          <p id="ownerSubTitle" style="color:var(--text-muted);font-size:.85rem;"></p>
        </div>
        <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;">
          <button id="btnBackAdmin" class="btn btn-secondary" style="display:none;" onclick="backToSuperAdmin()">⬅ Admin Console</button>
          <input id="ownerDateInput" type="date" class="form-control" style="width:auto;padding:.45rem .75rem;" onchange="loadOwnerDashboard()">
          <button class="btn btn-secondary" onclick="setTodayDate()">Today</button>
          <button class="btn btn-warn" onclick="openUpiModal()">📷 UPI QR</button>
          <button class="btn btn-success" onclick="downloadLatestBackup()">📥 Download Backup</button>
        </div>
      </div>

      <!-- KPIs Row 1 -->
      <div class="kpi-grid">
        <div class="kpi-card green">
          <span>Net Sales (Daily)</span>
          <strong id="kpiNetSales">₹0.00</strong>
          <small id="kpiPaidOrders">0 Paid Orders</small>
        </div>
        <div class="kpi-card">
          <span>Cash Collection</span>
          <strong id="kpiCashSales">₹0.00</strong>
          <small>Verified Cash</small>
        </div>
        <div class="kpi-card purple">
          <span>UPI / Digital</span>
          <strong id="kpiUpiSales">₹0.00</strong>
          <small>QR / Direct Online</small>
        </div>
        <div class="kpi-card orange">
          <span>Card Payments</span>
          <strong id="kpiCardSales">₹0.00</strong>
          <small>EDC POS Swipes</small>
        </div>
      </div>

      <!-- KPIs Row 2 -->
      <div class="kpi-grid">
        <div class="kpi-card"><span>Dine-In Sales</span><strong id="kpiDineSales">₹0.00</strong></div>
        <div class="kpi-card"><span>Takeaway Sales</span><strong id="kpiTakeawaySales">₹0.00</strong></div>
        <div class="kpi-card"><span>Delivery (Zomato/Swiggy)</span><strong id="kpiDeliverySales">₹0.00</strong></div>
        <div class="kpi-card green">
          <span>Cloud Vault Sync</span>
          <strong id="kpiSyncStatus" style="font-size:1.1rem;color:#4ade80;">Active</strong>
          <small id="kpiSyncDetails">Up to date</small>
        </div>
      </div>

      <!-- Today's Settlement (EOD Close) -->
      <div class="panel" id="settlementPanel">
        <div class="panel-header">
          <div class="panel-title">🧾 Today's Settlement (EOD Close)</div>
          <span id="settleStatusBadge" class="badge-status" style="background:#fef3c7;color:#b45309;">Not Settled Yet</span>
        </div>
        <div id="settlementBody" style="padding:1.15rem 1.25rem;color:#64748b;font-size:.88rem;">
          Loading settlement status...
        </div>
      </div>

      <!-- Messages from Manager -->
      <div class="panel" id="messagesPanel">
        <div class="panel-header">
          <div class="panel-title">📨 Messages from Manager <span id="unreadBadge" style="display:none;background:#ef4444;color:#fff;border-radius:999px;font-size:.7rem;padding:2px 7px;margin-left:.4rem;"></span></div>
          <button class="btn btn-secondary btn-sm" onclick="loadMessages()">🔄 Refresh</button>
        </div>
        <div id="messagesContainer" style="padding:1rem;">
          <p style="color:#64748b;text-align:center;font-size:.85rem;">Loading messages...</p>
        </div>
      </div>

      <!-- UPI QR Section -->
      <div class="panel" id="upiQrPanel" style="display:none;">
        <div class="panel-header">
          <div class="panel-title">📷 Your UPI QR Code</div>
        </div>
        <div style="padding:1.25rem;display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;">
          <img id="upiQrImg" class="upi-qr-preview" src="" alt="UPI QR Code" style="display:none;">
          <div>
            <p style="font-size:.85rem;color:#94a3b8;margin-bottom:.75rem;">This QR code is stored securely on the cloud. Upload your UPI QR so restaurant staff can display it for payments.</p>
            <button class="btn btn-primary" onclick="openUpiModal()">⬆ Upload / Change UPI QR</button>
          </div>
        </div>
      </div>

      <!-- Previous Days History Table -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">📅 Previous Days History (Settlements &amp; Daily Summary)</div>
          <span style="font-size:.8rem;color:#64748b;">Click any date to load full details</span>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr><th>Date</th><th>Paid Orders</th><th>Cash</th><th>UPI</th><th>Card</th><th>Net Sales</th><th>Settlement</th><th>Action</th></tr>
            </thead>
            <tbody id="ownerHistoryTable">
              <tr><td colspan="8" style="text-align:center;color:#64748b;">Loading previous days history...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- SUPER ADMIN DASHBOARD -->
    <div id="superadminDashboard" style="display:none;">
      <div class="kpi-grid">
        <div class="kpi-card purple">
          <span>Total Managed Hotels</span>
          <strong id="admTotalHotels">0</strong>
          <small id="admActiveHotels">0 Active Clients</small>
        </div>
        <div class="kpi-card">
          <span>Stored Snapshots</span>
          <strong id="admTotalBackups">0</strong>
          <small>DB files in vault</small>
        </div>
        <div class="kpi-card orange">
          <span>Vault Storage Used</span>
          <strong id="admStorageUsed">0 MB</strong>
          <small>On Home Server</small>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">🏢 Hotel Clients Directory</div>
          <div style="display:flex;gap:.6rem;">
            <input id="hotelSearchInput" placeholder="Filter hotels..." class="form-control" style="width:200px;padding:.45rem .75rem;" oninput="filterHotelsTable()">
            <button class="btn btn-primary" onclick="openAddHotelModal()">+ Register New Hotel</button>
          </div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr><th>Shop ID</th><th>Hotel Name</th><th>Owner</th><th>Username</th><th>Status</th><th>Snapshots</th><th>Messages</th><th>Last Synced</th><th>Actions</th></tr>
            </thead>
            <tbody id="adminHotelsTable">
              <tr><td colspan="9" style="text-align:center;color:#64748b;">Loading registered hotels...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </main>

  <!-- Toast -->
  <div id="toast"></div>

  <!-- MODAL: Register Hotel -->
  <div id="addHotelModal" class="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <h3>Register New Hotel Client</h3>
        <button class="modal-close" onclick="closeModal('addHotelModal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="submitNewHotel(event)">
          <div class="form-group">
            <label>Hotel / Restaurant Name *</label>
            <input id="addHotelName" class="form-control" placeholder="e.g. Royal Biryani & Cafe" required oninput="autoSlugShopId()">
          </div>
          <div class="form-group">
            <label>Shop ID (Unique Slug for POS Sync) *</label>
            <input id="addShopId" class="form-control" placeholder="e.g. royal-biryani" required>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
            <div class="form-group">
              <label>Owner Full Name</label>
              <input id="addOwnerName" class="form-control" placeholder="e.g. Suresh Kumar">
            </div>
            <div class="form-group">
              <label>Owner Phone</label>
              <input id="addOwnerPhone" class="form-control" placeholder="+91 98765 43210">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
            <div class="form-group">
              <label>Cloud Login Username *</label>
              <input id="addOwnerUsername" class="form-control" placeholder="e.g. suresh123" required>
            </div>
            <div class="form-group">
              <label>Cloud Login Password *</label>
              <input id="addOwnerPassword" class="form-control" type="password" placeholder="Strong password" required>
            </div>
          </div>
          <div class="form-group">
            <label>Custom API Key (Optional — leave blank to use server global key)</label>
            <input id="addApiKey" class="form-control" placeholder="Optional webhook secret for POS sync">
          </div>
          <div class="form-group">
            <label>Notes</label>
            <input id="addNotes" class="form-control" placeholder="e.g. 3-branch restaurant in Calicut">
          </div>
          <button type="submit" class="btn-submit">Create Hotel &amp; Get POS Setup →</button>
        </form>
      </div>
    </div>
  </div>

  <!-- MODAL: POS Setup -->
  <div id="posSetupModal" class="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <h3 id="posSetupTitle">POS Cloud Sync Setup</h3>
        <button class="modal-close" onclick="closeModal('posSetupModal')">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:.85rem;color:#94a3b8;margin-bottom:.75rem;">
          In the POS terminal, go to <strong>Settings → Cloud Backup &amp; Sync</strong>, choose <strong>Custom Cloud Webhook</strong> and enter:
        </p>
        <label style="font-size:.75rem;font-weight:700;color:#cbd5e1;">LAN Webhook URL:</label>
        <div id="posLanUrl" class="code-box"></div>
        <label style="font-size:.75rem;font-weight:700;color:#cbd5e1;">Public URL (rms.kniteinfotech.in):</label>
        <div id="posPublicUrl" class="code-box"></div>
        <label style="font-size:.75rem;font-weight:700;color:#cbd5e1;">API Secret Key:</label>
        <div id="posApiKey" class="code-box"></div>
        <div style="margin-top:1rem;text-align:right;">
          <button class="btn btn-primary" onclick="closeModal('posSetupModal')">Done ✓</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: Backups Vault -->
  <div id="backupsModal" class="modal-overlay">
    <div class="modal" style="max-width:680px;">
      <div class="modal-header">
        <h3 id="backupsModalTitle">Database Backups Vault</h3>
        <button class="modal-close" onclick="closeModal('backupsModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="table-responsive">
          <table>
            <thead><tr><th>Backup File</th><th>Size</th><th>Saved At</th><th>Action</th></tr></thead>
            <tbody id="backupsListTable"><tr><td colspan="4" style="text-align:center;">Loading...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: Assign / Edit Owner Login Credentials -->
  <div id="editCredsModal" class="modal-overlay">
    <div class="modal" style="max-width:440px;">
      <div class="modal-header">
        <h3 id="editCredsTitle">🔑 Assign Owner Login</h3>
        <button class="modal-close" onclick="closeModal('editCredsModal')">&times;</button>
      </div>
      <div class="modal-body">
        <form onsubmit="submitEditCreds(event)">
          <input type="hidden" id="editCredsShopId">
          <div class="form-group">
            <label>Owner Portal Username *</label>
            <input id="editCredsUsername" class="form-control" required placeholder="e.g. royalowner">
          </div>
          <div class="form-group">
            <label>New Password (leave blank to keep existing)</label>
            <input id="editCredsPassword" class="form-control" type="password" placeholder="Enter new password">
          </div>
          <button type="submit" class="btn-submit">Save Login Credentials</button>
        </form>
      </div>
    </div>
  </div>

  <!-- MODAL: UPI QR Upload -->
  <div id="upiModal" class="modal-overlay">
    <div class="modal" style="max-width:420px;">
      <div class="modal-header">
        <h3>📷 Upload UPI QR Code</h3>
        <button class="modal-close" onclick="closeModal('upiModal')">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:.85rem;color:#94a3b8;margin-bottom:1rem;">Upload your restaurant's UPI QR image (PNG/JPG). It is stored securely on the cloud server.</p>
        <form id="upiUploadForm" onsubmit="submitUpiQr(event)">
          <div class="upi-upload-area" onclick="document.getElementById('upiFileInput').click()">
            <div style="font-size:2rem;margin-bottom:.5rem;">📷</div>
            <div style="font-size:.85rem;color:#94a3b8;" id="upiFileLabel">Click to select QR image (PNG / JPG)</div>
            <input id="upiFileInput" type="file" accept=".png,.jpg,.jpeg,.gif,.webp" style="display:none;" onchange="previewUpiFile(this)">
          </div>
          <div id="upiPreviewWrap" style="display:none;margin-top:1rem;text-align:center;">
            <img id="upiPreviewImg" style="max-width:160px;max-height:160px;border-radius:10px;border:2px solid #334155;" src="" alt="Preview">
          </div>
          <button type="submit" class="btn-submit" style="margin-top:1rem;">Upload QR to Cloud</button>
        </form>
        <div id="upiErr" style="color:#ef4444;font-size:.85rem;margin-top:.5rem;text-align:center;"></div>
      </div>
    </div>
  </div>

  <script>
    let currentRole   = null;
    let currentShopId = null;
    let allHotelsCache= [];

    function getLocalDate() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    function setTodayDate() {
      const el = document.getElementById('ownerDateInput');
      if (el) el.value = getLocalDate();
    }
    function showToast(msg, type='success') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className   = 'show ' + type;
      setTimeout(() => { t.className = ''; }, 3200);
    }

    async function apiFetch(url, opts = {}) {
      opts.headers = opts.headers || {};
      const tok = localStorage.getItem('knite_token');
      if (tok) opts.headers['Authorization'] = 'Bearer ' + tok;
      opts.credentials = 'include';
      return fetch(url, opts);
    }

    window.onload = async () => {
      setTodayDate();
      await checkAuth();
    };

    async function checkAuth() {
      try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok) {
          const d = await res.json();
          if (d.authenticated) { setupUserSession(d); return; }
        }
      } catch(e) {}
      showAuthView();
    }

    function setupUserSession(user) {
      currentRole   = user.role;
      currentShopId = user.shop_id;
      document.getElementById('authView').style.display    = 'none';
      document.getElementById('navUser').style.display     = 'flex';
      const badge = document.getElementById('navRoleBadge');
      if (user.role === 'super_admin') {
        badge.className   = 'badge-role badge-super';
        badge.textContent = 'SUPER ADMIN';
        document.getElementById('navName').textContent = user.username;
        document.getElementById('ownerDashboard').style.display      = 'none';
        document.getElementById('superadminDashboard').style.display = 'block';
        loadSuperAdminDashboard();
      } else {
        badge.className   = 'badge-role badge-hotel';
        badge.textContent = 'HOTEL OWNER';
        document.getElementById('navName').textContent = user.username || user.shop_id;
        document.getElementById('superadminDashboard').style.display = 'none';
        document.getElementById('ownerDashboard').style.display      = 'block';
        loadOwnerDashboard();
        loadMessages();
      }
    }

    function showAuthView() {
      currentRole = currentShopId = null;
      document.getElementById('authView').style.display            = 'flex';
      document.getElementById('navUser').style.display             = 'none';
      document.getElementById('ownerDashboard').style.display      = 'none';
      document.getElementById('superadminDashboard').style.display = 'none';
    }

    function toggleRegisterMode(showReg) {
      document.getElementById('authErr').textContent = '';
      document.getElementById('authOk').textContent  = '';
      document.getElementById('loginForm').style.display    = showReg ? 'none' : 'block';
      document.getElementById('registerForm').style.display = showReg ? 'block' : 'none';
    }

    function autoSlugRegShopId() {
      const name = document.getElementById('regHotelName').value;
      const slug = name.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      document.getElementById('regShopId').value = slug;
    }

    async function handleRegister(e) {
      e.preventDefault();
      document.getElementById('authErr').textContent = '';
      document.getElementById('authOk').textContent  = '';
      const payload = {
        hotel_name:     document.getElementById('regHotelName').value.trim(),
        shop_id:        document.getElementById('regShopId').value.trim(),
        owner_name:     document.getElementById('regOwnerName').value.trim(),
        owner_phone:    document.getElementById('regOwnerPhone').value.trim(),
        owner_username: document.getElementById('regUsername').value.trim(),
        owner_password: document.getElementById('regPassword').value.trim()
      };
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const d = await res.json();
        if (d.success) {
          document.getElementById('registerForm').reset();
          toggleRegisterMode(false);
          document.getElementById('authOk').textContent = d.message;
        } else {
          document.getElementById('authErr').textContent = d.message || 'Registration failed';
        }
      } catch(err) {
        document.getElementById('authErr').textContent = 'Server connection error';
      }
    }

    async function handleLogin(e) {
      e.preventDefault();
      document.getElementById('authErr').textContent = '';
      const username = document.getElementById('loginUsername').value.trim();
      const password = document.getElementById('loginPassword').value.trim();
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({username, password})
        });
        const d = await res.json();
        if (d.success) {
          if (d.token) localStorage.setItem('knite_token', d.token);
          setupUserSession(d);
        } else {
          document.getElementById('authErr').textContent = d.message || 'Login failed';
        }
      } catch(err) {
        document.getElementById('authErr').textContent = 'Server connection error';
      }
    }

    async function logout() {
      try { await apiFetch('/api/auth/logout', {method:'POST'}); } catch(e) {}
      localStorage.removeItem('knite_token');
      showAuthView();
    }

    function backToSuperAdmin() {
      document.getElementById('ownerDashboard').style.display      = 'none';
      document.getElementById('superadminDashboard').style.display = 'block';
      loadSuperAdminDashboard();
    }

    // ── OWNER DASHBOARD ───────────────────────────────────────────────
    async function loadOwnerDashboard(targetShop) {
      const shop = targetShop || currentShopId;
      const date = document.getElementById('ownerDateInput').value || getLocalDate();
      const backBtn = document.getElementById('btnBackAdmin');
      if (backBtn) backBtn.style.display = (currentRole === 'super_admin') ? 'inline-flex' : 'none';

      try {
        const res = await apiFetch(`/api/owner/dashboard?shop_id=${encodeURIComponent(shop)}&date=${encodeURIComponent(date)}`);
        const d   = await res.json();
        if (!d.success) {
          document.getElementById('ownerHistoryTable').innerHTML =
            `<tr><td colspan="8" style="text-align:center;color:#dc2626;">${d.message || 'Error loading dashboard'}</td></tr>`;
          return;
        }

        document.getElementById('ownerRestTitle').textContent = d.hotel_name;
        document.getElementById('ownerRestTitle').style.color = '#1d4ed8';
        document.getElementById('ownerSubTitle').textContent  = `Shop ID: ${d.shop_id} · Owner: ${d.owner_name}`;

        const s = d.summary || {};
        document.getElementById('kpiNetSales').textContent      = '₹' + Number(s.net_sales    || 0).toFixed(2);
        document.getElementById('kpiPaidOrders').textContent    = `${s.paid_orders || 0} Paid Orders`;
        document.getElementById('kpiCashSales').textContent     = '₹' + Number(s.cash_sales   || 0).toFixed(2);
        document.getElementById('kpiUpiSales').textContent      = '₹' + Number(s.upi_sales    || 0).toFixed(2);
        document.getElementById('kpiCardSales').textContent     = '₹' + Number(s.card_sales   || 0).toFixed(2);
        document.getElementById('kpiDineSales').textContent     = '₹' + Number(s.dine_in_sales|| 0).toFixed(2);
        document.getElementById('kpiTakeawaySales').textContent = '₹' + Number(s.takeaway_sales||0).toFixed(2);
        document.getElementById('kpiDeliverySales').textContent = '₹' + Number(s.delivery_sales||0).toFixed(2);

        if (d.has_snapshot) {
          document.getElementById('kpiSyncStatus').textContent  = 'Active & Healthy';
          document.getElementById('kpiSyncStatus').style.color  = '#059669';
          document.getElementById('kpiSyncDetails').textContent = `${d.snapshot_file} (${d.snapshot_time})`;
        } else {
          document.getElementById('kpiSyncStatus').textContent  = 'Waiting for Sync';
          document.getElementById('kpiSyncStatus').style.color  = '#d97706';
          document.getElementById('kpiSyncDetails').textContent = 'No database uploaded from POS yet';
        }

        // Today's Settlement
        const settleBadge = document.getElementById('settleStatusBadge');
        const settleBody  = document.getElementById('settlementBody');
        if (d.settlement) {
          const st = d.settlement;
          settleBadge.textContent = `Settled · ${st.settled_at || ''}`;
          settleBadge.style.background = '#dcfce7';
          settleBadge.style.color = '#15803d';
          const variance = Number(st.cash_variance || 0);
          const varColor = variance === 0 ? '#059669' : (variance < 0 ? '#dc2626' : '#2563eb');
          settleBody.innerHTML = `
            <div class="settle-grid" style="padding:0;">
              <div class="settle-item"><span>Gross Sales</span><strong>₹${Number(st.gross_sales||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Discounts</span><strong>₹${Number(st.discount_amount||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Tax (GST)</span><strong>₹${Number(st.tax_amount||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Net Settled Sales</span><strong style="color:#059669;">₹${Number(st.net_sales||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Opening Float</span><strong>₹${Number(st.opening_float||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Petty Expenses</span><strong>₹${Number(st.petty_expenses||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Actual Cash Counted</span><strong>₹${Number(st.actual_cash||0).toFixed(2)}</strong></div>
              <div class="settle-item"><span>Cash Variance</span><strong style="color:${varColor};">₹${variance.toFixed(2)}</strong></div>
            </div>
            <div style="margin-top:.85rem;font-size:.82rem;color:#475569;">
              Settled by <strong>${st.settled_by || 'Manager'}</strong> · Paid: <strong>${st.paid_orders || 0}</strong> · Cancelled: <strong>${st.cancelled_orders || 0}</strong>
              ${st.notes ? ` · Notes: <em>${st.notes}</em>` : ''}
            </div>
          `;
        } else {
          settleBadge.textContent = 'Not Settled Yet';
          settleBadge.style.background = '#fef3c7';
          settleBadge.style.color = '#b45309';
          settleBody.innerHTML = `Day-end settlement has not been closed in POS for <strong>${d.date || date}</strong> yet.`;
        }

        // UPI QR
        const upiPanel = document.getElementById('upiQrPanel');
        if (d.has_upi_qr) {
          upiPanel.style.display = 'block';
          const img = document.getElementById('upiQrImg');
          img.src = `/api/owner/upi-qr?shop_id=${encodeURIComponent(shop)}&t=${Date.now()}`;
          img.style.display = 'block';
        } else {
          upiPanel.style.display = 'none';
        }

        // Previous Days History
        const tbody = document.getElementById('ownerHistoryTable');
        tbody.innerHTML = '';
        if (!d.past_days || d.past_days.length === 0) {
          tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748b;">No previous days history synced yet.</td></tr>`;
        } else {
          d.past_days.forEach(day => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = () => {
              document.getElementById('ownerDateInput').value = day.date;
              loadOwnerDashboard(shop);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            };
            tr.innerHTML = `
              <td><strong>${day.date}</strong></td>
              <td>${day.paid_orders || 0}</td>
              <td>₹${Number(day.cash_sales || 0).toFixed(2)}</td>
              <td>₹${Number(day.upi_sales || 0).toFixed(2)}</td>
              <td>₹${Number(day.card_sales || 0).toFixed(2)}</td>
              <td><strong style="color:#059669;">₹${Number(day.net_sales || 0).toFixed(2)}</strong></td>
              <td><span class="badge-status ${day.settled ? 'status-active' : ''}" style="${day.settled ? '' : 'background:#fef3c7;color:#b45309;'}">${day.settled ? 'Settled' : 'Open / Unsettled'}</span></td>
              <td><button class="btn btn-secondary btn-sm">View Day</button></td>
            `;
            tbody.appendChild(tr);
          });
        }
      } catch(err) {
        document.getElementById('ownerHistoryTable').innerHTML =
          `<tr><td colspan="8" style="text-align:center;color:#dc2626;">Server error: ${err}</td></tr>`;
      }
    }

    // ── MESSAGES ─────────────────────────────────────────────────────
    async function loadMessages(targetShop) {
      const shop = targetShop || currentShopId;
      if (!shop) return;
      try {
        const res = await apiFetch(`/api/messages/${encodeURIComponent(shop)}`);
        const d   = await res.json();
        const container = document.getElementById('messagesContainer');
        const badge     = document.getElementById('unreadBadge');
        if (!container) return;
        if (!d.success || !d.messages || d.messages.length === 0) {
          container.innerHTML = '<p style="color:#64748b;text-align:center;font-size:.85rem;">No messages from manager yet.</p>';
          if (badge) badge.style.display = 'none';
          return;
        }
        container.innerHTML = '';
        const unread = d.messages.filter(m => !m.is_read).length;
        if (badge) {
          badge.style.display = unread > 0 ? 'inline-block' : 'none';
          badge.textContent   = unread > 0 ? unread + ' new' : '';
        }
        d.messages.forEach(m => {
          const div = document.createElement('div');
          div.className = 'msg-bubble' + (m.is_read ? '' : ' unread');
          div.innerHTML = `
            <div class="msg-meta">👤 ${m.sent_by || 'Manager'} &nbsp;·&nbsp; ${m.sent_at || ''}</div>
            <div class="msg-text">${m.message}</div>
          `;
          container.appendChild(div);
        });
      } catch(e) {
        const c = document.getElementById('messagesContainer');
        if (c) c.innerHTML = '<p style="color:#ef4444;text-align:center;">Failed to load messages.</p>';
      }
    }

    // ── DOWNLOAD BACKUP ───────────────────────────────────────────────
    function downloadLatestBackup(targetShop) {
      const shop = targetShop || currentShopId;
      const tok  = localStorage.getItem('knite_token') || '';
      window.location.href = `/api/owner/download-backup?shop_id=${encodeURIComponent(shop)}&token=${encodeURIComponent(tok)}`;
    }

    // ── UPI QR ────────────────────────────────────────────────────────
    function openUpiModal() {
      document.getElementById('upiErr').textContent = '';
      document.getElementById('upiPreviewWrap').style.display = 'none';
      document.getElementById('upiFileLabel').textContent     = 'Click to select QR image (PNG / JPG)';
      document.getElementById('upiFileInput').value           = '';
      document.getElementById('upiModal').classList.add('active');
    }

    function previewUpiFile(input) {
      const file = input.files[0];
      if (!file) return;
      document.getElementById('upiFileLabel').textContent = file.name;
      const reader = new FileReader();
      reader.onload = e => {
        const img = document.getElementById('upiPreviewImg');
        img.src   = e.target.result;
        document.getElementById('upiPreviewWrap').style.display = 'block';
      };
      reader.readAsDataURL(file);
    }

    async function submitUpiQr(e) {
      e.preventDefault();
      const input = document.getElementById('upiFileInput');
      if (!input.files[0]) { document.getElementById('upiErr').textContent = 'Please select a file first.'; return; }
      const shop  = currentShopId;
      if (!shop)  { document.getElementById('upiErr').textContent = 'No shop ID detected.'; return; }
      const form = new FormData();
      form.append('qr_file', input.files[0]);
      form.append('shop_id', shop);
      try {
        const res = await apiFetch('/api/owner/upload-upi-qr', {method:'POST', body: form});
        const d   = await res.json();
        if (d.success) {
          closeModal('upiModal');
          showToast('UPI QR uploaded successfully!');
          loadOwnerDashboard();
        } else {
          document.getElementById('upiErr').textContent = d.message || 'Upload failed';
        }
      } catch(err) {
        document.getElementById('upiErr').textContent = 'Network error: ' + err;
      }
    }

    // ── SUPER ADMIN DASHBOARD ─────────────────────────────────────────
    async function loadSuperAdminDashboard() {
      try {
        const r1 = await apiFetch('/api/superadmin/overview');
        const o  = await r1.json();
        if (o.success) {
          document.getElementById('admTotalHotels').textContent = o.total_hotels;
          document.getElementById('admActiveHotels').textContent= `${o.active_hotels} Active Clients`;
          document.getElementById('admTotalBackups').textContent= o.total_backups;
          document.getElementById('admStorageUsed').textContent = `${o.total_storage_mb} MB`;
        }
      } catch(e) { console.error('Overview error:', e); }

      try {
        const r2 = await apiFetch('/api/superadmin/hotels');
        const h  = await r2.json();
        if (h.success) {
          allHotelsCache = h.hotels || [];
          renderHotelsTable(allHotelsCache);
        } else {
          document.getElementById('adminHotelsTable').innerHTML =
            `<tr><td colspan="9" style="text-align:center;color:#dc2626;">${h.message||'Error'}</td></tr>`;
        }
      } catch(e) {
        document.getElementById('adminHotelsTable').innerHTML =
          `<tr><td colspan="9" style="text-align:center;color:#dc2626;">Connection failed: ${e}</td></tr>`;
      }
    }

    function renderHotelsTable(hotels) {
      const tbody = document.getElementById('adminHotelsTable');
      tbody.innerHTML = '';
      if (!hotels || hotels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#64748b;">No hotels registered yet. Click "+ Register New Hotel" to add one.</td></tr>';
        return;
      }
      hotels.forEach(h => {
        const tr = document.createElement('tr');
        const unreadHtml = h.unread_messages > 0
          ? `<span style="background:#ef4444;color:#fff;border-radius:999px;font-size:.7rem;padding:2px 7px;">${h.unread_messages} new</span>`
          : `<span style="color:#64748b;font-size:.8rem;">None</span>`;
        tr.innerHTML = `
          <td><code style="color:#0369a1;font-weight:700;">${h.shop_id}</code></td>
          <td><strong>${h.hotel_name}</strong></td>
          <td>
            <div>${h.owner_name||'Owner'}</div>
            <small style="color:#64748b;">${h.owner_phone||''}</small>
          </td>
          <td><code style="color:#475569;font-size:.78rem;">${h.owner_username||'—'}</code></td>
          <td>
            ${(() => {
              const st = h.status || (h.is_active ? 'active' : 'pending');
              if (h.is_active || st === 'active') {
                return '<span class="badge-status status-active">ACTIVE</span>';
              } else if (st === 'suspended') {
                return '<span class="badge-status status-inactive">SUSPENDED</span>';
              } else {
                return '<span class="badge-status" style="background:#fef3c7;color:#b45309;">PENDING APPROVAL</span>';
              }
            })()}
          </td>
          <td><strong>${h.backup_count||0}</strong> <small style="color:#64748b;">files</small></td>
          <td>${unreadHtml}</td>
          <td style="font-size:.8rem;color:#64748b;">${h.last_synced_at||'Never'}</td>
          <td>
            <div style="display:flex;gap:.4rem;flex-wrap:wrap;">
              ${h.is_active
                ? `<button class="btn btn-secondary btn-sm" onclick="toggleHotelStatus('${h.shop_id}',0)" title="Suspend">⏸ Suspend</button>`
                : `<button class="btn btn-success btn-sm" onclick="toggleHotelStatus('${h.shop_id}',1)" title="${h.status==='suspended'?'Reactivate':'Approve & Activate'}">${h.status==='suspended'?'▶ Reactivate':'✅ Approve'}</button>`}
              <button class="btn btn-secondary btn-sm" onclick="openEditCreds('${h.shop_id}','${h.hotel_name.replace(/'/g,"\\'")}','${(h.owner_username||'').replace(/'/g,"\\'")}')" title="Assign / Edit Owner Login">🔑 Login</button>
              <button class="btn btn-secondary btn-sm" onclick="showPosSetup('${h.shop_id}','${h.hotel_name.replace(/'/g,"\\'")}','${h.api_key||''}')" title="POS Setup">⚙️ POS</button>
              <button class="btn btn-secondary btn-sm" onclick="viewHotelBackups('${h.shop_id}')" title="Backups Vault">💾 Vault</button>
              <button class="btn btn-warn btn-sm" onclick="viewHotelMessages('${h.shop_id}')" title="Messages">📨 Msgs</button>
              <button class="btn btn-danger btn-sm" onclick="deleteHotel('${h.shop_id}')" title="Delete">🗑️</button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    function filterHotelsTable() {
      const q = (document.getElementById('hotelSearchInput').value||'').toLowerCase();
      renderHotelsTable(allHotelsCache.filter(h =>
        (h.shop_id||'').toLowerCase().includes(q) ||
        (h.hotel_name||'').toLowerCase().includes(q) ||
        (h.owner_name||'').toLowerCase().includes(q)
      ));
    }

    function autoSlugShopId() {
      const name = document.getElementById('addHotelName').value;
      const slug = name.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      document.getElementById('addShopId').value = slug;
      // Auto-suggest username
      const userField = document.getElementById('addOwnerUsername');
      if (!userField.value) userField.value = slug.replace(/-/g,'');
    }

    function openAddHotelModal() { document.getElementById('addHotelModal').classList.add('active'); }
    function closeModal(id)      { document.getElementById(id).classList.remove('active'); }

    async function submitNewHotel(e) {
      e.preventDefault();
      const payload = {
        hotel_name:      document.getElementById('addHotelName').value.trim(),
        shop_id:         document.getElementById('addShopId').value.trim(),
        owner_name:      document.getElementById('addOwnerName').value.trim(),
        owner_phone:     document.getElementById('addOwnerPhone').value.trim(),
        owner_username:  document.getElementById('addOwnerUsername').value.trim(),
        owner_password:  document.getElementById('addOwnerPassword').value.trim(),
        api_key:         document.getElementById('addApiKey').value.trim(),
        notes:           document.getElementById('addNotes').value.trim()
      };
      try {
        const res = await apiFetch('/api/superadmin/hotels', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const d = await res.json();
        if (d.success) {
          closeModal('addHotelModal');
          loadSuperAdminDashboard();
          showPosSetup(payload.shop_id, payload.hotel_name, payload.api_key);
          showToast(`Hotel "${payload.hotel_name}" registered!`);
        } else {
          alert(d.message || 'Error registering hotel');
        }
      } catch(err) {
        alert('Server error: ' + err);
      }
    }

    function showPosSetup(shopId, hotelName, apiKey) {
      const lanUrl    = `http://192.168.1.50:4000/api/backups/${shopId}`;
      const publicUrl = `https://rms.kniteinfotech.in/api/backups/${shopId}`;
      const secret    = apiKey || 'CjjxZX5tBMEOQnnkM_kQB9x0VJXZ5Walf-9HL8d9SWk';
      document.getElementById('posSetupTitle').textContent = `POS Setup — ${hotelName}`;
      document.getElementById('posLanUrl').textContent     = lanUrl;
      document.getElementById('posPublicUrl').textContent  = publicUrl;
      document.getElementById('posApiKey').textContent     = secret;
      document.getElementById('posSetupModal').classList.add('active');
    }

    function viewHotelAnalytics(shopId) {
      currentShopId = shopId;
      document.getElementById('superadminDashboard').style.display = 'none';
      document.getElementById('ownerDashboard').style.display      = 'block';
      loadOwnerDashboard(shopId);
      loadMessages(shopId);
    }

    async function viewHotelBackups(shopId) {
      document.getElementById('backupsModalTitle').textContent = `Stored Snapshots: ${shopId}`;
      document.getElementById('backupsModal').classList.add('active');
      const tbody = document.getElementById('backupsListTable');
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>';
      try {
        const res = await apiFetch(`/api/superadmin/hotels/${encodeURIComponent(shopId)}/backups`);
        const d   = await res.json();
        tbody.innerHTML = '';
        if (d.success && d.backups && d.backups.length > 0) {
          const tok = localStorage.getItem('knite_token') || '';
          d.backups.forEach(b => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><code>${b.filename}</code></td>
              <td>${(b.size/1024).toFixed(1)} KB</td>
              <td>${b.modified}</td>
              <td><a class="btn btn-sm btn-primary" href="/api/superadmin/hotels/${encodeURIComponent(shopId)}/backups/${encodeURIComponent(b.filename)}?token=${encodeURIComponent(tok)}" download>Download</a></td>
            `;
            tbody.appendChild(tr);
          });
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;">No backups stored yet.</td></tr>';
        }
      } catch(e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:red;text-align:center;">Failed to load.</td></tr>';
      }
    }

    async function viewHotelMessages(shopId) {
      currentShopId = shopId;
      // Switch to owner view for that hotel (admin can view)
      document.getElementById('superadminDashboard').style.display = 'none';
      document.getElementById('ownerDashboard').style.display      = 'block';
      document.getElementById('btnBackAdmin').style.display        = 'inline-flex';
      loadOwnerDashboard(shopId);
      loadMessages(shopId);
    }

    function openEditCreds(shopId, hotelName, currentUsername) {
      document.getElementById('editCredsShopId').value   = shopId;
      document.getElementById('editCredsTitle').textContent = `🔑 Assign Login — ${hotelName}`;
      document.getElementById('editCredsUsername').value = currentUsername || '';
      document.getElementById('editCredsPassword').value = '';
      document.getElementById('editCredsModal').classList.add('active');
    }

    async function submitEditCreds(e) {
      e.preventDefault();
      const shopId   = document.getElementById('editCredsShopId').value;
      const username = document.getElementById('editCredsUsername').value.trim();
      const password = document.getElementById('editCredsPassword').value.trim();
      const payload  = { owner_username: username };
      if (password) payload.owner_password = password;
      try {
        const res = await apiFetch(`/api/superadmin/hotels/${encodeURIComponent(shopId)}`, {
          method: 'PUT',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const d = await res.json();
        if (d.success) {
          closeModal('editCredsModal');
          showToast('Owner login credentials updated!');
          loadSuperAdminDashboard();
        } else {
          alert(d.message || 'Failed to update credentials');
        }
      } catch(err) { alert('Error: ' + err); }
    }

    async function toggleHotelStatus(shopId, isActive) {
      try {
        const res = await apiFetch(`/api/superadmin/hotels/${encodeURIComponent(shopId)}/status`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({is_active: isActive})
        });
        const d = await res.json();
        if (d.success) {
          showToast(d.message);
          loadSuperAdminDashboard();
        } else {
          alert(d.message || 'Status update failed');
        }
      } catch(e) { alert('Error: ' + e); }
    }

    async function deleteHotel(shopId) {
      if (!confirm(`Remove hotel "${shopId}" from cloud registry? (Backup files remain on disk)`)) return;
      try {
        const res = await apiFetch(`/api/superadmin/hotels/${encodeURIComponent(shopId)}`, {method:'DELETE'});
        const d   = await res.json();
        if (d.success) { loadSuperAdminDashboard(); showToast('Hotel removed.'); }
        else alert(d.message || 'Delete error');
      } catch(e) { alert('Error: ' + e); }
    }
  </script>
</body>
</html>"""


@app.route('/')
@app.route('/admin')
@app.route('/owner')
def portal_page():
    return Response(HTML_PORTAL, mimetype='text/html')


if __name__ == '__main__':
    print(f"[KNITE KOT Cloud] Starting on port {CLOUD_PORT}")
    print(f"[KNITE KOT Cloud] Storage: {STORAGE_DIR}")
    app.run(host='0.0.0.0', port=CLOUD_PORT, debug=False, threaded=True)
