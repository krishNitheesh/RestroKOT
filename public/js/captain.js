/**
 * Captain Order Terminal Logic - RestroKOT
 * Optimized for Mobile Phones & Tablets on Floor
 */

let captainState = {
  captainName: localStorage.getItem('captain_name') || 'Captain',
  tables: [],
  categories: [],
  menuItems: [],
  activeOrders: [],
  selectedSection: 'all',
  selectedTable: null,
  selectedTableOrder: null,
  activeCategory: 'all',
  dietaryFilter: 'all',
  searchQuery: '',
  cart: [] // [{ id, name, price, quantity, food_type, notes }]
};

// ----------------- INITIALIZATION & SYNC ----------------- //

async function initCaptain() {
  try {
    const authRes = await fetch('/api/auth/me');
    const authData = await authRes.json();
    if (authData.authenticated && authData.display_name) {
      captainState.captainName = authData.display_name;
    } else if (sessionStorage.getItem('station_user_name')) {
      captainState.captainName = sessionStorage.getItem('station_user_name');
    }
  } catch (e) {}
  updateCaptainNameBadge();
  await Promise.all([
    loadTablesData(),
    loadMenuData(),
    loadActiveOrders()
  ]);

  // Live real-time updates via WebSocket / SSE
  kotSocket.on('*', () => {
    loadActiveOrders();
    if (captainState.selectedTable) {
      refreshSelectedTableOrder();
    }
  });

  // Poll fallback every 3.5s
  setInterval(() => {
    loadActiveOrders();
    if (captainState.selectedTable) {
      refreshSelectedTableOrder();
    }
  }, 3500);
}

function updateCaptainNameBadge() {
  const lbl = document.getElementById('captain-name-label');
  if (lbl) lbl.textContent = captainState.captainName;
}

function promptChangeCaptain() {
  const name = prompt('Enter your name / Captain ID:', captainState.captainName);
  if (name && name.trim()) {
    captainState.captainName = name.trim();
    localStorage.setItem('captain_name', captainState.captainName);
    updateCaptainNameBadge();
    showToast(`Captain set to ${captainState.captainName}`, 'info');
  }
}

// ----------------- DATA LOADING ----------------- //

async function loadTablesData() {
  try {
    const res = await fetch('/api/tables');
    const data = await res.json();
    if (data.success) {
      captainState.tables = (data.tables || []).filter(t => t.is_active);
      renderSectionPills();
      renderTablesGrid();
    }
  } catch (e) {
    console.error('Failed to load tables:', e);
  }
}

async function loadMenuData() {
  try {
    const res = await fetch('/api/menu');
    const data = await res.json();
    if (data.success) {
      captainState.categories = data.categories || [];
      captainState.menuItems = (data.items || []).filter(i => i.is_available);
      renderCategoryPills();
      renderDishesList();
    }
  } catch (e) {
    console.error('Failed to load menu:', e);
  }
}

async function loadActiveOrders() {
  try {
    const res = await fetch('/api/orders?filter=active');
    const data = await res.json();
    if (data.success) {
      captainState.activeOrders = data.orders || [];
      updateFloorSummary();
      renderTablesGrid();
    }
  } catch (e) {
    console.error('Failed to load active orders:', e);
  }
}

function updateFloorSummary() {
  const summaryEl = document.getElementById('captain-floor-summary');
  if (!summaryEl) return;

  const total = captainState.tables.length;
  const occupiedNames = new Set(
    captainState.activeOrders
      .filter(o => o.channel === 'dine_in' && o.table_name && o.payment_status === 'unpaid')
      .map(o => o.table_name.toUpperCase())
  );

  const occCount = occupiedNames.size;
  const vacCount = Math.max(0, total - occCount);

  summaryEl.innerHTML = `
    <span style="color: #16a34a; font-weight: 800;">🟢 ${vacCount} Vacant</span> • 
    <span style="color: #ea580c; font-weight: 800;">🟠 ${occCount} Occupied</span>
  `;
}

// ----------------- VIEW 1: FLOOR TABLES ----------------- //

