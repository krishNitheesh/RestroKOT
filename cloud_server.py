"""
RestroKOT Home Cloud Server (Multi-Shop Backup Vault + Remote Owner Portal)
Run this on your Home Server:
    python3 cloud_server.py
Then in each shop's RestroKOT Settings -> Cloud Backup & Sync:
    Provider: Custom Cloud Webhook / REST Server
    Cloud Webhook URL: http://<HOME_SERVER_IP_OR_DOMAIN>:4000/api/backups/shop1
    API Secret: <same as CLOUD_API_KEY, default: restrokot-cloud-secret>
"""
import os
import re
import hashlib
import sqlite3
from datetime import datetime
from flask import Flask, request, jsonify, send_file, Response

app = Flask(__name__)

CLOUD_PORT = int(os.environ.get('CLOUD_PORT', 4000))
CLOUD_API_KEY = os.environ.get('CLOUD_API_KEY', 'restrokot-cloud-secret').strip()
STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cloud_storage')
os.makedirs(STORAGE_DIR, exist_ok=True)


def sanitize_shop_id(shop_id: str) -> str:
    cleaned = re.sub(r'[^a-zA-Z0-9_-]', '', (shop_id or '').strip().lower())
    return cleaned or 'default'


def check_auth():
    if not CLOUD_API_KEY:
        return True
    auth = (request.headers.get('Authorization') or '').strip()
    return auth == f"Bearer {CLOUD_API_KEY}"


def get_shop_dir(shop_id: str) -> str:
    d = os.path.join(STORAGE_DIR, sanitize_shop_id(shop_id))
    os.makedirs(d, exist_ok=True)
    return d


def get_latest_db_path(shop_id: str):
    d = get_shop_dir(shop_id)
    files = sorted([f for f in os.listdir(d) if f.endswith('.db')], reverse=True)
    if not files:
        return None, None
    return files[0], os.path.join(d, files[0])


