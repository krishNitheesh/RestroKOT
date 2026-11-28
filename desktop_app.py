"""
RestroKOT Desktop & LAN Server Runner for Windows (.exe) & Mac
Starts the Flask + SSE + Intercom WebSocket server (0% data-loss SQLite WAL)
and opens the POS in a clean borderless App Window (Microsoft Edge / Chrome App Mode).
"""
import os
import sys
import time
import signal
import threading
import socket
import subprocess
import webbrowser
import logging

import db


def setup_logging():
    """Log desktop runner output to persistent data directory."""
    os.makedirs(db.DB_DIR, exist_ok=True)
    log_path = os.path.join(db.DB_DIR, 'restrokot_desktop.log')
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


def open_app_window(url: str):
    """Open RestroKOT in a clean borderless App Window (Edge/Chrome App Mode) or default browser."""
    if sys.platform == 'win32':
        # Try common Windows Edge and Chrome paths for borderless --app mode
        candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
        for exe in candidates:
            if os.path.isfile(exe):
                try:
                    subprocess.Popen([exe, "--kiosk-printing", f"--app={url}"])
                    return
                except Exception:
                    pass
        # Fallback to shell start msedge or default browser
        rc = os.system(f'start "" msedge --kiosk-printing --app="{url}"')
        if rc != 0:
            webbrowser.open(url)
    else:
        webbrowser.open(url)


def main():
    setup_logging()
    port = int(os.environ.get('PORT', 3000))

    owns_server = False
    if not is_port_in_use(port):
        owns_server = True
        t = threading.Thread(target=start_server, daemon=True)
        t.start()
        if not wait_for_server(port, timeout=15.0):
            print(f"[ERROR] Timed out waiting for RestroKOT server on port {port}.")
            input("Press Enter to exit...")
            sys.exit(1)

    local_ip = get_local_ip()
    local_url = f"http://127.0.0.1:{port}/login"
    lan_url = f"http://{local_ip}:{port}/login"

    print("=" * 64)
    print("  RestroKOT - Restaurant POS & KDS Server (RUNNING)")
    print("=" * 64)
    print(f"  This PC App:       {local_url}")
    print(f"  Wi-Fi / LAN Link:  {lan_url}")
    print(f"  Database (Safe):   {db.DB_PATH}")
    print("-" * 64)
    print("  Keep this window open while the restaurant is operating.")
    print("  Other PCs, Tablets, Phones & TVs on Wi-Fi can open:")
    print(f"  -> {lan_url}")
    print("=" * 64)

    open_app_window(local_url)

    def shutdown_handler(signum=None, frame=None):
        if owns_server:
            print("\nSaving & checkpointing database (0% data loss)...")
            db.checkpoint_db()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    if owns_server:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            shutdown_handler()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        import traceback
        traceback.print_exc()
        logging.exception(f"Fatal error in desktop_app: {exc}")
        try:
            input("\n[RestroKOT Error] Press Enter to close...")
        except Exception:
            pass
        sys.exit(1)