function renderSectionPills() {
  const container = document.getElementById('captain-section-pills');
  if (!container) return;

  const sections = ['all', ...new Set(captainState.tables.map(t => t.section || 'General'))];
  container.innerHTML = '';

  sections.forEach(sec => {
    const btn = document.createElement('button');
    btn.className = `restro-pill ${captainState.selectedSection === sec ? 'active' : ''}`;
    btn.textContent = sec === 'all' ? 'All Tables' : sec;
    btn.onclick = () => filterTablesBySection(sec);
    container.appendChild(btn);
  });
}

function filterTablesBySection(sec) {
  captainState.selectedSection = sec;
  document.querySelectorAll('#captain-section-pills .restro-pill').forEach(b => {
    b.classList.toggle('active', b.textContent === (sec === 'all' ? 'All Tables' : sec));
  });
  renderTablesGrid();
}

function renderTablesGrid() {
  const container = document.getElementById('captain-tables-container');
  if (!container) return;

  const occupiedMap = new Map();
  captainState.activeOrders.forEach(o => {
    if (o.channel === 'dine_in' && o.table_name && o.payment_status === 'unpaid') {
      occupiedMap.set(o.table_name.toUpperCase(), o);
    }
  });

  let tables = captainState.tables;
  if (captainState.selectedSection !== 'all') {
    tables = tables.filter(t => (t.section || 'General') === captainState.selectedSection);
  }

  container.innerHTML = '';
  tables.forEach(tbl => {
    const activeOrder = occupiedMap.get(tbl.name.toUpperCase());
    const isOccupied = Boolean(activeOrder);

    const card = document.createElement('div');
    card.className = `captain-table-card ${isOccupied ? 'occupied' : 'vacant'}`;
    card.onclick = () => selectTable(tbl.name);

    let statusHtml = '';
    if (isOccupied) {
      const itemsCount = (activeOrder.items || []).reduce((acc, i) => acc + (i.quantity || 1), 0);
      statusHtml = `
        <div class="captain-table-status" style="color: #c2410c;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #ea580c; display: inline-block;"></span>
          Bill #${activeOrder.order_number} (${itemsCount} items)
        </div>
        <div class="captain-table-total">₹${Number(activeOrder.grand_total || 0).toFixed(2)}</div>
      `;
    } else {
      statusHtml = `
        <div class="captain-table-status" style="color: #15803d;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block;"></span>
          Vacant (${tbl.capacity || 4} Seats)
        </div>
        <div style="font-size: 0.72rem; color: #16a34a; font-weight: 700; margin-top: 4px;">+ Take Order</div>
      `;
    }

    card.innerHTML = `
      <div>
        <div class="captain-table-name">${tbl.name}</div>
        <div style="font-size: 0.7rem; color: #64748b;">${tbl.section || 'Hall'}</div>
      </div>
      <div>
        ${statusHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

// ----------------- VIEW SWITCHING & TABLE SELECTION ----------------- //

async function selectTable(tableName) {
  captainState.selectedTable = tableName;
  captainState.cart = [];

  const tablesView = document.getElementById('captain-view-tables');
  const menuView = document.getElementById('captain-view-menu');
  const titleEl = document.getElementById('selected-table-title');
  const statusEl = document.getElementById('selected-table-status-label');

  if (tablesView) tablesView.classList.add('hidden');
  if (menuView) menuView.classList.remove('hidden');
  if (titleEl) titleEl.textContent = `Table ${tableName}`;

  await refreshSelectedTableOrder();
  renderDishesList();
  updateCartUI();
}

function showTablesView() {
  captainState.selectedTable = null;
  captainState.selectedTableOrder = null;
  captainState.cart = [];

  const tablesView = document.getElementById('captain-view-tables');
  const menuView = document.getElementById('captain-view-menu');
  const bottomBar = document.getElementById('captain-bottom-bar');

  if (tablesView) tablesView.classList.remove('hidden');
  if (menuView) menuView.classList.add('hidden');
  if (bottomBar) bottomBar.classList.add('hidden');

  loadActiveOrders();
}

async function refreshSelectedTableOrder() {
  if (!captainState.selectedTable) return;

  try {
    const res = await fetch(`/api/tables/${encodeURIComponent(captainState.selectedTable)}/active-order`);
    const data = await res.json();

    const statusEl = document.getElementById('selected-table-status-label');
    const runningBtn = document.getElementById('btn-captain-view-running');
    const shiftBtn = document.getElementById('btn-captain-shift-table');

    if (data.success && data.has_active_order && data.order) {
      captainState.selectedTableOrder = data.order;
      const kotCount = (data.order.kot_tickets || []).length || 1;
      const nextRound = kotCount + 1;

      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #ea580c; font-weight: 800;">🟠 Running Bill #${data.order.order_number} (₹${data.order.grand_total})</span>`;
      }
      if (runningBtn) runningBtn.classList.remove('hidden');
      if (shiftBtn) shiftBtn.classList.remove('hidden');

      const punchLabel = document.getElementById('captain-punch-label');
      if (punchLabel) punchLabel.textContent = `⚡ PUNCH ROUND ${nextRound} KOT`;

      renderRunningItemsList();
    } else {
      captainState.selectedTableOrder = null;
      if (statusEl) statusEl.textContent = '🟢 Vacant Table';
      if (runningBtn) runningBtn.classList.add('hidden');
      if (shiftBtn) shiftBtn.classList.add('hidden');

      const punchLabel = document.getElementById('captain-punch-label');
      if (punchLabel) punchLabel.textContent = '⚡ PUNCH KOT';

      const card = document.getElementById('captain-running-items-card');
      if (card) card.classList.add('hidden');
    }
  } catch (e) {
    console.error('Error refreshing table order:', e);
  }
}

