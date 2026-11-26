# Modern Restaurant KOT & Multi-Display System (Multi-Monitor Single-System)

A modern, role-protected Kitchen Order Ticket (KOT), POS, Kitchen Display System (KDS), Service Expediter, and Dual Customer TV Display system engineered to run seamlessly on a **single computer connected to multiple monitors**.

---

## 🖥️ Multi-Monitor Single-System Setup

When you connect multiple monitors (e.g. HDMI 1, HDMI 2, HDMI 3, TV outputs) to the same computer:

```
                  ┌──────────────────────────────┐
                  │   Single Central Computer    │
                  │   (Python Flask + SQLite)    │
                  └──────────────┬───────────────┘
                                 │
     ┌──────────────┬────────────┼────────────┬──────────────┐
     ▼              ▼            ▼            ▼              ▼
[ Monitor 1 ]  [ Monitor 2 ] [ Monitor 3 ] [ Monitor 4 ]  [ Monitor 5 ]
 Manager POS    Kitchen KDS   Service Area   Dining TV     Takeaway TV
 (Desk Screen)  (Kitchen)     (Waiters)     (Public TV)   (Rider Lounge)
```

### 🔒 Per-Window Tab Isolation
Each monitor window maintains its own independent session in `sessionStorage` and headers.
**Opening Kitchen or Service on Monitor 2 will NEVER log out the Manager POS on Monitor 1!**

---

## 🚀 How to Launch on All Monitors

### Option A: From Browser
1. Open **[http://localhost:3000/launch](http://localhost:3000/launch)**.
2. Click **`🚀 Launch All 5 Station Windows`**.
3. Drag each window to its corresponding monitor:
   - Window 1 &rarr; Monitor 1 (Manager POS)
   - Window 2 &rarr; Monitor 2 (Kitchen KDS)
   - Window 3 &rarr; Monitor 3 (Service Expediter)
   - Window 4 &rarr; Monitor 4 (Dining Customer TV)
   - Window 5 &rarr; Monitor 5 (Takeaway TV)
4. Press <kbd>F11</kbd> (or <kbd>Ctrl+Cmd+F</kbd> on Mac) on each screen for borderless fullscreen kiosk mode.

### Option B: From Terminal (One-Click)
Run the launcher script:
```bash
./launch_monitors.sh
```

---

## 📍 Direct Station URLs & PINs

| Monitor | Station | Direct Isolated URL | Role PIN |
|---|---|---|---|
| **Monitor 1** | **Manager POS & Billing** | `http://localhost:3000/pos?pin=1234` | **`1234`** |
| **Monitor 2** | **Kitchen Display (KDS)** | `http://localhost:3000/kitchen?pin=2222` | **`2222`** |
| **Monitor 3** | **Service Area Expediter** | `http://localhost:3000/service?pin=3333` | **`3333`** |
| **Monitor 4** | **Dining TV Display** | `http://localhost:3000/display` | *Public (No PIN)* |
| **Monitor 5** | **Takeaway TV Display** | `http://localhost:3000/display?station=counter` | *Public (No PIN)* |
| **Any Screen** | **Central Launcher Hub** | `http://localhost:3000/launch` | — |

---

## 🍽️ Multi-Round Table Running Bills

1. **Table T-1 Seats & Orders Round 1**:
   - Bill #101 is created.
   - Kitchen receives ticket: `KOT-101-R1 (Round 1)`.
2. **Table T-1 Orders Again (Round 2 Add-Ons)**:
   - In POS, select Table T-1.
   - System detects running bill and prompts: `🟢 Table T-1 Running Order (Round 1 active)`.
   - Add new items (e.g. Biryani, Naan) and click **"PUNCH ROUND 2 KOT"**.
   - Result:
     - **Kitchen gets separate ticket**: `KOT-101-R2` with ONLY Round 2 items!
     - **Billing is on the SAME BILL**: Single consolidated total, unified GST & discount.
3. **Table T-1 Finishes & Settles**:
   - Click **"PRINT & SETTLE"** &rarr; prints 1 unified 80mm tax invoice with all items from all rounds, and Table T-1 becomes **Vacant**!
