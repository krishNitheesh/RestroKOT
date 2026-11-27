"""
Database layer for Modern Restaurant KOT System (Python Flask + SQLite).
Includes support for:
- Single consolidated running bills for tables (Dine-In)
- Multi-round KOT tickets (Round 1, Round 2, Add-ons)
- Role-based staff authentication (Manager, Kitchen, Service)
"""

import sqlite3
import os
import sys
import shutil
import hashlib
from datetime import datetime


def get_persistent_data_dir() -> str:
    """
    Resolve a permanent, writable data directory so updates or .exe temp extraction
    never cause data loss.
    - Explicit override: RESTROKOT_DATA_DIR env var
    - Frozen (.exe / .app): %LOCALAPPDATA%\\RestroKOT\\data on Windows (unless portable.flag exists next to exe)
    - Source mode: <project_root>/data
    """
    env_dir = os.environ.get('RESTROKOT_DATA_DIR', '').strip()
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir

    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        portable_flag = os.path.join(exe_dir, 'portable.flag')
        if os.path.exists(portable_flag):
            data_dir = os.path.join(exe_dir, 'data')
        elif sys.platform == 'win32':
            base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
            data_dir = os.path.join(base, 'RestroKOT', 'data')
        elif sys.platform == 'darwin':
            data_dir = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'RestroKOT', 'data')
        else:
            data_dir = os.path.join(os.path.expanduser('~'), '.local', 'share', 'RestroKOT', 'data')

        os.makedirs(data_dir, exist_ok=True)

        # First-run safety migration: if exe_dir/data/restaurant.db exists and target DB doesn't, copy it over
        target_db = os.path.join(data_dir, 'restaurant.db')
        legacy_db = os.path.join(exe_dir, 'data', 'restaurant.db')
        if not os.path.exists(target_db) and os.path.isfile(legacy_db):
            for suffix in ('', '-wal', '-shm'):
                src = legacy_db + suffix
                if os.path.isfile(src):
                    shutil.copy2(src, target_db + suffix)
        return data_dir

    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')


DB_DIR = get_persistent_data_dir()
DB_PATH = os.path.join(DB_DIR, 'restaurant.db')


def hash_pin(pin: str) -> str:
    """Hash a numeric PIN with sha256."""
    return hashlib.sha256(str(pin).strip().encode('utf-8')).hexdigest()