function toggleRunningBillTab() {
  const card = document.getElementById('captain-running-items-card');
  if (card) card.classList.toggle('hidden');
}

function renderRunningItemsList() {
  const listEl = document.getElementById('captain-running-items-list');
  if (!listEl || !captainState.selectedTableOrder) return;

  const items = captainState.selectedTableOrder.items || [];
  if (items.length === 0) {
    listEl.innerHTML = `<div style="font-size: 0.8rem; color: #94a3b8;">No items ordered yet</div>`;
    return;
  }

  listEl.innerHTML = '';
  items.forEach(it => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; padding: 4px 0; border-bottom: 1px dashed #e2e8f0;';
    
    const isReady = it.status === 'ready' || it.is_ready;
    const isServed = it.status === 'served';
    const statusText = isReady ? '✓ Ready' : (isServed ? '✓ Served' : '⏱️ Cooking');
    const statusColor = isReady ? '#16a34a' : (isServed ? '#64748b' : '#0284c7');

    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.35rem; flex: 1;">
        <span class="food-indicator ${it.food_type || 'veg'}" style="width: 12px; height: 12px;"></span>
        <span style="font-weight: 700;">${it.quantity}x ${it.item_name}</span>
        <span style="font-size: 0.68rem; background: #e2e8f0; color: #475569; padding: 1px 4px; border-radius: 4px;">R${it.round_number || 1}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span style="font-weight: 800; font-size: 0.75rem; color: ${statusColor};">${statusText}</span>
        <strong style="color: #0f172a;">₹${(it.price * it.quantity).toFixed(2)}</strong>
      </div>
    `;
    listEl.appendChild(row);
  });
}

// ----------------- VIEW 2: DISHES & MENU ----------------- //

function renderCategoryPills() {
  const container = document.getElementById('captain-category-pills');
  if (!container) return;

  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = `restro-pill ${captainState.activeCategory === 'all' ? 'active' : ''}`;
  allBtn.textContent = 'All Items';
  allBtn.onclick = () => setCategory('all');
  container.appendChild(allBtn);

  captainState.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `restro-pill ${captainState.activeCategory === cat.code ? 'active' : ''}`;
    btn.textContent = cat.name;
    btn.onclick = () => setCategory(cat.code);
    container.appendChild(btn);
  });
}

function setCategory(catCode) {
  captainState.activeCategory = catCode;
  document.querySelectorAll('#captain-category-pills .restro-pill').forEach(b => {
    b.classList.toggle('active', b.textContent === (catCode === 'all' ? 'All Items' : captainState.categories.find(c => c.code === catCode)?.name));
  });
  renderDishesList();
}

function setDietaryFilter(diet) {
  captainState.dietaryFilter = diet;
  document.getElementById('btn-diet-all')?.classList.toggle('active', diet === 'all');
  document.getElementById('btn-diet-veg')?.classList.toggle('active', diet === 'veg');
  document.getElementById('btn-diet-non-veg')?.classList.toggle('active', diet === 'non_veg');
  renderDishesList();
}

function onSearchDishes(query) {
  captainState.searchQuery = query.trim().toLowerCase();
  renderDishesList();
}

function renderDishesList() {
  const container = document.getElementById('captain-dishes-container');
  if (!container) return;

  let items = captainState.menuItems;

  if (captainState.activeCategory !== 'all') {
    items = items.filter(i => i.category_code === captainState.activeCategory);
  }

  if (captainState.dietaryFilter !== 'all') {
    items = items.filter(i => i.food_type === captainState.dietaryFilter);
  }

  if (captainState.searchQuery) {
    const q = captainState.searchQuery;
    items = items.filter(i => (i.name || '').toLowerCase().includes(q) || (i.category_name || '').toLowerCase().includes(q));
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: #94a3b8; padding: 3rem 1rem;">
        <div style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.4;">🍽️</div>
        <p style="font-weight: 700;">No dishes found</p>
        <p style="font-size: 0.78rem;">Try clearing your search or filter</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  items.forEach(dish => {
    const inCart = captainState.cart.find(c => c.id === dish.id);
    const card = document.createElement('div');
    card.className = `captain-dish-card ${inCart ? 'in-cart' : ''}`;

    let actionBtnHtml = '';
    if (inCart) {
      actionBtnHtml = `
        <div class="captain-stepper" onclick="event.stopPropagation()">
          <button onclick="decrementCartItem(${dish.id})">−</button>
          <span>${inCart.quantity}</span>
          <button onclick="incrementCartItem(${dish.id})">+</button>
        </div>
      `;
    } else {
      actionBtnHtml = `
        <button class="btn-add-touch" onclick="addToCart(${dish.id})">
          + Add
        </button>
      `;
    }

    card.innerHTML = `
      <div style="flex: 1; min-width: 0;" onclick="addToCart(${dish.id})">
        <div style="display: flex; align-items: center; gap: 0.35rem;">
          <span class="food-indicator ${dish.food_type || 'veg'}" style="width: 14px; height: 14px;"></span>
          <span style="font-weight: 800; font-size: 0.95rem; color: #0f172a;">${dish.name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 3px;">
          <strong style="color: #ea580c; font-size: 0.95rem;">₹${Number(dish.price).toFixed(2)}</strong>
          <span style="font-size: 0.72rem; color: #64748b;">${dish.category_name || 'Dish'}</span>
          ${inCart?.notes ? `<span style="font-size: 0.7rem; background: #fef3c7; color: #b45309; padding: 1px 5px; border-radius: 4px; font-weight: 700;">✍️ ${inCart.notes}</span>` : ''}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 0.45rem;">
        ${inCart ? `
          <button class="btn btn-secondary btn-sm" onclick="promptItemNote(${dish.id})" title="Add special instructions" style="padding: 4px 7px; font-size: 0.72rem;">
            ✍️
          </button>
        ` : ''}
        ${actionBtnHtml}
      </div>
    `;

    container.appendChild(card);
  });
}

// ----------------- CART & ORDERING ----------------- //

function addToCart(dishId) {
  const dish = captainState.menuItems.find(i => i.id === dishId);
  if (!dish) return;

  const existing = captainState.cart.find(c => c.id === dishId);
  if (existing) {
    existing.quantity += 1;
  } else {
    captainState.cart.push({
      id: dish.id,
      name: dish.name,
      price: Number(dish.price),
      food_type: dish.food_type,
      quantity: 1,
      notes: ''
    });
  }

  updateCartUI();
  renderDishesList();
}

function incrementCartItem(dishId) {
  const it = captainState.cart.find(c => c.id === dishId);
  if (it) {
    it.quantity += 1;
    updateCartUI();
    renderDishesList();
  }
}

function decrementCartItem(dishId) {
  const idx = captainState.cart.findIndex(c => c.id === dishId);
  if (idx !== -1) {
    if (captainState.cart[idx].quantity <= 1) {
      captainState.cart.splice(idx, 1);
    } else {
      captainState.cart[idx].quantity -= 1;
    }
    updateCartUI();
    renderDishesList();
  }
}

function promptItemNote(dishId) {
  const it = captainState.cart.find(c => c.id === dishId);
  if (!it) return;

  const current = it.notes || '';
  const note = prompt(`Special instructions for "${it.name}" (e.g. Less spicy, No onion):`, current);
  if (note !== null) {
    it.notes = note.trim();
    updateCartUI();
    renderDishesList();
  }
}

function updateCartUI() {
  const bottomBar = document.getElementById('captain-bottom-bar');
  const countEl = document.getElementById('captain-cart-count');
  const tableEl = document.getElementById('captain-cart-table');
  const totalEl = document.getElementById('captain-cart-total');
  const punchBtn = document.getElementById('btn-punch-kot');

  if (!bottomBar) return;

  const count = captainState.cart.reduce((acc, i) => acc + i.quantity, 0);
  const total = captainState.cart.reduce((acc, i) => acc + (i.price * i.quantity), 0);

  if (count > 0 && captainState.selectedTable) {
    bottomBar.classList.remove('hidden');
    if (countEl) countEl.textContent = `${count} dish${count > 1 ? 'es' : ''}`;
    if (tableEl) tableEl.textContent = captainState.selectedTable;
    if (totalEl) totalEl.textContent = `₹${total.toFixed(2)}`;
    if (punchBtn) punchBtn.disabled = false;
  } else {
    bottomBar.classList.add('hidden');
  }
}

async function punchCaptainOrder() {
  if (captainState.cart.length === 0 || !captainState.selectedTable) {
    showToast('Add items before punching order', 'warning');
    return;
  }

  const punchBtn = document.getElementById('btn-punch-kot');
  if (punchBtn) {
    punchBtn.disabled = true;
    punchBtn.innerHTML = `<span>⏳ Sending to Kitchen...</span>`;
  }

  const payload = {
    channel: 'dine_in',
    table_name: captainState.selectedTable,
    waiter_name: captainState.captainName,
    items: captainState.cart.map(i => ({
      item_id: i.id,
      item_name: i.name,
      price: i.price,
      quantity: i.quantity,
      food_type: i.food_type,
      notes: i.notes
    }))
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      KotAudio?.playSuccessBeep?.();
      showToast(`🎉 KOT Punched for Table ${captainState.selectedTable}! Kitchen notified.`, 'success');
      captainState.cart = [];
      updateCartUI();
      await refreshSelectedTableOrder();
      kotSocket.notifyAction('NEW_ORDER', { table: captainState.selectedTable });
      renderDishesList();
    } else {
      showToast(data.error || 'Failed to punch KOT', 'error');
    }
  } catch (e) {
    showToast('Network error punching order', 'error');
  } finally {
    if (punchBtn) {
      punchBtn.disabled = false;
      const isRunning = Boolean(captainState.selectedTableOrder);
      const nextR = (captainState.selectedTableOrder?.kot_tickets?.length || 1) + 1;
      punchBtn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        <span id="captain-punch-label">${isRunning ? `⚡ PUNCH ROUND ${nextR} KOT` : '⚡ PUNCH KOT'}</span>
      `;
    }
  }
}

