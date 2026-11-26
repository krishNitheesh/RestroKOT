"""
RestroKOT Desktop App Runner for Windows (.exe) & Mac
Launches background Flask + SSE + Intercom WebSocket server and opens a native desktop window.
Guaranteed 0% data loss: persistent AppData storage, SQLite WAL + FULL sync, and clean WAL checkpoint on exit.
"""
import os
import sys
import time
import threading
import socket
import webbrowser
import logging

import db


def setup_logging():
    """Log desktop runner output to persistent data directory (and fix None stdout/stderr in Windows console=False .exe)."""
    os.makedirs(db.DB_DIR, exist_ok=True)
    log_path = os.path.join(db.DB_DIR, 'restrokot_desktop.log')

    # Crucial for PyInstaller console=False on Windows where sys.stdout / sys.stderr are None
    if sys.stdout is None:
        sys.stdout = open(log_path, 'a', encoding='utf-8', buffering=1)
    if sys.stderr is None:
        sys.stderr = open(log_path, 'a', encoding='utf-8', buffering=1)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
        handlers=[
            logging.FileHandler(log_path, encoding='utf-8'),
            logging.StreamHandler(sys.stdout)
        ]
    )


def show_windows_error(title: str, message: str):
    """Show a visible Windows alert dialog if startup fails in console=False mode."""
    if sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)
        except Exception:
            pass


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def start_server():
    """Start Flask + Intercom WebSocket server in background thread."""
    try:
        from app import app, _start_intercom_server
        intercom_port = int(os.environ.get('INTERCOM_PORT', 3001))
        if not is_port_in_use(intercom_port):
            _start_intercom_server(intercom_port)
        port = int(os.environ.get('PORT', 3000))
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False, threaded=True)
    except Exception as e:
        logging.exception(f"Server startup error: {e}")


def get_local_ip() -> str:
    """Get LAN IP address for Wi-Fi devices (Captain / Kitchen / TVs)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def wait_for_server(port: int, timeout: float = 15.0) -> bool:
    """Wait until the local Flask server is accepting connections."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_port_in_use(port):
            return True
        time.sleep(0.15)
    return False


def main():
    setup_logging()
    port = int(os.environ.get('PORT', 3000))

    logging.info("=" * 60)
    logging.info("RestroKOT Desktop App Starting")
    logging.info(f"Persistent Database: {db.DB_PATH}")
    logging.info("=" * 60)

    owns_server = False
    if not is_port_in_use(port):
        owns_server = True
        logging.info(f"Starting RestroKOT server on port {port}...")
        t = threading.Thread(target=start_server, daemon=True)
        t.start()
        if not wait_for_server(port, timeout=15.0):
            logging.error("Timed out waiting for RestroKOT server to bind port 3000.")
            show_windows_error(
                "RestroKOT Startup Error",
                f"Could not start RestroKOT server on port {port}.\n\nCheck log file:\n{os.path.join(db.DB_DIR, 'restrokot_desktop.log')}"
            )
    else:
        logging.info(f"RestroKOT server is already active on port {port} (reusing existing instance).")

    local_ip = get_local_ip()
    target_url = f"http://127.0.0.1:{port}/pos"
    logging.info(f"Cashier POS:    {target_url}")
    logging.info(f"Captain Mobile: http://{local_ip}:{port}/captain")
    logging.info(f"Kitchen KDS:    http://{local_ip}:{port}/kitchen")

    # Launch native desktop window with pywebview (Edge WebView2 on Windows)
    try:
        import webview
        logging.info("Launching native desktop window (pywebview)...")
        webview.create_window(
            title="RestroKOT - Restaurant POS & KDS Suite",
            url=target_url,
            width=1366,
            height=860,
            min_size=(1024, 650),
            confirm_close=True
        )
        webview.start()
        logging.info("RestroKOT window closed by user.")
    except Exception as e:
        logging.warning(f"pywebview unavailable or failed ({e}). Falling back to Edge App Mode / browser...")
        if sys.platform == 'win32':
            rc = os.system(f'start "" msedge --app="{target_url}"')
            if rc != 0:
                webbrowser.open(target_url)
        else:
            webbrowser.open(target_url)

        if owns_server:
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                logging.info("Shutting down.")
    finally:
        if owns_server:
            logging.info("Checkpointing SQLite WAL to disk before exit (0% data loss)...")
            db.checkpoint_db()
            logging.info("Checkpoint complete. Exiting cleanly.")
        sys.exit(0)


if __name__ == '__main__':
    main()