def get_db():
    """Return a connection with row_factory set to sqlite3.Row and 0% data-loss durability."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    conn.execute("PRAGMA wal_autocheckpoint = 100")
    return conn


def init_db():
    """Create directory, tables, indexes, and default seed data."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = get_db()
    c = conn.cursor()

    c.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,              -- 'manager', 'kitchen', 'service', 'captain', 'owner'
        display_name TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_by TEXT DEFAULT 'Manager',
        message TEXT NOT NULL,
        synced_to_cloud INTEGER DEFAULT 0,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        icon TEXT DEFAULT '🍽️',
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL NOT NULL,
        food_type TEXT DEFAULT 'veg',     -- 'veg', 'non_veg', 'egg'
        is_available INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,     -- soft-delete
        FOREIGN KEY (category_id) REFERENCES categories (id)
    );

    CREATE TABLE IF NOT EXISTS dining_tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        section TEXT DEFAULT 'AC Hall',
        capacity INTEGER DEFAULT 4,
        is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL UNIQUE,
        token_number INTEGER NOT NULL,
        channel TEXT NOT NULL,
        table_name TEXT,
        waiter_name TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        online_order_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        payment_method TEXT DEFAULT 'cash',
        subtotal REAL NOT NULL DEFAULT 0,
        discount_type TEXT DEFAULT 'percentage',
        discount_value REAL DEFAULT 0,
        discount_amount REAL DEFAULT 0,
        cgst_rate REAL DEFAULT 2.5,
        cgst_amount REAL DEFAULT 0,
        sgst_rate REAL DEFAULT 2.5,
        sgst_amount REAL DEFAULT 0,
        round_off REAL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        ready_at DATETIME,
        served_at DATETIME,
        cancelled_at DATETIME,
        cancel_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS kot_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        kot_number TEXT NOT NULL UNIQUE,
        round_number INTEGER DEFAULT 1,
        channel TEXT NOT NULL,
        table_name TEXT,
        waiter_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        ready_at DATETIME,
        served_at DATETIME,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        kot_ticket_id INTEGER,
        round_number INTEGER DEFAULT 1,
        menu_item_id INTEGER,
        item_name TEXT NOT NULL,
        price REAL NOT NULL,
        quantity INTEGER NOT NULL,
        food_type TEXT DEFAULT 'veg',
        notes TEXT DEFAULT '',
        is_ready INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending_approval',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
        FOREIGN KEY (kot_ticket_id) REFERENCES kot_tickets (id) ON DELETE SET NULL
    );
    """)

    # Safe migrations
    for col, defn in [('kot_ticket_id', 'INTEGER'), ('round_number', 'INTEGER DEFAULT 1'), ('status', 'TEXT DEFAULT \'pending_approval\'')]:
        try:
            c.execute(f"ALTER TABLE order_items ADD COLUMN {col} {defn}")
        except sqlite3.OperationalError:
            pass

    c.executescript("""
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_name, payment_status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status, created_at);
    CREATE INDEX IF NOT EXISTS idx_kot_tickets_status ON kot_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_kot ON order_items(kot_ticket_id);

    CREATE TABLE IF NOT EXISTS daily_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_date TEXT NOT NULL UNIQUE,
        settled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        settled_by TEXT NOT NULL,
        total_orders INTEGER NOT NULL DEFAULT 0,
        paid_orders INTEGER NOT NULL DEFAULT 0,
        cancelled_orders INTEGER NOT NULL DEFAULT 0,
        unpaid_orders INTEGER NOT NULL DEFAULT 0,
        gross_sales REAL NOT NULL DEFAULT 0.0,
        discount_amount REAL NOT NULL DEFAULT 0.0,
        tax_amount REAL NOT NULL DEFAULT 0.0,
        round_off REAL NOT NULL DEFAULT 0.0,
        net_sales REAL NOT NULL DEFAULT 0.0,
        cash_sales REAL NOT NULL DEFAULT 0.0,
        upi_sales REAL NOT NULL DEFAULT 0.0,
        card_sales REAL NOT NULL DEFAULT 0.0,
        dine_in_sales REAL NOT NULL DEFAULT 0.0,
        takeaway_sales REAL NOT NULL DEFAULT 0.0,
        delivery_sales REAL NOT NULL DEFAULT 0.0,
        opening_float REAL NOT NULL DEFAULT 0.0,
        petty_expenses REAL NOT NULL DEFAULT 0.0,
        actual_cash REAL NOT NULL DEFAULT 0.0,
        cash_variance REAL NOT NULL DEFAULT 0.0,
        denominations_json TEXT DEFAULT '{}',
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'settled'
    );

    CREATE TABLE IF NOT EXISTS cash_handovers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handover_date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        shift_name TEXT DEFAULT 'Full Day Close',
        handed_by TEXT NOT NULL,
        received_by TEXT NOT NULL,
        opening_float REAL NOT NULL DEFAULT 0.0,
        system_cash_sales REAL NOT NULL DEFAULT 0.0,
        petty_expenses REAL NOT NULL DEFAULT 0.0,
        expected_cash REAL NOT NULL DEFAULT 0.0,
        actual_cash REAL NOT NULL DEFAULT 0.0,
        variance REAL NOT NULL DEFAULT 0.0,
        denominations_json TEXT DEFAULT '{}',
        notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cloud_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_filename TEXT NOT NULL UNIQUE,
        file_size INTEGER DEFAULT 0,
        sha256 TEXT,
        total_orders INTEGER DEFAULT 0,
        paid_orders INTEGER DEFAULT 0,
        net_sales REAL DEFAULT 0.0,
        trigger_type TEXT DEFAULT 'manual', -- 'manual', 'settlement', 'hourly'
        cloud_status TEXT DEFAULT 'synced',  -- 'synced', 'local_only', 'pending'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        pushed_by TEXT DEFAULT 'Manager',
        notes TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_daily_settlements_date ON daily_settlements(settlement_date);
    CREATE INDEX IF NOT EXISTS idx_cash_handovers_date ON cash_handovers(handover_date);
    CREATE INDEX IF NOT EXISTS idx_cloud_backups_created ON cloud_backups(created_at);
    """)

    # Safe migration for users table: remove UNIQUE constraint on role to allow multiple captains with custom names
    user_table_sql = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
    if user_table_sql and ('role TEXT NOT NULL UNIQUE' in user_table_sql[0] or 'role TEXT NOT NULL  UNIQUE' in user_table_sql[0]):
        c.executescript("""
            CREATE TABLE users_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                display_name TEXT NOT NULL,
                pin_hash TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO users_migrated (id, role, display_name, pin_hash, created_at)
            SELECT id, role, display_name, pin_hash, created_at FROM users;
            DROP TABLE users;
            ALTER TABLE users_migrated RENAME TO users;
            CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        """)

    # Ensure is_active column exists on users
    user_cols = [r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
    if 'is_active' not in user_cols:
        c.execute("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1")

    # Seed default staff users if empty
    c.execute("SELECT COUNT(*) AS c FROM users")
    if c.fetchone()['c'] == 0:
        default_users = [
            ('owner', 'Restaurant Owner', hash_pin('9999')),
            ('manager', 'Manager', hash_pin('1234')),
            ('kitchen', 'Kitchen Chef', hash_pin('2222')),
            ('service', 'Service Captain', hash_pin('3333')),
            ('captain', 'Order Captain', hash_pin('4444')),
        ]
        c.executemany(
            "INSERT INTO users (role, display_name, pin_hash) VALUES (?, ?, ?)",
            default_users
        )
    else:
        # Ensure owner user exists in existing database
        c.execute("SELECT id FROM users WHERE role = 'owner'")
        if not c.fetchone():
            c.execute(
                "INSERT INTO users (role, display_name, pin_hash) VALUES (?, ?, ?)",
                ('owner', 'Restaurant Owner', hash_pin('9999'))
            )

        # Ensure captain user exists in existing database
        c.execute("SELECT id FROM users WHERE role = 'captain'")
        if not c.fetchone():
            c.execute(
                "INSERT INTO users (role, display_name, pin_hash) VALUES (?, ?, ?)",
                ('captain', 'Order Captain', hash_pin('4444'))
            )

    # Ensure daily_settlements has cash reconciliation columns in existing DBs
    existing_settle_cols = [r[1] for r in c.execute("PRAGMA table_info(daily_settlements)").fetchall()]
    for col_name, col_type in [
        ('opening_float', 'REAL NOT NULL DEFAULT 0.0'),
        ('petty_expenses', 'REAL NOT NULL DEFAULT 0.0'),
        ('actual_cash', 'REAL NOT NULL DEFAULT 0.0'),
        ('cash_variance', 'REAL NOT NULL DEFAULT 0.0'),
        ('denominations_json', "TEXT DEFAULT '{}'")
    ]:
        if col_name not in existing_settle_cols:
            c.execute(f"ALTER TABLE daily_settlements ADD COLUMN {col_name} {col_type}")

    # Seed default settings (clean fresh install - no dummy restaurant or cloud keys)
    default_settings = [
        ('restaurant_name', 'My Restaurant'),
        ('tagline', ''),
        ('address', ''),
        ('phone', ''),
        ('gstin', ''),
        ('fssai', ''),
        ('currency_symbol', '₹'),
        ('cgst_rate', '2.5'),
        ('sgst_rate', '2.5'),
        ('token_counter_start', '101'),
        ('upi_id', ''),
        ('cloud_provider', 'webhook_http'),
        ('cloud_vault_path', ''),
        ('cloud_endpoint_url', ''),
        ('cloud_shop_id', ''),
        ('cloud_api_key', ''),
        ('cloud_auto_settle', '1'),
        ('cloud_auto_hourly', '1'),
        ('cloud_last_push', ''),
        ('cloud_last_pull', ''),
        ('menu_seeded', '1'),
    ]
    for k, v in default_settings:
        c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))

    # Seed categories if empty
    c.execute("SELECT COUNT(*) AS c FROM categories")
    if c.fetchone()['c'] == 0:
        categories = [
            ('Starters & Appetizers', 'starters', '🍗', 1),
            ('Tandoor & Kebabs', 'tandoor', '🔥', 2),
            ('Biryani & Rice Bowls', 'biryani', '🍚', 3),
            ('Main Course Curries', 'curries', '🍲', 4),
            ('Breads & Rotis', 'breads', '🫓', 5),
            ('South Indian Specials', 'south_indian', '🥞', 6),
            ('Chinese & Indo-Asian', 'chinese', '🍜', 7),
            ('Beverages & Mocktails', 'beverages', '🍹', 8),
            ('Desserts & Sweets', 'desserts', '🍨', 9),
        ]
        c.executemany(
            "INSERT INTO categories (name, code, icon, sort_order) VALUES (?, ?, ?, ?)",
            categories
        )

    # Seed menu items if empty and not previously seeded
    is_seeded = c.execute("SELECT value FROM settings WHERE key = 'menu_seeded'").fetchone()
    if not is_seeded:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('menu_seeded', '1')")
        c.execute("SELECT COUNT(*) AS c FROM menu_items")
        if c.fetchone()['c'] == 0:
            c.execute("SELECT id, code FROM categories")
            cat_map = {row['code']: row['id'] for row in c.fetchall()}

        items = [
            # Starters
            ('starters', 'Paneer 65 Crispy', 'Crispy cottage cheese tossed in aromatic spices', 210, 'veg'),
            ('starters', 'Gobi Manchurian Dry', 'Indo-Chinese spiced crisp cauliflower florets', 180, 'veg'),
            ('starters', 'Chicken 65 Special', 'Deep-fried spicy chicken bites with curry leaves', 260, 'non_veg'),
            ('starters', 'Dragon Chicken', 'Crispy shredded chicken strips in chili honey glaze', 280, 'non_veg'),
            ('starters', 'Crispy Corn Salt & Pepper', 'Golden sweet corn with freshly cracked peppercorn', 170, 'veg'),
            ('starters', 'Egg Bonda (3 Pcs)', 'Spiced boiled egg wrapped in golden gram batter', 120, 'egg'),
            # Tandoor
            ('tandoor', 'Paneer Tikka Angara', 'Clay oven charred cottage cheese cubes in spiced marinade', 250, 'veg'),
            ('tandoor', 'Tandoori Chicken (Half)', 'Traditional spiced chicken roasted in clay oven', 320, 'non_veg'),
            ('tandoor', 'Tandoori Chicken (Full)', 'Whole tandoor roasted tender chicken', 580, 'non_veg'),
            ('tandoor', 'Murgh Malai Kebab', 'Creamy melt-in-mouth chicken infused with cardamom', 310, 'non_veg'),
            ('tandoor', 'Mutton Seekh Kebab', 'Minced spiced mutton skewers chargrilled to perfection', 360, 'non_veg'),
            # Biryani
            ('biryani', 'Hyderabadi Dum Chicken Biryani', 'Basmati rice cooked with marinated chicken & saffron', 280, 'non_veg'),
            ('biryani', 'Special Mutton Dum Biryani', 'Tender baby goat pieces cooked under sealed dum', 380, 'non_veg'),
            ('biryani', 'Paneer Makhani Biryani', 'Basmati rice layered with spiced paneer tikka & herbs', 240, 'veg'),
            ('biryani', 'Egg Dum Biryani', 'Golden roasted eggs with spiced aromatic biryani rice', 210, 'egg'),
            ('biryani', 'Jeera Rice & Dal Tadka Combo', 'Fragrant cumin basmati served with yellow lentils', 200, 'veg'),
            # Curries
            ('curries', 'Butter Chicken Masala', 'Tandoori chicken pulled in silky tomato cream gravy', 310, 'non_veg'),
            ('curries', 'Paneer Butter Masala', 'Fresh paneer in rich buttery cashew tomato gravy', 250, 'veg'),
            ('curries', 'Kadai Chicken Semi-Gravy', 'Chicken wok-tossed with capsicum, onions, spices', 290, 'non_veg'),
            ('curries', 'Dal Makhani Dum Pukht', 'Slow-simmered black lentils with butter and cream', 220, 'veg'),
            ('curries', 'Mutton Rogan Josh', 'Kashmiri style aromatic tender mutton curry', 390, 'non_veg'),
            ('curries', 'Mix Veg Kolhapuri', 'Assorted seasonal vegetables in roasted coconut gravy', 210, 'veg'),
            # Breads
            ('breads', 'Butter Naan', 'Tandoori flatbread brushed with fresh dairy butter', 50, 'veg'),
            ('breads', 'Garlic Butter Naan', 'Fluffy tandoori naan topped with toasted garlic', 70, 'veg'),
            ('breads', 'Tandoori Roti (Butter)', 'Whole wheat tandoori flatbread with butter', 35, 'veg'),
            ('breads', 'Laccha Paratha', 'Multi-layered crispy flaky tandoori flatbread', 60, 'veg'),
            ('breads', 'Malabar Parotta (2 Pcs)', 'Kerala style layered soft flaky griddle bread', 70, 'veg'),
            # South Indian
            ('south_indian', 'Ghee Roast Dosa', 'Golden crispy crepe roasted with pure desi ghee', 110, 'veg'),
            ('south_indian', 'Mysore Masala Dosa', 'Crisp dosa smeared with red garlic chutney & masala', 130, 'veg'),
            ('south_indian', 'Idli Vada Platter (2+1)', 'Steamed fluffy rice cakes and crisp medu vada', 90, 'veg'),
            ('south_indian', 'Curd Rice with Pomegranate', 'Tempered seasoned yogurt rice with mustard & curry leaves', 120, 'veg'),
            # Chinese
            ('chinese', 'Veg Hakka Noodles', 'Stir-fried noodles with julienned veggies in light soy', 190, 'veg'),
            ('chinese', 'Chicken Schezwan Fried Rice', 'Spicy wok tossed basmati rice with fiery red sauce', 240, 'non_veg'),
            ('chinese', 'Chilli Chicken Gravy', 'Diced chicken, peppers and green chilies in savory dark sauce', 270, 'non_veg'),
            # Beverages
            ('beverages', 'Fresh Lime Soda (Sweet/Salt)', 'Sparkling refreshed lime cooler', 70, 'veg'),
            ('beverages', 'Mango Lassi Premium', 'Thick churned creamy yogurt blended with Alphonso pulp', 110, 'veg'),
            ('beverages', 'South Indian Filter Coffee', 'Freshly decocted chicory blend with frothy milk', 50, 'veg'),
            ('beverages', 'Masala Chai Pot', 'Ginger and cardamom infused hot milk tea', 40, 'veg'),
            ('beverages', 'Mineral Water (1L)', 'Packaged drinking water', 30, 'veg'),
            # Desserts
            ('desserts', 'Gulab Jamun with Ice Cream', 'Warm milk dumplings soaked in rose syrup with vanilla', 110, 'veg'),
            ('desserts', 'Matka Kulfi Royal', 'Traditional slow-reduced saffron pistachio frozen dessert', 120, 'veg'),
            ('desserts', 'Sizzling Brownie with Vanilla', 'Warm fudge brownie on sizzling cast-iron with hot chocolate', 180, 'veg'),
        ]

        for cat_code, name, desc, price, food_type in items:
            cat_id = cat_map.get(cat_code)
            if cat_id:
                c.execute(
                    """INSERT INTO menu_items (category_id, name, description, price, food_type, is_available)
                       VALUES (?, ?, ?, ?, ?, 1)""",
                    (cat_id, name, desc, price, food_type)
                )

    # Seed dining tables if empty
    c.execute("SELECT COUNT(*) AS c FROM dining_tables")
    if c.fetchone()['c'] == 0:
        tables = [
            ('T-1', 'AC Hall', 2),
            ('T-2', 'AC Hall', 4),
            ('T-3', 'AC Hall', 4),
            ('T-4', 'AC Hall', 6),
            ('T-5', 'AC Hall', 6),
            ('T-6', 'AC Hall', 4),
            ('T-7', 'Family Section', 8),
            ('T-8', 'Family Section', 8),
            ('T-9', 'Garden Outdoor', 4),
            ('T-10', 'Garden Outdoor', 4),
            ('T-11', 'Garden Outdoor', 6),
            ('T-12', 'Garden Outdoor', 6),
            ('VIP-1', 'Private Dining', 10),
            ('VIP-2', 'Private Dining', 12),
        ]
        c.executemany(
            "INSERT INTO dining_tables (name, section, capacity) VALUES (?, ?, ?)",
            tables
        )

    conn.commit()
    conn.close()


def get_settings_dict():
    """Return all settings as a plain key-value dict."""
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return {r['key']: r['value'] for r in rows}


def update_settings(updates: dict):
    conn = get_db()
    with conn:
        for k, v in updates.items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, str(v))
            )
    conn.close()


def get_next_token_number():
    """Daily rolling token number (101, 102, ...)."""
    conn = get_db()
    row = conn.execute(
        """SELECT MAX(token_number) AS max_token FROM orders
           WHERE date(created_at) = date('now', 'localtime')"""
    ).fetchone()
    conn.close()
    if row and row['max_token'] and row['max_token'] >= 101:
        return row['max_token'] + 1
    return 101


def get_active_order_for_table(table_name: str):
    """Find unpaid/active running order for a specific table."""
    conn = get_db()
    row = conn.execute(
        """SELECT * FROM orders
           WHERE channel = 'dine_in'
             AND table_name = ?
             AND payment_status = 'unpaid'
             AND status NOT IN ('cancelled', 'completed')
           ORDER BY id DESC LIMIT 1""",
        (table_name,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# -------------------------------------------------------------
# CAPTAINS & WAITER STAFF HELPERS
# -------------------------------------------------------------

def get_captains():
    """Return all active captains/waiters."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, role, display_name, is_active, created_at FROM users WHERE role = 'captain' AND is_active = 1 ORDER BY id ASC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_captain(display_name: str, pin: str):
    """Add a new captain with custom name and personal PIN."""
    name = display_name.strip()
    if not name:
        raise ValueError("Captain name cannot be empty")
    pin_str = str(pin).strip()
    if len(pin_str) < 4:
        raise ValueError("PIN must be at least 4 digits")

    conn = get_db()
    with conn:
        cur = conn.execute(
            "INSERT INTO users (role, display_name, pin_hash, is_active) VALUES ('captain', ?, ?, 1)",
            (name, hash_pin(pin_str))
        )
        new_id = cur.lastrowid
    conn.close()
    return new_id