// ----------------- SHIFT TABLE IN CAPTAIN PORTAL ----------------- //

function openCaptainShiftModal() {
  if (!captainState.selectedTable) return;

  const srcLabel = document.getElementById('captain-shift-source-label');
  if (srcLabel) srcLabel.textContent = `Table ${captainState.selectedTable}`;

  const sel = document.getElementById('captain-shift-target-select');
  if (sel) {
    sel.innerHTML = '<option value="">-- Choose destination table --</option>';
    const occupiedNames = new Set(
      captainState.activeOrders
        .filter(o => o.channel === 'dine_in' && o.table_name && o.payment_status === 'unpaid')
        .map(o => o.table_name.toUpperCase())
    );

    captainState.tables.forEach(tbl => {
      if (tbl.name.toUpperCase() === captainState.selectedTable.toUpperCase()) return;
      const isOcc = occupiedNames.has(tbl.name.toUpperCase());
      const opt = document.createElement('option');
      opt.value = tbl.name;
      opt.textContent = `${tbl.name} (${tbl.section || 'Hall'}) — ${isOcc ? '🟠 Occupied' : '🟢 Vacant'}`;
      opt.dataset.occupied = isOcc ? '1' : '0';
      sel.appendChild(opt);
    });
  }

  const conflictBox = document.getElementById('captain-shift-conflict');
  if (conflictBox) conflictBox.classList.add('hidden');

  const modal = document.getElementById('modal-captain-shift');
  if (modal) modal.classList.remove('hidden');
}