@app.route('/api/backups/<shop_id>', methods=['POST'])
def receive_backup(shop_id):
    if not check_auth():
        return jsonify({'success': False, 'message': 'Unauthorized API key'}), 401

    raw_bytes = request.get_data()
    if not raw_bytes:
        return jsonify({'success': False, 'message': 'Empty backup payload'}), 400

    expected_sha = (request.headers.get('X-RestroKOT-SHA256') or '').strip().lower()
    actual_sha = hashlib.sha256(raw_bytes).hexdigest().lower()
    if expected_sha and expected_sha != actual_sha:
        return jsonify({'success': False, 'message': 'SHA-256 integrity mismatch'}), 400

    filename = os.path.basename(
        request.headers.get('X-RestroKOT-Filename')
        or f"RestroKOT_Backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    )
    if not filename.endswith('.db'):
        filename += '.db'

    shop_dir = get_shop_dir(shop_id)
    dest_path = os.path.join(shop_dir, filename)
    with open(dest_path, 'wb') as f:
        f.write(raw_bytes)

    return jsonify({
        'success': True,
        'shop_id': sanitize_shop_id(shop_id),
        'filename': filename,
        'size': len(raw_bytes),
        'sha256': actual_sha,
        'received_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }), 201


@app.route('/api/backups/<shop_id>/latest', methods=['GET'])
def download_latest_backup(shop_id):
    if not check_auth():
        return jsonify({'success': False, 'message': 'Unauthorized API key'}), 401

    filename, path = get_latest_db_path(shop_id)
    if not path:
        return jsonify({'success': False, 'message': 'No backups found for this shop'}), 404

    resp = send_file(path, as_attachment=True, download_name=filename)
    resp.headers['X-RestroKOT-Filename'] = filename
    return resp


@app.route('/api/cloud-owner/summary', methods=['POST'])
def cloud_owner_summary():
    """Verify Owner PIN against the shop's latest synced snapshot and return live sales summary."""
    data = request.get_json(silent=True) or {}
    shop_id = sanitize_shop_id(data.get('shop_id') or '')
    pin = (data.get('pin') or '').strip()
    target_date = (data.get('date') or '').strip() or datetime.now().strftime('%Y-%m-%d')

    if not shop_id or not pin:
        return jsonify({'success': False, 'error': 'Shop ID and Owner PIN are required'}), 400

    filename, db_path = get_latest_db_path(shop_id)
    if not db_path:
        return jsonify({'success': False, 'error': f'No cloud snapshot synced yet for shop "{shop_id}"'}), 404

    pin_hash = hashlib.sha256(pin.encode('utf-8')).hexdigest()
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        owner = conn.execute(
            "SELECT id, display_name FROM users WHERE role = 'owner' AND pin_hash = ? AND (is_active = 1 OR is_active IS NULL)",
            (pin_hash,)
        ).fetchone()
        if not owner:
            return jsonify({'success': False, 'error': 'Invalid Owner PIN'}), 401

        rest_row = conn.execute("SELECT value FROM settings WHERE key = 'restaurant_name'").fetchone()
        rest_name = rest_row['value'] if rest_row else shop_id.upper()

        summary = conn.execute(
            """SELECT
                COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) AS paid_orders,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN grand_total ELSE 0 END), 0) AS net_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'cash' THEN grand_total ELSE 0 END), 0) AS cash_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'upi' THEN grand_total ELSE 0 END), 0) AS upi_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND payment_method = 'card' THEN grand_total ELSE 0 END), 0) AS card_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'dine_in' THEN grand_total ELSE 0 END), 0) AS dine_in_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel = 'takeaway' THEN grand_total ELSE 0 END), 0) AS takeaway_sales,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND channel IN ('swiggy', 'zomato') THEN grand_total ELSE 0 END), 0) AS delivery_sales
               FROM orders WHERE date(created_at) = ?""",
            (target_date,)
        ).fetchone()

        return jsonify({
            'success': True,
            'shop_id': shop_id,
            'restaurant_name': rest_name,
            'owner_name': owner['display_name'],
            'snapshot_file': filename,
            'date': target_date,
            'summary': dict(summary)
        })
    finally:
        conn.close()


OWNER_PORTAL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RestroKOT Cloud Owner Portal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 1rem; }
    .box { max-width: 520px; margin: 2rem auto; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 1.5rem; }
    h1 { font-size: 1.3rem; margin: 0 0 0.25rem 0; }
    p { font-size: 0.85rem; color: #94a3b8; margin: 0 0 1.25rem 0; }
    label { display: block; font-size: 0.78rem; font-weight: 700; color: #cbd5e1; margin-bottom: 0.3rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.65rem 0.85rem; border-radius: 10px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 0.95rem; margin-bottom: 0.85rem; }
    button { width: 100%; padding: 0.75rem; border-radius: 10px; border: none; background: #2563eb; color: #fff; font-weight: 800; font-size: 0.95rem; cursor: pointer; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 1rem; }
    .kpi { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 0.85rem; }
    .kpi span { font-size: 0.72rem; color: #94a3b8; display: block; }
    .kpi strong { font-size: 1.15rem; color: #38bdf8; }
    .err { color: #f87171; font-size: 0.85rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>RestroKOT Cloud Owner Portal</h1>
    <p>View daily sales from your Home Cloud Server</p>
    <form onsubmit="loadOwnerSummary(event)">
      <label>Shop ID</label>
      <input id="shop_id" value="shop1" required>
      <label>Owner PIN</label>
      <input id="pin" type="password" placeholder="••••" required>
      <label>Date</label>
      <input id="date" type="date">
      <button type="submit">View Sales Report</button>
    </form>
    <div id="err" class="err"></div>
    <div id="result" style="display:none; margin-top: 1.25rem;">
      <div id="rest_title" style="font-weight:800; font-size:1.05rem; color:#4ade80;"></div>
      <div id="snap_info" style="font-size:0.75rem; color:#94a3b8; margin-top:2px;"></div>
      <div class="grid">
        <div class="kpi"><span>Total Net Sales</span><strong id="k_sales">₹0</strong></div>
        <div class="kpi"><span>Paid Bills</span><strong id="k_bills">0</strong></div>
        <div class="kpi"><span>Cash</span><strong id="k_cash">₹0</strong></div>
        <div class="kpi"><span>UPI</span><strong id="k_upi">₹0</strong></div>
        <div class="kpi"><span>Card</span><strong id="k_card">₹0</strong></div>
        <div class="kpi"><span>Dine-In</span><strong id="k_dine">₹0</strong></div>
      </div>
    </div>
  </div>
  <script>
    document.getElementById('date').value = new Date().toISOString().slice(0, 10);
    async function loadOwnerSummary(e) {
      e.preventDefault();
      document.getElementById('err').textContent = '';
      const res = await fetch('/api/cloud-owner/summary', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          shop_id: document.getElementById('shop_id').value,
          pin: document.getElementById('pin').value,
          date: document.getElementById('date').value
        })
      });
      const d = await res.json();
      if (!d.success) {
        document.getElementById('err').textContent = d.error || 'Error';
        document.getElementById('result').style.display = 'none';
        return;
      }
      const s = d.summary;
      document.getElementById('rest_title').textContent = d.restaurant_name + ' (' + d.date + ')';
      document.getElementById('snap_info').textContent = 'Latest Snapshot: ' + d.snapshot_file;
      document.getElementById('k_sales').textContent = '₹' + Number(s.net_sales || 0).toFixed(2);
      document.getElementById('k_bills').textContent = s.paid_orders || 0;
      document.getElementById('k_cash').textContent = '₹' + Number(s.cash_sales || 0).toFixed(2);
      document.getElementById('k_upi').textContent = '₹' + Number(s.upi_sales || 0).toFixed(2);
      document.getElementById('k_card').textContent = '₹' + Number(s.card_sales || 0).toFixed(2);
      document.getElementById('k_dine').textContent = '₹' + Number(s.dine_in_sales || 0).toFixed(2);
      document.getElementById('result').style.display = 'block';
    }
  </script>
</body>
</html>"""


@app.route('/')
@app.route('/owner')
def owner_portal_page():
    return Response(OWNER_PORTAL_HTML, mimetype='text/html')


if __name__ == '__main__':
    print(f"RestroKOT Home Cloud Server listening on port {CLOUD_PORT}...")
    print(f"Storage directory: {STORAGE_DIR}")
    app.run(host='0.0.0.0', port=CLOUD_PORT, debug=False, threaded=True)