def update_captain(user_id: int, display_name: str, pin: str = None):
    """Update captain name and optionally PIN."""
    name = display_name.strip()
    if not name:
        raise ValueError("Captain name cannot be empty")

    conn = get_db()
    with conn:
        if pin and len(str(pin).strip()) >= 4:
            conn.execute(
                "UPDATE users SET display_name = ?, pin_hash = ? WHERE id = ? AND role = 'captain'",
                (name, hash_pin(str(pin).strip()), user_id)
            )
        else:
            conn.execute(
                "UPDATE users SET display_name = ? WHERE id = ? AND role = 'captain'",
                (name, user_id)
            )
    conn.close()


def delete_captain(user_id: int):
    """Soft delete / deactivate a captain."""
    conn = get_db()
    with conn:
        conn.execute("UPDATE users SET is_active = 0 WHERE id = ? AND role = 'captain'", (user_id,))
    conn.close()


def checkpoint_db():
    """Flush all WAL frames into the main SQLite database file (0% data-loss shutdown)."""
    if not os.path.isfile(DB_PATH):
        return
    try:
        conn = sqlite3.connect(DB_PATH, timeout=15.0)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
    except Exception:
        pass


def create_startup_safety_backup(max_keep: int = 10):
    """Create an atomic rolling local backup on startup so unexpected crashes never lose history."""
    if not os.path.isfile(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        return None
    backup_dir = os.path.join(DB_DIR, 'auto_backups')
    os.makedirs(backup_dir, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest_path = os.path.join(backup_dir, f'startup_{ts}.db')
    try:
        src = sqlite3.connect(DB_PATH, timeout=15.0)
        dst = sqlite3.connect(dest_path)
        src.backup(dst)
        dst.close()
        src.close()

        # Prune old startup backups beyond max_keep
        files = sorted(
            [f for f in os.listdir(backup_dir) if f.startswith('startup_') and f.endswith('.db')],
            reverse=True
        )
        for old_file in files[max_keep:]:
            try:
                os.remove(os.path.join(backup_dir, old_file))
            except Exception:
                pass
        return dest_path
    except Exception:
        return None