function closeCaptainShiftModal() {
  const modal = document.getElementById('modal-captain-shift');
  if (modal) modal.classList.add('hidden');
}

function onCaptainShiftTargetChanged() {
  const sel = document.getElementById('captain-shift-target-select');
  const conflict = document.getElementById('captain-shift-conflict');
  if (!sel || !conflict) return;

  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.dataset.occupied === '1') {
    conflict.classList.remove('hidden');
  } else {
    conflict.classList.add('hidden');
  }
}

async function confirmCaptainShift() {
  const sel = document.getElementById('captain-shift-target-select');
  const targetTable = sel ? sel.value.trim() : '';
  if (!targetTable) {
    showToast('Please select a destination table', 'warning');
    return;
  }

  const conflict = document.getElementById('captain-shift-conflict');
  const isConflict = conflict && !conflict.classList.contains('hidden');
  let action = 'shift';
  if (isConflict) {
    const radio = document.querySelector('input[name="captain_shift_act"]:checked');
    action = radio ? radio.value : 'swap';
  }

  try {
    const res = await fetch('/api/tables/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_table: captainState.selectedTable,
        target_table: targetTable,
        action: action,
        reason: `Shifted by ${captainState.captainName}`
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `Table shifted to ${targetTable}!`, 'success');
      closeCaptainShiftModal();
      await loadActiveOrders();
      await selectTable(targetTable);
      kotSocket.notifyAction('TABLE_SHIFTED', { source: captainState.selectedTable, target: targetTable });
    } else {
      showToast(data.error || 'Failed to shift table', 'error');
    }
  } catch (e) {
    showToast('Network error shifting table', 'error');
  }
}

// Global exports
window.initCaptain = initCaptain;
window.promptChangeCaptain = promptChangeCaptain;
window.loadTablesData = loadTablesData;
window.filterTablesBySection = filterTablesBySection;
window.selectTable = selectTable;
window.showTablesView = showTablesView;
window.toggleRunningBillTab = toggleRunningBillTab;
window.setCategory = setCategory;
window.setDietaryFilter = setDietaryFilter;
window.onSearchDishes = onSearchDishes;
window.addToCart = addToCart;
window.incrementCartItem = incrementCartItem;
window.decrementCartItem = decrementCartItem;
window.promptItemNote = promptItemNote;
window.punchCaptainOrder = punchCaptainOrder;
window.openCaptainShiftModal = openCaptainShiftModal;
window.closeCaptainShiftModal = closeCaptainShiftModal;
window.onCaptainShiftTargetChanged = onCaptainShiftTargetChanged;
window.confirmCaptainShift = confirmCaptainShift;

window.addEventListener('DOMContentLoaded', initCaptain);
