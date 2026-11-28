/**
 * Grand Palace POS - Running Table Order & Consolidated Billing Engine
 * Ultra-Premium Light Theme with SVG Icons & Zero-Refresh Synchronization
 */

let state = {
  settings: {
    restaurant_name: 'Grand Palace Hotel & Restaurant',
    tagline: 'Authentic Taste & Quality Hospitality',
    address: '124, Commercial Road, Central District',
    phone: '+91 98765 43210',
    gstin: '33AABCU9603R1ZM',
    fssai: '12423008000451',
    cgst_rate: 2.5,
    sgst_rate: 2.5,
    currency_symbol: '₹'
  },
  channel: 'dine_in', // dine_in, takeaway, swiggy, zomato
  tableName: '',
  waiterName: '',
  customerName: '',
  customerPhone: '',
  onlineOrderId: '',
  categories: [],
  menuItems: [],
  activeCategory: 'all',
  dietaryFilter: 'all',
  searchQuery: '',
  paymentMethod: 'cash',
  
  // Running Bill State
  activeRunningOrder: null, // If editing an existing table order
  existingItems: [],        // Previously ordered items from Round 1, Round 2...
  cart: [],                 // Newly selected items to be punched in the next KOT round

  discount: {
    type: 'percentage',
    value: 0
  },
  tables: [],
  activeOrders: [],
  drawerFilter: 'all'
};

// DOM References
const categoryPillsContainer = document.getElementById('category-pills');
const menuItemsGrid = document.getElementById('menu-items-grid');
const cartItemsContainer = document.getElementById('cart-items-container');
const channelMetadataBar = document.getElementById('channel-metadata-bar');
const ticketChannelBadge = document.getElementById('ticket-channel-badge');
const ticketTableToken = document.getElementById('ticket-table-token');
const ticketCaptainInfo = document.getElementById('ticket-captain-info');
const menuSearchInput = document.getElementById('menu-search-input');
const specialNotesInput = document.getElementById('order-special-notes');
const runningOrderBanner = document.getElementById('running-order-banner');
const punchKotBtn = document.getElementById('btn-punch-kot');
const punchKotLabel = document.getElementById('btn-punch-label');

async function initPOS() {
  await loadSettings();
  await loadMenuData();
  await loadTables();
  await loadActiveOrders();

  setupEventListeners();
  renderChannelMetadata();
  renderCategories();
  renderMenuItems();
  renderCart();

  // Instant real-time listener for zero refresh updates
  kotSocket.on('*', async (eventData) => {
    if (eventData && (eventData.type === 'MENU_UPDATED' || eventData.action === 'MENU_UPDATED')) {
      await loadMenuData();
    }
    await loadActiveOrders();
    await loadTables();
    // If the currently selected table has changes, refresh its active order
    if (state.channel === 'dine_in' && state.tableName) {
      await refreshCurrentTableOrder();
    }
  });
}

// ----------------- DATA LOADING ----------------- //

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      const restEl = document.getElementById('header-rest-name') || document.getElementById('rest-name-display');
      if (restEl) restEl.textContent = state.settings.restaurant_name;
      const cgstEl = document.getElementById('cgst-rate-lbl');
      if (cgstEl) cgstEl.textContent = state.settings.cgst_rate;
      const sgstEl = document.getElementById('sgst-rate-lbl');
      if (sgstEl) sgstEl.textContent = state.settings.sgst_rate;
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function loadMenuData() {
  try {
    const res = await fetch('/api/menu');
    const data = await res.json();
    if (data.success) {
      state.categories = data.categories || [];
      state.menuItems = data.items || [];
      renderCategories();
      renderMenuItems();
    }
  } catch (e) {
    console.error('Failed to load menu:', e);
  }
}

async function loadTables() {
  try {
    const res = await fetch('/api/tables');
    const data = await res.json();
    if (data.success) {
      state.tables = data.tables || [];
      renderTablesModal();
      populateTableDropdown();
    }
  } catch (e) {
    console.error('Failed to load tables:', e);
  }
}

function populateTableDropdown() {
  const select = document.getElementById('select-table-dropdown');
  if (!select) return;
  select.innerHTML = '<option value="">Select Table</option>';
  for (const t of state.tables) {
    const isOcc = t.is_occupied || Boolean(t.active_order);
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = `${t.name} (${t.capacity}p) ${isOcc ? '• Occupied' : '• Vacant'}`;
    if (state.tableName === t.name) opt.selected = true;
    select.appendChild(opt);
  }
}

function onDiningModeChange(val) {
  state.channel = val;
  const tableSelect = document.getElementById('select-table-dropdown');
  if (tableSelect) {
    tableSelect.style.display = val === 'dine_in' ? 'block' : 'none';
  }
  renderChannelMetadata();
  renderCart();
}
window.onDiningModeChange = onDiningModeChange;

function onTableDropdownChange(val) {
  if (val) {
    selectTable(val);
  } else {
    state.tableName = '';
    state.activeRunningOrder = null;
    state.existingItems = [];
    renderChannelMetadata();
    renderCart();
  }
}
window.onTableDropdownChange = onTableDropdownChange;

function onCategorySelectChange(val) {
  state.activeCategory = val;
  document.querySelectorAll('#category-pills .restro-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.category === val);
  });
  renderMenuItems();
}
window.onCategorySelectChange = onCategorySelectChange;

function onDietarySelectChange(val) {
  state.dietaryFilter = val;
  renderMenuItems();
}
window.onDietarySelectChange = onDietarySelectChange;

function openSettlePaymentModal() {
  // Select UPI or Cash and settle
  if (state.cart.length > 0) {
    if (confirm('You have unpunched items in cart! Punch KOT first, or settle existing bill? Click OK to settle now.')) {
      printBillAndSettle();
    }
  } else {
    printBillAndSettle();
  }
}
window.openSettlePaymentModal = openSettlePaymentModal;

async function loadActiveOrders() {
  try {
    const res = await fetch('/api/orders?filter=active');
    const data = await res.json();
    if (data.success) {
      state.activeOrders = data.orders || [];
      const ordersCountEl = document.getElementById('active-orders-count');
      if (ordersCountEl) ordersCountEl.textContent = state.activeOrders.length;
      renderDrawerOrders();
    }
  } catch (e) {
    console.error('Failed to load active orders:', e);
  }
}

// ----------------- TABLE SELECTION & RUNNING BILL DETECTION ----------------- //

async function selectTable(tableName) {
  state.tableName = tableName;
  closeTableModal();

  // Check if this table has an active running bill!
  try {
    const res = await fetch(`/api/tables/${encodeURIComponent(tableName)}/active-order`);
    const data = await res.json();

    if (data.success && data.has_active_order && data.order) {
      // Table already has a running order! Load it into state!
      state.activeRunningOrder = data.order;
      state.existingItems = data.order.items || [];
      state.waiterName = data.order.waiter_name || '';
      state.discount = {
        type: data.order.discount_type || 'percentage',
        value: data.order.discount_value || 0
      };

      // Show running order banner
      if (runningOrderBanner) runningOrderBanner.classList.remove('hidden');
      const bTitle = document.getElementById('banner-table-title');
      if (bTitle) bTitle.textContent = `Running Bill: Table ${tableName}`;
      const bSub = document.getElementById('banner-table-subtitle');
      if (bSub) bSub.textContent = `(Bill #${data.order.order_number} • Current Total: ₹${data.order.grand_total})`;

      const nextRound = (data.order.kot_tickets?.length || 1) + 1;
      if (punchKotLabel) punchKotLabel.textContent = `PUNCH ROUND ${nextRound} KOT →`;
      if (punchKotBtn) punchKotBtn.className = 'btn btn-primary btn-lg';

      showToast(`Loaded running order for Table ${tableName}. You can add Round ${nextRound} items now!`, 'info');
    } else {
      // Table is fresh / vacant
      state.activeRunningOrder = null;
      state.existingItems = [];
      if (runningOrderBanner) runningOrderBanner.classList.add('hidden');
      if (punchKotLabel) punchKotLabel.textContent = 'PUNCH KOT →';
      if (punchKotBtn) punchKotBtn.className = 'btn btn-primary btn-lg';
    }
  } catch (e) {
    console.error('Error checking table running order:', e);
  }

  renderChannelMetadata();
  const tableSelect = document.getElementById('select-table-dropdown');
  if (tableSelect) tableSelect.value = tableName;
  renderCart();
  renderMenuItems();
}

async function refreshCurrentTableOrder() {
  if (!state.tableName) return;
  try {
    const res = await fetch(`/api/tables/${encodeURIComponent(state.tableName)}/active-order`);
    const data = await res.json();
    if (data.success && data.has_active_order && data.order) {
      state.activeRunningOrder = data.order;
      state.existingItems = data.order.items || [];
      const bSub = document.getElementById('banner-table-subtitle');
      if (bSub) bSub.textContent = `(Bill #${data.order.order_number} • Current Total: ₹${data.order.grand_total})`;
      renderCart();
    } else if (!data.has_active_order) {
      // Order was settled by another station
      resetToNewOrder();
    }
  } catch (e) {}
}

function resetToNewOrder() {
  state.activeRunningOrder = null;
  state.existingItems = [];
  state.cart = [];
  state.tableName = '';
  runningOrderBanner.classList.add('hidden');
  if (punchKotLabel) punchKotLabel.textContent = 'PUNCH KOT →';
  punchKotBtn.className = 'btn btn-primary btn-lg';
  renderChannelMetadata();
  const tableSelect = document.getElementById('select-table-dropdown');
  if (tableSelect) tableSelect.value = '';
  renderCart();
  renderMenuItems();
}

function renderChannelMetadata() {
  if (ticketChannelBadge) {
    ticketChannelBadge.className = `badge-channel badge-${state.channel}`;
    ticketChannelBadge.textContent = state.channel.replace('_', ' ').toUpperCase();
  }

  if (state.channel === 'dine_in') {
    let tablesQuickHtml = '';
    const visibleTables = (state.tables || []).slice(0, 10);
    for (const t of visibleTables) {
      const isOcc = t.is_occupied || Boolean(t.active_order);
      const isSel = state.tableName === t.name;
      tablesQuickHtml += `
        <button class="table-quick-btn ${isSel ? 'selected' : (isOcc ? 'occ' : 'vac')}" 
                onclick="selectTable('${t.name}')" 
                title="${t.name} (${t.capacity} seats) - ${isOcc ? 'Occupied' : 'Vacant'}">
          <span class="t-dot ${isOcc ? 'dot-amber' : 'dot-green'}"></span>
          <span>${t.name}</span>
        </button>
      `;
    }

    if (channelMetadataBar) {
      channelMetadataBar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; overflow-x: auto; flex: 1; padding: 4px 0; min-height: 40px; scrollbar-width: thin;">
          <span style="font-size: 0.85rem; font-weight: 800; color: #1d4ed8; white-space: nowrap; display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0;">
            ${window.kotIcon ? window.kotIcon('table') : ''} Table:
          </span>
          <div style="display: flex; gap: 0.4rem; align-items: center; white-space: nowrap; flex-shrink: 0;">
            ${tablesQuickHtml}
          </div>
          <button class="btn btn-secondary btn-sm" onclick="openTableModal()" style="white-space: nowrap; padding: 0.4rem 0.75rem; font-size: 0.8rem; font-weight: 700; height: 34px; border-radius: 9px; flex-shrink: 0; display: inline-flex; align-items: center;">
            All (${state.tables ? state.tables.length : 0}) ▾
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-left: 0.75rem; white-space: nowrap; flex-shrink: 0;">
          <span style="font-size: 0.82rem; font-weight: 700; color: #475569;">Waiter:</span>
          <input type="text" id="input-waiter" class="channel-input" style="width: 130px; font-size: 0.82rem;" placeholder="Captain name" value="${state.waiterName}">
        </div>
      `;
    }
    if (ticketTableToken) ticketTableToken.textContent = state.tableName ? `Table ${state.tableName}` : 'Select Table';
    if (ticketCaptainInfo) ticketCaptainInfo.textContent = `Waiter: ${state.waiterName || 'Not assigned'}`;

    document.getElementById('input-waiter')?.addEventListener('input', (e) => {
      state.waiterName = e.target.value.trim();
      if (ticketCaptainInfo) ticketCaptainInfo.textContent = `Waiter: ${state.waiterName || 'Not assigned'}`;
    });

  } else if (state.channel === 'takeaway') {
    state.activeRunningOrder = null;
    state.existingItems = [];
    if (runningOrderBanner) runningOrderBanner.classList.add('hidden');
    if (punchKotLabel) punchKotLabel.textContent = 'PUNCH KOT →';

    if (channelMetadataBar) {
      channelMetadataBar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="font-weight: 700; font-size: 0.82rem; color: #475569;">Customer:</span>
          <input type="text" id="input-cust-name" class="channel-input" style="width: 160px;" placeholder="Name (optional)" value="${state.customerName}">
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="font-weight: 700; font-size: 0.82rem; color: #475569;">Phone:</span>
          <input type="text" id="input-cust-phone" class="channel-input" style="width: 150px;" placeholder="Mobile number" value="${state.customerPhone}">
        </div>
      `;
    }
    if (ticketTableToken) ticketTableToken.textContent = 'Take Away Order';
    if (ticketCaptainInfo) ticketCaptainInfo.textContent = state.customerName ? `Cust: ${state.customerName}` : 'Counter Pickup';

    document.getElementById('input-cust-name')?.addEventListener('input', (e) => {
      state.customerName = e.target.value.trim();
      if (ticketCaptainInfo) ticketCaptainInfo.textContent = state.customerName ? `Cust: ${state.customerName}` : 'Counter Pickup';
    });
    document.getElementById('input-cust-phone')?.addEventListener('input', (e) => {
      state.customerPhone = e.target.value.trim();
    });

  } else if (state.channel === 'swiggy' || state.channel === 'zomato') {
    state.activeRunningOrder = null;
    state.existingItems = [];
    if (runningOrderBanner) runningOrderBanner.classList.add('hidden');
    if (punchKotLabel) punchKotLabel.textContent = 'PUNCH KOT →';

    if (channelMetadataBar) {
      channelMetadataBar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="font-weight: 700; font-size: 0.82rem; color: ${state.channel === 'swiggy' ? '#ea580c' : '#e11d48'};">Online Order ID:</span>
          <input type="text" id="input-online-id" class="channel-input" style="width: 160px; font-weight: bold;" placeholder="e.g. SWIGGY-8821" value="${state.onlineOrderId}">
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span style="font-weight: 700; font-size: 0.82rem; color: #475569;">Rider / Notes:</span>
          <input type="text" id="input-online-notes" class="channel-input" style="width: 180px;" placeholder="Rider arriving in 10m" value="${state.customerName}">
        </div>
      `;
    }
    if (ticketTableToken) ticketTableToken.textContent = `${state.channel.toUpperCase()} #${state.onlineOrderId || 'New'}`;
    if (ticketCaptainInfo) ticketCaptainInfo.textContent = 'Aggregator Dispatch';

    document.getElementById('input-online-id')?.addEventListener('input', (e) => {
      state.onlineOrderId = e.target.value.trim();
      if (ticketTableToken) ticketTableToken.textContent = `${state.channel.toUpperCase()} #${state.onlineOrderId || 'New'}`;
    });
    document.getElementById('input-online-notes')?.addEventListener('input', (e) => {
      state.customerName = e.target.value.trim();
    });
  }
}

// ----------------- CATEGORY & MENU ITEMS RENDERING ----------------- //

function renderCategories() {
  if (!categoryPillsContainer) return;
  categoryPillsContainer.innerHTML = '';

  const catSelect = document.getElementById('filter-cat-select');
  if (catSelect) {
    catSelect.innerHTML = '<option value="all">All Category</option>';
  }

  const allPill = document.createElement('button');
  allPill.className = `restro-pill ${state.activeCategory === 'all' ? 'active' : ''}`;
  allPill.dataset.category = 'all';
  allPill.textContent = 'Show All';
  allPill.addEventListener('click', () => {
    state.activeCategory = 'all';
    if (catSelect) catSelect.value = 'all';
    renderCategories();
    renderMenuItems();
  });
  categoryPillsContainer.appendChild(allPill);

  for (const cat of state.categories) {
    const pill = document.createElement('button');
    pill.className = `restro-pill ${state.activeCategory === cat.code ? 'active' : ''}`;
    pill.dataset.category = cat.code;
    pill.textContent = cat.name;
    pill.addEventListener('click', () => {
      state.activeCategory = cat.code;
      if (catSelect) catSelect.value = cat.code;
      renderCategories();
      renderMenuItems();
    });
    categoryPillsContainer.appendChild(pill);

    if (catSelect) {
      const opt = document.createElement('option');
      opt.value = cat.code;
      opt.textContent = cat.name;
      if (state.activeCategory === cat.code) opt.selected = true;
      catSelect.appendChild(opt);
    }
  }
}

function renderMenuItems() {
  let filtered = state.menuItems;

  if (state.activeCategory !== 'all') {
    filtered = filtered.filter(i => i.category_code === state.activeCategory);
  }

  if (state.dietaryFilter && state.dietaryFilter !== 'all') {
    filtered = filtered.filter(i => (i.food_type || 'veg') === state.dietaryFilter);
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(i => i.name.toLowerCase().includes(q) || (i.description && i.description.toLowerCase().includes(q)));
  }

  if (state.menuItems.length === 0) {
    menuItemsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4.5rem 1rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.6rem; opacity: 0.35;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
        </div>
        <p style="font-size: 1.15rem; font-weight: 800; color: #090d16;">Menu is Currently Empty</p>
        <p style="font-size: 0.88rem; color: var(--text-muted); margin-top: 0.25rem; max-width: 440px; margin-left: auto; margin-right: auto;">
          You can add your custom dishes in Settings, or load 20+ sample restaurant dishes to explore the complete POS & KOT workflow.
        </p>
        <div style="margin-top: 1.25rem; display: flex; justify-content: center; gap: 0.75rem; flex-wrap: wrap;">
          <button class="btn btn-primary btn-sm" onclick="seedSampleMenuInPos()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ✨ Load Sample Menu
          </button>
          <a href="/settings" class="btn btn-secondary btn-sm">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Add Dishes Manually
          </a>
        </div>
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    menuItemsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4rem 1rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.5rem; opacity: 0.4;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        </div>
        <p style="font-size: 1rem; font-weight: 500; color: var(--text-secondary);">No dishes found</p>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Try clearing search or dietary filters</p>
      </div>
    `;
    return;
  }

  menuItemsGrid.innerHTML = '';

  for (const item of filtered) {
    const card = document.createElement('div');
    const inCart = state.cart.find(c => c.menu_item_id === item.id);
    card.className = `restro-dish-card ${inCart ? 'in-cart' : ''} ${item.is_available ? '' : 'unavailable'}`;

    const foodTypeClass = item.food_type || 'veg';

    let actionBtnHtml = `
      <button class="restro-add-btn-circle" title="Add to Order">+</button>
    `;
    if (inCart) {
      actionBtnHtml = `
        <div class="restro-stepper" onclick="event.stopPropagation()">
          <button class="restro-stepper-btn" onclick="decrementItem(${item.id})">−</button>
          <span class="restro-stepper-val">${inCart.quantity}</span>
          <button class="restro-stepper-btn plus" onclick="incrementItem(${item.id})">+</button>
        </div>
      `;
    }

    card.innerHTML = `
      <div>
        <div class="dish-head">
          <span class="dish-cat-tag">${item.category_name || 'Dish'}</span>
          <span class="food-indicator ${foodTypeClass}" title="${foodTypeClass.toUpperCase()}"></span>
        </div>
        <div class="dish-title">${item.name}</div>
        <div class="dish-desc">${item.description || 'Freshly prepared specialty dish'}</div>
      </div>
      <div class="dish-footer">
        <div class="dish-price">₹${item.price.toFixed(2)}</div>
        ${actionBtnHtml}
      </div>
    `;

    card.addEventListener('click', () => {
      addItemToCart(item);
    });

    menuItemsGrid.appendChild(card);
  }
}

// ----------------- CART & BILL CALCULATIONS ----------------- //

function addItemToCart(item) {
  const existing = state.cart.find(c => c.menu_item_id === item.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    state.cart.push({
      menu_item_id: item.id,
      item_name: item.name,
      price: item.price,
      food_type: item.food_type,
      quantity: 1,
      notes: ''
    });
  }
  renderCart();
  renderMenuItems();
}

function incrementItem(menuItemId) {
  const item = state.cart.find(c => c.menu_item_id === menuItemId);
  if (item) {
    item.quantity += 1;
    renderCart();
    renderMenuItems();
  }
}

function decrementItem(menuItemId) {
  const idx = state.cart.findIndex(c => c.menu_item_id === menuItemId);
  if (idx !== -1) {
    if (state.cart[idx].quantity > 1) {
      state.cart[idx].quantity -= 1;
    } else {
      state.cart.splice(idx, 1);
    }
    renderCart();
    renderMenuItems();
  }
}

window.incrementItem = incrementItem;
window.decrementItem = decrementItem;

function updateCartItemQty(index, delta) {
  state.cart[index].quantity += delta;
  if (state.cart[index].quantity <= 0) {
    state.cart.splice(index, 1);
  }
  renderCart();
  renderMenuItems();
}

function removeCartItem(index) {
  state.cart.splice(index, 1);
  renderCart();
  renderMenuItems();
}

function promptItemNote(index) {
  const note = prompt('Add special cooking note for this dish (e.g. Less spicy, Extra crispy):', state.cart[index].notes || '');
  if (note !== null) {
    state.cart[index].notes = note.trim();
    renderCart();
  }
}
window.promptItemNote = promptItemNote;

function clearCart() {
  state.cart = [];
  if (specialNotesInput) specialNotesInput.value = '';
  renderCart();
  renderMenuItems();
}

function renderCart() {
  if (!cartItemsContainer) return;

  const totalItemsCount = state.existingItems.reduce((s, i) => s + i.quantity, 0) +
                          state.cart.reduce((s, i) => s + i.quantity, 0);

  const countBadge = document.getElementById('cart-item-count');
  if (countBadge) countBadge.textContent = totalItemsCount;

  // Update order header title
  if (ticketTableToken) {
    if (state.activeRunningOrder) {
      ticketTableToken.textContent = `Order #${state.activeRunningOrder.order_number.replace('KOT-', '')} (${state.tableName || 'Dine'})`;
    } else if (state.channel === 'dine_in') {
      ticketTableToken.textContent = state.tableName ? `Table ${state.tableName}` : 'Select Table';
    } else if (state.channel === 'takeaway') {
      ticketTableToken.textContent = 'Take Away Order';
    } else {
      ticketTableToken.textContent = `${state.channel.toUpperCase()} #${state.onlineOrderId || 'New'}`;
    }
  }

  if (state.existingItems.length === 0 && state.cart.length === 0) {
    cartItemsContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 4.5rem 1rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.5rem; opacity: 0.35;">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        </div>
        <p style="font-size: 0.95rem; font-weight: 700; color: #334155;">Cart is Empty</p>
        <p style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem;">Click dishes on the left to add items</p>
      </div>
    `;
    updateCalculations(0, 0, 0, 0, 0, 0);
    return;
  }

  cartItemsContainer.innerHTML = '';

  // 1. Render Previously Ordered Items (Round 1, Round 2...)
  if (state.existingItems.length > 0) {
    const prevHeader = document.createElement('div');
    prevHeader.style.cssText = 'font-size: 0.72rem; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin: 0.25rem 0 0.45rem 0; display: flex; justify-content: space-between; align-items: center;';
    prevHeader.innerHTML = `
      <span>📌 PREVIOUS ROUNDS (ON BILL)</span>
      <span style="color: #16a34a; font-weight: 800;">IN KITCHEN</span>
    `;
    cartItemsContainer.appendChild(prevHeader);

    state.existingItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'restro-cart-card';
      row.style.background = '#f8fafc';
      const itemTotal = item.price * item.quantity;
      const roundTag = item.round_number ? `R${item.round_number}` : 'R1';

      row.innerHTML = `
        <div class="item-row-top">
          <div>
            <div style="display: flex; align-items: center; gap: 0.35rem;">
              <span class="food-indicator ${item.food_type || 'veg'}" style="width: 14px; height: 14px;"></span>
              <span class="item-name">${item.item_name}</span>
              <span style="font-size: 0.7rem; background: #e2e8f0; color: #475569; padding: 1px 5px; border-radius: 4px; font-weight: 800;">${roundTag}</span>
            </div>
            <div class="item-math">₹${item.price.toFixed(2)} × ${item.quantity} = ₹${itemTotal.toFixed(2)}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.45rem;">
            <span style="font-size: 0.72rem; font-weight: 700; color: ${item.status === 'ready' || item.is_ready ? '#16a34a' : (item.status === 'served' ? '#475569' : '#0284c7')};">
              ${item.status === 'ready' || item.is_ready ? '✓ Ready' : (item.status === 'served' ? '✓ Served' : '⏱️ Cooking')}
            </span>
            <div class="restro-stepper" style="height: 24px; padding: 0 4px;" onclick="event.stopPropagation()">
              <button class="restro-stepper-btn" style="width: 20px; height: 20px; font-size: 0.8rem;" onclick="decrementRunningOrderItem(${item.id}, ${item.quantity})" title="Decrease quantity">−</button>
              <span class="restro-stepper-val" style="font-size: 0.8rem; min-width: 18px;">${item.quantity}</span>
              <button class="restro-stepper-btn plus" style="width: 20px; height: 20px; font-size: 0.8rem;" onclick="incrementRunningOrderItem(${item.id}, ${item.quantity})" title="Increase quantity">+</button>
            </div>
            <button class="item-del-btn" onclick="voidRunningOrderItem(${item.id}, '${item.item_name.replace(/'/g, "\\'")}')" title="Void dish from active bill" style="padding: 3px; color: #ef4444;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
            </button>
          </div>
        </div>
      `;
      cartItemsContainer.appendChild(row);
    });
  }

  // 2. Render Newly Added Items (for the next KOT round)
  if (state.cart.length > 0) {
    if (state.existingItems.length > 0) {
      const newHeader = document.createElement('div');
      newHeader.style.cssText = 'font-size: 0.72rem; font-weight: 800; color: #ea580c; text-transform: uppercase; letter-spacing: 0.05em; margin: 0.85rem 0 0.45rem 0; display: flex; justify-content: space-between; align-items: center;';
      newHeader.innerHTML = `
        <span>➕ NEW ITEMS TO PUNCH (NEXT ROUND)</span>
        <span style="color: #ea580c; font-weight: 800;">NEW KOT</span>
      `;
      cartItemsContainer.appendChild(newHeader);
    }

    state.cart.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'restro-cart-card';
      const itemTotal = item.price * item.quantity;

      row.innerHTML = `
        <div class="item-row-top">
          <div>
            <div style="display: flex; align-items: center; gap: 0.35rem;">
              <span class="food-indicator ${item.food_type || 'veg'}" style="width: 14px; height: 14px;"></span>
              <span class="item-name">${item.item_name}</span>
            </div>
            <div class="item-math">₹${item.price.toFixed(2)} × ${item.quantity} = ₹${itemTotal.toFixed(2)}</div>
          </div>
          <button class="item-del-btn" onclick="removeCartItem(${idx})" title="Remove item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          </button>
        </div>
        <div class="item-row-bottom">
          <div class="restro-stepper">
            <button class="restro-stepper-btn" onclick="updateCartItemQty(${idx}, -1)">−</button>
            <span class="restro-stepper-val">${item.quantity}</span>
            <button class="restro-stepper-btn plus" onclick="updateCartItemQty(${idx}, 1)">+</button>
          </div>
          <button class="btn-add-notes" onclick="promptItemNote(${idx})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>${item.notes ? item.notes : 'Add Notes'}</span>
          </button>
        </div>
      `;
      cartItemsContainer.appendChild(row);
    });
  }

  // Combined Totals Calculation
  const subtotalExisting = state.existingItems.reduce((s, i) => s + (i.price * i.quantity), 0);
  const subtotalCart = state.cart.reduce((s, i) => s + (i.price * i.quantity), 0);
  const subtotal = subtotalExisting + subtotalCart;

  let discountAmount = 0;
  if (state.discount.type === 'percentage') {
    discountAmount = (subtotal * state.discount.value) / 100.0;
  } else {
    discountAmount = Math.min(state.discount.value, subtotal);
  }

  const taxable = Math.max(0, subtotal - discountAmount);
  const cgstRate = parseFloat(state.settings.cgst_rate || '2.5');
  const sgstRate = parseFloat(state.settings.sgst_rate || '2.5');

  const cgstAmount = Math.round(((taxable * cgstRate) / 100.0) * 100) / 100;
  const sgstAmount = Math.round(((taxable * sgstRate) / 100.0) * 100) / 100;

  const totalBeforeRound = taxable + cgstAmount + sgstAmount;
  const grandTotal = Math.round(totalBeforeRound);
  const roundOff = Math.round((grandTotal - totalBeforeRound) * 100) / 100;

  updateCalculations(subtotal, discountAmount, cgstAmount, sgstAmount, roundOff, grandTotal);
}

function updateCalculations(subtotal, discount, cgst, sgst, roundoff, grandTotal) {
  document.getElementById('calc-subtotal').textContent = `₹${subtotal.toFixed(2)}`;
  document.getElementById('calc-discount').textContent = `- ₹${discount.toFixed(2)}`;
  document.getElementById('calc-cgst').textContent = `₹${cgst.toFixed(2)}`;
  document.getElementById('calc-sgst').textContent = `₹${sgst.toFixed(2)}`;
  document.getElementById('calc-roundoff').textContent = (roundoff >= 0 ? '+ ₹' : '- ₹') + Math.abs(roundoff).toFixed(2);
  document.getElementById('calc-grandtotal').textContent = `₹${grandTotal.toLocaleString()}`;
}

// ----------------- PUNCH KOT (ROUND 1 OR ADD-ON ROUND 2+) ----------------- //

async function punchKOT() {
  if (state.cart.length === 0) {
    showToast('No new dishes in cart to punch!', 'warning');
    return;
  }

  if (state.channel === 'dine_in' && !state.tableName) {
    showToast('Please select a Table number for Dine-In!', 'warning');
    openTableModal();
    return;
  }

  const selectedPayMode = state.paymentMethod || 'cash';

  const orderPayload = {
    order_id: state.activeRunningOrder ? state.activeRunningOrder.id : null,
    channel: state.channel,
    table_name: state.channel === 'dine_in' ? state.tableName : null,
    waiter_name: state.waiterName || null,
    customer_name: state.customerName || null,
    customer_phone: state.customerPhone || null,
    online_order_id: (state.channel === 'swiggy' || state.channel === 'zomato') ? state.onlineOrderId : null,
    items: state.cart,
    discount_type: state.discount.type,
    discount_value: state.discount.value,
    notes: specialNotesInput.value.trim(),
    payment_method: selectedPayMode
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload)
    });

    const data = await res.json();
    if (data.success && data.order) {
      KotAudio.playKitchenBell();
      if (data.is_add_on) {
        showToast(`🔥 Add-On KOT sent to Kitchen! Added to Table ${state.tableName}'s bill.`, 'success');
      } else {
        showToast(`🔥 KOT Punched! Token #${data.order.token_number} sent to Kitchen.`, 'success');
      }

      // Notify mesh for 0ms cross-monitor sync
      kotSocket.notifyAction('ORDER_CREATED', data.order);

      state.cart = [];
      specialNotesInput.value = '';

      if (state.channel === 'dine_in') {
        // Re-load table running order so new items appear as existing
        await selectTable(state.tableName);
      } else {
        renderCart();
        renderMenuItems();
      }

      await loadActiveOrders();
      await loadTables();
    } else {
      showToast(data.error || 'Failed to punch KOT', 'error');
    }
  } catch (err) {
    showToast('Network error punching KOT', 'error');
  }
}

// ----------------- FINAL BILL PRINTING & SETTLEMENT ----------------- //

async function printBillAndSettle() {
  // If there are unsent items in cart, punch them first!
  if (state.cart.length > 0) {
    await punchKOT();
  }

  let targetOrder = state.activeRunningOrder;

  if (!targetOrder && state.channel === 'dine_in' && state.tableName) {
    const res = await fetch(`/api/tables/${encodeURIComponent(state.tableName)}/active-order`);
    const data = await res.json();
    if (data.has_active_order) targetOrder = data.order;
  }

  if (!targetOrder) {
    showToast('No active bill to settle!', 'warning');
    return;
  }

  const selectedPayMode = state.paymentMethod || 'cash';

  // Settle bill
  try {
    const res = await fetch(`/api/orders/${targetOrder.id}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_method: selectedPayMode })
    });
    const data = await res.json();
    if (data.success && data.order) {
      showToast(`Bill settled! Table ${targetOrder.table_name || ''} is now vacant.`, 'success');
      kotSocket.notifyAction('BILL_SETTLED', data.order);
      renderThermalBill(data.order);
      openPrintModal();
      resetToNewOrder();
      await loadActiveOrders();
      await loadTables();
    } else {
      showToast('Error settling bill', 'error');
    }
  } catch (e) {
    showToast('Failed to settle bill', 'error');
  }
}

function viewRunningBillPrint() {
  if (state.activeRunningOrder) {
    renderThermalBill(state.activeRunningOrder);
    openPrintModal();
  }
}

// ----------------- THERMAL RECEIPT RENDERING (WITH UPI QR) ----------------- //

function renderThermalBill(order) {
  const container = document.getElementById('thermal-receipt-area');
  const now = new Date(order.created_at || Date.now());
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const channelTitle = order.channel.toUpperCase().replace('_', ' ');
  const refText = order.table_name ? `TABLE: ${order.table_name}` : (order.online_order_id ? `ID: ${order.online_order_id}` : `TOKEN: ${order.token_number}`);

  let itemsRows = '';
  if (order.items && order.items.length > 0) {
    itemsRows = order.items.map(it => {
      const lineTotal = (it.price * it.quantity).toFixed(2);
      const roundTag = it.round_number && it.round_number > 1 ? ` (R${it.round_number})` : '';
      return `
        <tr style="font-size: 11px;">
          <td style="padding: 3px 0; text-align: left; font-weight: 800;">${it.item_name}${roundTag}</td>
          <td style="padding: 3px 0; text-align: center; font-weight: 800;">${it.quantity}</td>
          <td style="padding: 3px 0; text-align: right;">${it.price.toFixed(2)}</td>
          <td style="padding: 3px 0; text-align: right; font-weight: 800;">${lineTotal}</td>
        </tr>
      `;
    }).join('');
  }

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px;">
      <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${state.settings.restaurant_name}</h2>
      <div style="font-size: 10px;">${state.settings.address}</div>
      <div style="font-size: 10px;">Phone: ${state.settings.phone}</div>
      <div style="font-size: 10px; font-weight: bold; margin-top: 2px;">GSTIN: ${state.settings.gstin} | FSSAI: ${state.settings.fssai}</div>
    </div>

    <div style="display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 4px;">
      <div><strong>FINAL TAX INVOICE</strong></div>
      <div><strong>${order.order_number}</strong></div>
    </div>

    <div style="display: flex; justify-content: space-between; font-size: 10px; border-bottom: 1px dashed #000; padding-bottom: 4px; margin-bottom: 6px;">
      <div>Date: ${dateStr} ${timeStr}</div>
      <div><strong>${channelTitle} [${refText}]</strong></div>
    </div>

    ${order.waiter_name ? `<div style="font-size: 10px; margin-bottom: 4px;">Captain: ${order.waiter_name}</div>` : ''}

    <table style="width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 6px;">
      <thead>
        <tr style="border-bottom: 1px solid #000; border-top: 1px solid #000;">
          <th style="text-align: left; padding: 2px 0;">ITEM</th>
          <th style="text-align: center; padding: 2px 0;">QTY</th>
          <th style="text-align: right; padding: 2px 0;">PRICE</th>
          <th style="text-align: right; padding: 2px 0;">AMT</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRows}
      </tbody>
    </table>

    <div style="border-top: 1px dashed #000; padding-top: 4px; font-size: 10px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px; font-weight: 800;">
        <span>Item Subtotal:</span>
        <span>₹${order.subtotal.toFixed(2)}</span>
      </div>
      ${order.discount_amount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <span>Discount Applied:</span>
          <span>- ₹${order.discount_amount.toFixed(2)}</span>
        </div>
      ` : ''}
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        <span>CGST (${order.cgst_rate}%):</span>
        <span>₹${order.cgst_amount.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        <span>SGST (${order.sgst_rate}%):</span>
        <span>₹${order.sgst_amount.toFixed(2)}</span>
      </div>
      ${order.round_off ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <span>Round Off:</span>
          <span>${order.round_off >= 0 ? '+' : ''}₹${order.round_off.toFixed(2)}</span>
        </div>
      ` : ''}
      <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; border-top: 1px solid #000; padding-top: 3px; margin-top: 3px;">
        <span>GRAND TOTAL:</span>
        <span>₹${order.grand_total.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 10px; margin-top: 3px;">
        <span>Payment Method:</span>
        <span style="text-transform: uppercase;">${order.payment_method || 'CASH'} (${order.payment_status.toUpperCase()})</span>
      </div>
    </div>

    <!-- Dynamic UPI QR Code for instant payment -->
    <div style="text-align: center; margin-top: 10px; border-top: 1px dashed #000; padding-top: 8px;">
      <div style="font-size: 9px; margin-bottom: 4px;">SCAN QR TO PAY VIA UPI / GPAY / PHONEPE</div>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=upi://pay?pa=${encodeURIComponent(state.settings.upi_id)}%26pn=${encodeURIComponent(state.settings.restaurant_name)}%26am=${order.grand_total}%26cu=INR" 
           alt="UPI Payment QR" style="width: 90px; height: 90px; margin: 0 auto; display: block;" onerror="this.style.display='none'">
      <div style="font-size: 9px; font-weight: bold; margin-top: 2px;">UPI ID: ${state.settings.upi_id}</div>
      <div style="font-size: 10px; margin-top: 6px; font-style: italic;">Thank you! Visit us again!</div>
    </div>
  `;
}

// ----------------- MODALS & DRAWERS ----------------- //

function openTableModal() {
  document.getElementById('table-modal').classList.remove('hidden');
  renderTablesModal();
}

function closeTableModal() {
  document.getElementById('table-modal').classList.add('hidden');
}

let modalTableSectionFilter = 'all';

function filterTableSectionModal(section) {
  modalTableSectionFilter = section;
  document.querySelectorAll('#modal-table-section-pills .restro-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
  renderTablesModal();
}
window.filterTableSectionModal = filterTableSectionModal;

function renderTablesModal() {
  const container = document.getElementById('tables-grid-container');
  if (!container) return;

  // Build unique sections list for filter pills
  const sectionsSet = new Set();
  (state.tables || []).forEach(t => { if (t.section) sectionsSet.add(t.section); });
  const sectionPillsContainer = document.getElementById('modal-table-section-pills');
  if (sectionPillsContainer) {
    let pillsHtml = `<button class="restro-pill ${modalTableSectionFilter === 'all' ? 'active' : ''}" data-section="all" onclick="filterTableSectionModal('all')">All Sections</button>`;
    for (const sec of Array.from(sectionsSet).sort()) {
      pillsHtml += `<button class="restro-pill ${modalTableSectionFilter === sec ? 'active' : ''}" data-section="${sec}" onclick="filterTableSectionModal('${sec}')">${sec}</button>`;
    }
    sectionPillsContainer.innerHTML = pillsHtml;
  }

  const filteredTables = (state.tables || []).filter(t => {
    if (modalTableSectionFilter === 'all') return true;
    return t.section === modalTableSectionFilter;
  });

  if (filteredTables.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: #64748b;">
        <p style="font-weight: 700; font-size: 1rem;">No tables found in this section</p>
        <button class="btn-restro-orange" onclick="openAddEditTableModal()" style="margin-top: 0.75rem; padding: 0.45rem 1rem; font-size: 0.85rem;">+ Add New Table</button>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  for (const table of filteredTables) {
    const card = document.createElement('div');
    const isOccupied = table.is_occupied || Boolean(table.active_order);
    const activeOrder = table.active_order;
    card.className = `table-card-modern ${isOccupied ? 'occupied' : 'vacant'}`;

    card.innerHTML = `
      <div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
          <div>
            <div style="font-size: 1.35rem; font-weight: 900; color: #0f172a; line-height: 1.2;">
              ${table.name}
            </div>
            <div style="font-size: 0.78rem; color: #64748b; font-weight: 600; margin-top: 2px;">
              ${table.section || 'Hall'} • 👥 ${table.capacity || 4} Seats
            </div>
          </div>
          <span style="font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; background: ${isOccupied ? '#ffedd5' : '#dcfce7'}; color: ${isOccupied ? '#c2410c' : '#15803d'};">
            ${isOccupied ? '● DINING' : '● VACANT'}
          </span>
        </div>

        ${isOccupied && activeOrder ? `
          <div style="background: #ffffff; border: 1px dashed #fed7aa; border-radius: 8px; padding: 0.5rem 0.65rem; margin: 0.6rem 0;">
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
              <span style="color: #64748b; font-weight: 600;">Bill #${activeOrder.order_number}</span>
              <strong style="color: #ea580c; font-size: 1rem;">₹${activeOrder.grand_total}</strong>
            </div>
            <div style="font-size: 0.75rem; color: #0284c7; font-weight: 700; margin-top: 2px;">
              Round ${activeOrder.current_round || 1} • ${activeOrder.item_count || 0} items
            </div>
          </div>
        ` : `
          <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.5rem 0.65rem; margin: 0.6rem 0; font-size: 0.78rem; color: #15803d; font-weight: 600;">
            ✓ Table ready for seating
          </div>
        `}
      </div>

      <div style="display: flex; gap: 0.45rem; align-items: center; margin-top: 0.5rem;">
        <button class="${isOccupied ? 'btn-restro-orange' : 'btn-restro-white'}" style="flex: 1; padding: 0.45rem 0.65rem; font-size: 0.82rem; font-weight: 800; justify-content: center;" onclick="selectTable('${table.name}')">
          ${isOccupied ? 'Add Items / Bill' : 'Seat Table'}
        </button>
        <button class="btn-table-icon" title="Edit Table" onclick='openAddEditTableModal(${JSON.stringify(table)})'>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        <button class="btn-table-icon delete" title="Delete Table" onclick="deleteTablePrompt(${table.id}, '${table.name}', ${isOccupied})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </button>
      </div>
    `;

    container.appendChild(card);
  }
}

function openAddEditTableModal(table = null) {
  const modal = document.getElementById('table-form-modal');
  const title = document.getElementById('table-form-title');
  const idInput = document.getElementById('form-table-id');
  const nameInput = document.getElementById('form-table-name');
  const sectionInput = document.getElementById('form-table-section');
  const capacityInput = document.getElementById('form-table-capacity');

  if (table) {
    title.textContent = `Edit Table: ${table.name}`;
    idInput.value = table.id;
    nameInput.value = table.name;
    sectionInput.value = table.section || 'AC Hall';
    capacityInput.value = table.capacity || 4;
  } else {
    title.textContent = 'Add New Dining Table';
    idInput.value = '';
    nameInput.value = '';
    sectionInput.value = 'AC Hall';
    capacityInput.value = 4;
  }

  modal.classList.remove('hidden');
  nameInput.focus();
}
window.openAddEditTableModal = openAddEditTableModal;

function closeAddEditTableModal() {
  document.getElementById('table-form-modal').classList.add('hidden');
}
window.closeAddEditTableModal = closeAddEditTableModal;

async function handleTableFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('form-table-id').value;
  const name = document.getElementById('form-table-name').value.trim();
  const section = document.getElementById('form-table-section').value.trim() || 'AC Hall';
  const capacity = parseInt(document.getElementById('form-table-capacity').value) || 4;

  if (!name) {
    showToast('Please enter a table name/number!', 'warning');
    return;
  }

  try {
    const url = id ? `/api/tables/${id}` : '/api/tables';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, section, capacity })
    });

    const data = await res.json();
    if (data.success) {
      showToast(id ? `Table ${name} updated successfully!` : `Table ${name} created!`, 'success');
      closeAddEditTableModal();
      await loadTables();
      renderTablesModal();
      kotSocket.notifyAction('TABLE_UPDATED', { id, name });
    } else {
      showToast(data.error || 'Failed to save table', 'error');
    }
  } catch (err) {
    console.error('Error saving table:', err);
    showToast('Network error while saving table', 'error');
  }
}
window.handleTableFormSubmit = handleTableFormSubmit;

async function deleteTablePrompt(tableId, tableName, isOccupied) {
  if (isOccupied) {
    showToast(`Cannot delete ${tableName}: Table is actively occupied with seated guests! Settle bill first.`, 'warning');
    return;
  }

  if (!confirm(`Are you sure you want to delete table ${tableName}? This action cannot be undone.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/tables/${tableId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Table ${tableName} deleted successfully`, 'success');
      if (state.tableName === tableName) {
        state.tableName = null;
        state.activeRunningOrder = null;
        state.existingItems = [];
      }
      await loadTables();
      renderTablesModal();
      kotSocket.notifyAction('TABLE_UPDATED', { tableId, action: 'delete' });
    } else {
      showToast(data.error || 'Failed to delete table', 'error');
    }
  } catch (err) {
    console.error('Error deleting table:', err);
    showToast('Network error deleting table', 'error');
  }
}
window.deleteTablePrompt = deleteTablePrompt;

function openOrdersDrawer() {
  document.getElementById('orders-drawer').classList.remove('hidden');
  renderDrawerOrders();
}

function closeOrdersDrawer() {
  document.getElementById('orders-drawer').classList.add('hidden');
}

function filterDrawerOrders(filter) {
  state.drawerFilter = filter;
  document.querySelectorAll('#orders-drawer .btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderDrawerOrders();
}

function renderDrawerOrders() {
  const container = document.getElementById('drawer-orders-list');
  if (!container) return;

  let orders = state.activeOrders;
  if (state.drawerFilter !== 'all') {
    orders = orders.filter(o => o.channel === state.drawerFilter);
  }

  if (orders.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 4rem 1rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.5rem; opacity: 0.35;">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </div>
        <p style="font-size: 1rem; font-weight: 600; color: var(--text-secondary);">No active running bills</p>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Orders will appear here as soon as they are punched</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  for (const order of orders) {
    const card = document.createElement('div');
    card.className = 'order-drawer-card';

    let statusPill = '';
    if (order.status === 'pending_approval') {
      statusPill = '<span class="live-pill" style="background:#fef3c7; color:#b45309; border-color:#fde68a;"><span class="dot-pulse" style="background:#d97706"></span> Pending Approval</span>';
    } else if (order.status === 'preparing') {
      statusPill = '<span class="live-pill" style="background:#e0f2fe; color:#0369a1; border-color:#bae6fd;"><span class="dot-pulse" style="background:#0284c7"></span> Cooking in Kitchen</span>';
    } else if (order.status === 'ready') {
      statusPill = '<span class="live-pill" style="background:#dcfce7; color:#15803d; border-color:#86efac;"><span class="dot-pulse" style="background:#16a34a"></span> Ready for Service</span>';
    } else {
      statusPill = '<span class="live-pill" style="background:#f1f5f9; color:#475569; border-color:#cbd5e1;"><span class="dot-pulse" style="background:#64748b"></span> Dining / Running</span>';
    }

    // Group items by round number for clean multi-round consolidated display
    const roundGroups = {};
    (order.items || []).forEach(it => {
      const r = it.round_number || 1;
      if (!roundGroups[r]) roundGroups[r] = [];
      roundGroups[r].push(it);
    });

    let itemsHtml = '';
    const roundKeys = Object.keys(roundGroups).sort((a, b) => Number(a) - Number(b));
    for (const rNum of roundKeys) {
      const rItems = roundGroups[rNum];
      const rTag = roundKeys.length > 1 ? `<span class="round-tag ${Number(rNum) > 1 ? 'new' : ''}">Round ${rNum}</span>` : '';
      const itemsList = rItems.map(i => `<strong>${i.quantity}x</strong> ${i.item_name}`).join(', ');
      itemsHtml += `<div style="margin-bottom: 3px;">${rTag}${itemsList}</div>`;
    }

    card.innerHTML = `
      <div class="card-head">
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="badge-channel badge-${order.channel}">${order.channel.replace('_', ' ')}</span>
            <span class="table-badge">${order.table_name ? 'Table ' + order.table_name : 'Token #' + order.token_number}</span>
          </div>
          <div class="meta-line">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • Bill #${order.order_number}
            ${order.waiter_name ? ` • Waiter: ${order.waiter_name}` : ''}
          </div>
        </div>
        <div>
          ${statusPill}
        </div>
      </div>

      <div class="items-box">
        ${itemsHtml || 'No dishes registered'}
      </div>

      <div class="card-footer">
        <div>
          <span class="total-label">Consolidated Total:</span>
          <span class="total-val">₹${order.grand_total}</span>
        </div>
        <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">
          ${order.channel === 'dine_in' && order.table_name ? `
            <button class="btn btn-primary btn-sm" onclick="selectTable('${order.table_name}'); closeOrdersDrawer();" title="Add more dishes or edit bill">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
              Add Items / Edit
            </button>
          ` : ''}
          <button class="btn btn-secondary btn-sm" onclick='viewAndPrintBill(${JSON.stringify(order)})' title="Print preview">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
            Bill
          </button>
          <button class="btn btn-success btn-sm" onclick="settleSpecificOrder(${order.id})" title="Settle and mark paid">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Settle
          </button>
          <button class="btn btn-danger btn-sm" onclick="promptCancelOrder(${order.id})" title="Cancel order">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>
    `;

    container.appendChild(card);
  }
}

async function settleSpecificOrder(orderId) {
  const payMode = prompt('Enter payment method (cash, upi, card):', 'cash');
  if (!payMode) return;

  try {
    const res = await fetch(`/api/orders/${orderId}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_method: payMode })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Bill settled successfully! Table marked vacant.', 'success');
      kotSocket.notifyAction('BILL_SETTLED', data.order);
      renderThermalBill(data.order);
      openPrintModal();
      await loadActiveOrders();
      await loadTables();
      resetToNewOrder();
    }
  } catch (e) {
    showToast('Failed to settle bill', 'error');
  }
}

function viewAndPrintBill(order) {
  renderThermalBill(order);
  openPrintModal();
}

async function promptCancelOrder(orderId) {
  const reason = prompt('Please enter reason for cancelling this order:', 'Customer cancelled');
  if (reason === null) return;

  try {
    const res = await fetch(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Order #${orderId} cancelled`, 'info');
      kotSocket.notifyAction('ORDER_CANCELLED', { order_id: orderId });
      await loadActiveOrders();
      await loadTables();
      resetToNewOrder();
    }
  } catch (e) {
    showToast('Failed to cancel order', 'error');
  }
}

function openPrintModal() {
  document.getElementById('print-modal').classList.remove('hidden');
}

function printReceiptCopies(copies = 2) {
  const container = document.getElementById('thermal-receipt-area');
  if (!container) return;
  const singleHtml = container.dataset.singleCopyHtml || container.innerHTML;
  container.dataset.singleCopyHtml = singleHtml;

  if (copies === 2) {
    container.innerHTML = `
      <div class="print-copy-break">
        <div style="text-align:center; font-size:9px; font-weight:bold; letter-spacing:1px; margin-bottom:4px;">*** CUSTOMER COPY ***</div>
        ${singleHtml}
      </div>
      <div>
        <div style="text-align:center; font-size:9px; font-weight:bold; letter-spacing:1px; margin-bottom:4px;">*** COUNTER COPY ***</div>
        ${singleHtml}
      </div>
    `;
  } else {
    container.innerHTML = singleHtml;
  }

  window.print();

  // Restore clean single preview after print dialog closes
  setTimeout(() => {
    if (container.dataset.singleCopyHtml) {
      container.innerHTML = container.dataset.singleCopyHtml;
    }
  }, 500);
}
window.printReceiptCopies = printReceiptCopies;

function closePrintModal() {
  document.getElementById('print-modal').classList.add('hidden');
}

// ----------------- CUSTOM DISCOUNT MODAL ----------------- //

let customDiscountMode = 'percentage';

function setCustomDiscountMode(mode) {
  customDiscountMode = mode;
  document.getElementById('btn-mode-percent').className = `btn btn-sm ${mode === 'percentage' ? 'btn-primary' : 'btn-secondary'}`;
  document.getElementById('btn-mode-fixed').className = `btn btn-sm ${mode === 'fixed' ? 'btn-primary' : 'btn-secondary'}`;
  document.getElementById('custom-disc-label').textContent = mode === 'percentage' ? 'Discount Value (%)' : 'Discount Value (₹)';
}

function openCustomDiscountModal() {
  document.getElementById('discount-modal').classList.remove('hidden');
  setCustomDiscountMode('percentage');
  document.getElementById('custom-disc-input').value = '';
  document.getElementById('custom-disc-input').focus();
}

function closeDiscountModal() {
  document.getElementById('discount-modal').classList.add('hidden');
}

function applyCustomDiscount() {
  const val = parseFloat(document.getElementById('custom-disc-input').value) || 0;
  state.discount = {
    type: customDiscountMode,
    value: val
  };
  document.querySelectorAll('.disc-chip').forEach(c => c.classList.remove('active'));
  document.getElementById('btn-custom-discount').classList.add('active');
  closeDiscountModal();
  renderCart();
}

// ----------------- EVENT LISTENERS SETUP ----------------- //

function setupEventListeners() {
  // Channel Tab Switching
  document.querySelectorAll('.channel-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.channel-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.channel = btn.dataset.channel;
      renderChannelMetadata();
    });
  });

  // Dietary Quick Filters
  document.querySelectorAll('#dietary-filter-group .diet-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#dietary-filter-group .diet-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.dietaryFilter = pill.dataset.diet;
      renderMenuItems();
    });
  });

  // Payment Tiles Grid
  document.querySelectorAll('#payment-tiles-group .payment-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      document.querySelectorAll('#payment-tiles-group .payment-tile').forEach(t => t.classList.remove('active'));
      tile.classList.add('active');
      state.paymentMethod = tile.dataset.mode;
    });
  });

  // Search Inputs
  menuSearchInput?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    const subInput = document.getElementById('filter-search-sub');
    if (subInput && subInput.value !== e.target.value) subInput.value = e.target.value;
    renderMenuItems();
  });

  const filterSearchSub = document.getElementById('filter-search-sub');
  filterSearchSub?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    if (menuSearchInput && menuSearchInput.value !== e.target.value) menuSearchInput.value = e.target.value;
    renderMenuItems();
  });

  // Search in existing orders drawer
  const searchExistingInput = document.getElementById('search-existing-orders-input');
  searchExistingInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (q) {
      openOrdersDrawer();
    }
  });

  // Clear Cart
  document.getElementById('btn-clear-cart')?.addEventListener('click', () => {
    if (state.cart.length > 0 && confirm('Clear newly added cart items?')) {
      clearCart();
    }
  });

  // Quick Discounts
  document.querySelectorAll('.disc-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.id === 'btn-custom-discount') {
        openCustomDiscountModal();
        return;
      }
      document.querySelectorAll('.disc-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const type = chip.dataset.type === 'percent' ? 'percentage' : 'fixed';
      const val = parseFloat(chip.dataset.val) || 0;
      state.discount = { type, value: val };
      renderCart();
    });
  });

  // Punch KOT Button
  document.getElementById('btn-punch-kot').addEventListener('click', punchKOT);

  // Print Bill Button
  document.getElementById('btn-print-bill').addEventListener('click', printBillAndSettle);

  // Active Orders Drawer
  document.getElementById('btn-open-orders-drawer').addEventListener('click', openOrdersDrawer);
}

// ----------------- RUNNING ORDER EDIT & ITEM VOIDING ----------------- //

async function incrementRunningOrderItem(itemId, currentQty) {
  if (!state.activeRunningOrder) return;
  try {
    const res = await fetch(`/api/orders/${state.activeRunningOrder.id}/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: Number(currentQty) + 1 })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Item quantity increased', 'success');
      await refreshCurrentTableOrder();
      kotSocket.notifyAction('ORDER_UPDATED', { order_id: state.activeRunningOrder.id });
    } else {
      showToast(data.error || 'Failed to update item', 'error');
    }
  } catch (e) {
    showToast('Failed to update item quantity', 'error');
  }
}

async function decrementRunningOrderItem(itemId, currentQty) {
  if (!state.activeRunningOrder) return;
  if (Number(currentQty) <= 1) {
    const it = state.existingItems.find(i => i.id === itemId);
    return voidRunningOrderItem(itemId, it?.item_name || 'dish');
  }
  try {
    const res = await fetch(`/api/orders/${state.activeRunningOrder.id}/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: Number(currentQty) - 1 })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Item quantity decreased', 'info');
      await refreshCurrentTableOrder();
      kotSocket.notifyAction('ORDER_UPDATED', { order_id: state.activeRunningOrder.id });
    } else {
      showToast(data.error || 'Failed to update item', 'error');
    }
  } catch (e) {
    showToast('Failed to update item quantity', 'error');
  }
}

async function voidRunningOrderItem(itemId, itemName) {
  if (!state.activeRunningOrder) return;
  const name = itemName || 'this dish';
  if (!confirm(`Are you sure you want to void / cancel "${name}" from the active bill?`)) {
    return;
  }
  try {
    const res = await fetch(`/api/orders/${state.activeRunningOrder.id}/items/${itemId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Voided by manager' })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Voided "${name}" from running bill`, 'success');
      await refreshCurrentTableOrder();
      kotSocket.notifyAction('ORDER_UPDATED', { order_id: state.activeRunningOrder.id });
    } else {
      showToast(data.error || 'Failed to void item', 'error');
    }
  } catch (e) {
    showToast('Failed to void item from order', 'error');
  }
}

// ----------------- SHIFT TABLE / TABLE TRANSFER ----------------- //

function openShiftTableModal() {
  if (!state.activeRunningOrder || !state.tableName) {
    showToast('Select an occupied table with a running order first', 'warning');
    return;
  }

  const srcTableEl = document.getElementById('shift-source-table-label');
  if (srcTableEl) srcTableEl.textContent = `Table ${state.tableName}`;
  const srcBillEl = document.getElementById('shift-source-bill-label');
  if (srcBillEl) srcBillEl.textContent = `Bill #${state.activeRunningOrder.order_number}`;
  const srcTotEl = document.getElementById('shift-source-total-label');
  if (srcTotEl) srcTotEl.textContent = `₹${Number(state.activeRunningOrder.grand_total || 0).toFixed(2)}`;

  const sel = document.getElementById('shift-target-table-select');
  if (sel) {
    sel.innerHTML = '<option value="">-- Choose destination table --</option>';
    const occupiedNames = new Set(
      (state.activeOrders || [])
        .filter(o => o.channel === 'dine_in' && o.table_name && o.payment_status === 'unpaid')
        .map(o => o.table_name.toUpperCase())
    );

    (state.tables || []).forEach(tbl => {
      if (tbl.name.toUpperCase() === state.tableName.toUpperCase()) return;
      const isOcc = occupiedNames.has(tbl.name.toUpperCase());
      const opt = document.createElement('option');
      opt.value = tbl.name;
      opt.textContent = `${tbl.name} (${tbl.section || 'Hall'}) — ${isOcc ? '🟠 Occupied' : '🟢 Vacant'}`;
      opt.dataset.occupied = isOcc ? '1' : '0';
      sel.appendChild(opt);
    });
  }

  const conflictBox = document.getElementById('shift-conflict-box');
  if (conflictBox) conflictBox.classList.add('hidden');
  const reasonInput = document.getElementById('shift-reason-input');
  if (reasonInput) reasonInput.value = '';

  const modal = document.getElementById('modal-shift-table');
  if (modal) modal.classList.remove('hidden');
}

function closeShiftTableModal() {
  const modal = document.getElementById('modal-shift-table');
  if (modal) modal.classList.add('hidden');
}

function onShiftTargetTableChanged() {
  const sel = document.getElementById('shift-target-table-select');
  const conflictBox = document.getElementById('shift-conflict-box');
  if (!sel || !conflictBox) return;

  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.dataset.occupied === '1') {
    conflictBox.classList.remove('hidden');
  } else {
    conflictBox.classList.add('hidden');
  }
}

async function confirmShiftTable() {
  const sel = document.getElementById('shift-target-table-select');
  const targetTable = sel ? sel.value.trim() : '';
  if (!targetTable) {
    showToast('Please select a destination table', 'warning');
    return;
  }

  const conflictBox = document.getElementById('shift-conflict-box');
  const isConflictVisible = conflictBox && !conflictBox.classList.contains('hidden');
  let actionType = 'shift';
  if (isConflictVisible) {
    const radio = document.querySelector('input[name="shift_action_type"]:checked');
    actionType = radio ? radio.value : 'swap';
  }

  const reasonInput = document.getElementById('shift-reason-input');
  const reason = reasonInput ? reasonInput.value.trim() : '';

  try {
    const btn = document.getElementById('btn-confirm-shift-table');
    if (btn) btn.disabled = true;

    const res = await fetch('/api/tables/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_table: state.tableName,
        target_table: targetTable,
        action: actionType,
        reason: reason
      })
    });
    const data = await res.json();
    if (btn) btn.disabled = false;

    if (data.success) {
      showToast(data.message || `Table shifted to ${targetTable}!`, 'success');
      closeShiftTableModal();
      await loadActiveOrders();
      await selectTable(targetTable);
      kotSocket.notifyAction('TABLE_SHIFTED', { source: state.tableName, target: targetTable });
    } else {
      showToast(data.error || 'Failed to shift table', 'error');
    }
  } catch (e) {
    showToast('Error shifting table', 'error');
    const btn = document.getElementById('btn-confirm-shift-table');
    if (btn) btn.disabled = false;
  }
}

// ----------------- FULL EDIT ORDER MODAL ----------------- //

let editOrderModalState = {
  orderId: null,
  items: []
};

function openEditOrderModal() {
  if (!state.activeRunningOrder) {
    showToast('No active running order to edit', 'warning');
    return;
  }

  const ord = state.activeRunningOrder;
  editOrderModalState.orderId = ord.id;
  editOrderModalState.items = (ord.items || []).map(i => ({ ...i }));

  const subTitleEl = document.getElementById('edit-order-modal-subtitle');
  if (subTitleEl) subTitleEl.textContent = `Table ${state.tableName || ''} • Bill #${ord.order_number}`;

  const waiterInput = document.getElementById('edit-order-waiter-input');
  if (waiterInput) waiterInput.value = ord.waiter_name || state.waiterName || '';
  const phoneInput = document.getElementById('edit-order-phone-input');
  if (phoneInput) phoneInput.value = ord.customer_phone || state.customerPhone || '';
  const notesInput = document.getElementById('edit-order-notes-input');
  if (notesInput) notesInput.value = ord.notes || '';

  renderEditOrderItemsList();

  const modal = document.getElementById('modal-edit-order');
  if (modal) modal.classList.remove('hidden');
}

function closeEditOrderModal() {
  const modal = document.getElementById('modal-edit-order');
  if (modal) modal.classList.add('hidden');
}

function renderEditOrderItemsList() {
  const container = document.getElementById('edit-order-items-container');
  if (!container) return;

  if (editOrderModalState.items.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 2rem;">No items in order</div>`;
    recalcEditOrderTotals();
    return;
  }

  container.innerHTML = '';
  editOrderModalState.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0.65rem 0.85rem; gap: 0.5rem;';
    const rowTotal = it.price * it.quantity;

    row.innerHTML = `
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; gap: 0.35rem;">
          <span class="food-indicator ${it.food_type || 'veg'}" style="width: 13px; height: 13px;"></span>
          <span style="font-weight: 700; font-size: 0.92rem; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${it.item_name}</span>
          <span style="font-size: 0.7rem; background: #e2e8f0; color: #475569; padding: 1px 5px; border-radius: 4px; font-weight: 800;">R${it.round_number || 1}</span>
        </div>
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">
          ₹${it.price.toFixed(2)} each • <strong>₹${rowTotal.toFixed(2)}</strong>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <div class="restro-stepper" style="height: 28px;">
          <button class="restro-stepper-btn" onclick="adjustEditOrderItemQty(${idx}, -1)">−</button>
          <span class="restro-stepper-val" style="min-width: 22px;">${it.quantity}</span>
          <button class="restro-stepper-btn plus" onclick="adjustEditOrderItemQty(${idx}, 1)">+</button>
        </div>
        <button class="item-del-btn" onclick="voidEditOrderItem(${idx})" title="Remove item from order" style="color: #ef4444; padding: 4px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  recalcEditOrderTotals();
}

function adjustEditOrderItemQty(idx, delta) {
  const it = editOrderModalState.items[idx];
  if (!it) return;
  const newQ = it.quantity + delta;
  if (newQ <= 0) {
    editOrderModalState.items.splice(idx, 1);
  } else {
    it.quantity = newQ;
  }
  renderEditOrderItemsList();
}

function voidEditOrderItem(idx) {
  editOrderModalState.items.splice(idx, 1);
  renderEditOrderItemsList();
}

function recalcEditOrderTotals() {
  const subtotal = editOrderModalState.items.reduce((acc, it) => acc + (it.price * it.quantity), 0);
  const tax = Math.round(subtotal * 0.05 * 100) / 100;
  const grand = Math.round(subtotal + tax);

  const subEl = document.getElementById('edit-order-subtotal-val');
  if (subEl) subEl.textContent = `₹${subtotal.toFixed(2)}`;
  const taxEl = document.getElementById('edit-order-tax-val');
  if (taxEl) taxEl.textContent = `₹${tax.toFixed(2)}`;
  const grandEl = document.getElementById('edit-order-grand-total-val');
  if (grandEl) grandEl.textContent = `₹${grand.toFixed(2)}`;
}

async function saveOrderEdits() {
  if (!editOrderModalState.orderId) return;

  const waiterName = document.getElementById('edit-order-waiter-input')?.value.trim() || '';
  const customerPhone = document.getElementById('edit-order-phone-input')?.value.trim() || '';
  const notes = document.getElementById('edit-order-notes-input')?.value.trim() || '';

  try {
    const res = await fetch(`/api/orders/${editOrderModalState.orderId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: editOrderModalState.items.map(i => ({ id: i.id, quantity: i.quantity, notes: i.notes })),
        waiter_name: waiterName,
        customer_phone: customerPhone,
        notes: notes
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Order changes saved successfully!', 'success');
      closeEditOrderModal();
      await refreshCurrentTableOrder();
      kotSocket.notifyAction('ORDER_UPDATED', { order_id: editOrderModalState.orderId });
    } else {
      showToast(data.error || 'Failed to save order changes', 'error');
    }
  } catch (e) {
    showToast('Failed to save order changes', 'error');
  }
}

async function seedSampleMenuInPos() {
  try {
    const res = await fetch('/api/menu/seed-samples', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Sample menu loaded!', 'success');
      await loadMenuData();
      kotSocket.notifyAction('MENU_UPDATED', {});
    } else {
      showToast(data.error || 'Failed to load sample menu', 'error');
    }
  } catch (e) {
    showToast('Network error loading sample menu', 'error');
  }
}

window.seedSampleMenuInPos = seedSampleMenuInPos;

// Explicit Global Exports for Inline HTML Onclick Handlers & Cross-Page Integration
window.openTableModal = openTableModal;
window.closeTableModal = closeTableModal;
window.resetToNewOrder = resetToNewOrder;
window.selectTable = selectTable;
window.openOrdersDrawer = openOrdersDrawer;
window.closeOrdersDrawer = closeOrdersDrawer;
window.filterDrawerOrders = filterDrawerOrders;
window.applyCustomDiscount = applyCustomDiscount;
window.closeDiscountModal = closeDiscountModal;
window.setCustomDiscountMode = setCustomDiscountMode;
window.viewRunningBillPrint = viewRunningBillPrint;
window.openPrintModal = openPrintModal;
window.closePrintModal = closePrintModal;
window.openSettlePaymentModal = openSettlePaymentModal;
window.onCategorySelectChange = onCategorySelectChange;
window.onDietarySelectChange = onDietarySelectChange;
window.onDiningModeChange = onDiningModeChange;
window.onTableDropdownChange = onTableDropdownChange;
window.removeCartItem = removeCartItem;
window.updateCartItemQty = updateCartItemQty;
window.promptItemNote = promptItemNote;
window.incrementItem = incrementItem;
window.decrementItem = decrementItem;
window.addItemToCart = addItemToCart;
window.addToCart = addItemToCart;
window.clearCart = clearCart;
window.punchKOT = punchKOT;
window.printBillAndSettle = printBillAndSettle;
window.viewAndPrintBill = viewAndPrintBill;
window.settleSpecificOrder = settleSpecificOrder;
window.promptCancelOrder = promptCancelOrder;
window.openAddEditTableModal = openAddEditTableModal;
window.closeAddEditTableModal = closeAddEditTableModal;
window.handleTableFormSubmit = handleTableFormSubmit;
window.deleteTablePrompt = deleteTablePrompt;
window.filterTableSectionModal = filterTableSectionModal;

window.incrementRunningOrderItem = incrementRunningOrderItem;
window.decrementRunningOrderItem = decrementRunningOrderItem;
window.voidRunningOrderItem = voidRunningOrderItem;
window.openShiftTableModal = openShiftTableModal;
window.closeShiftTableModal = closeShiftTableModal;
window.onShiftTargetTableChanged = onShiftTargetTableChanged;
window.confirmShiftTable = confirmShiftTable;
window.openEditOrderModal = openEditOrderModal;
window.closeEditOrderModal = closeEditOrderModal;
window.adjustEditOrderItemQty = adjustEditOrderItemQty;
window.voidEditOrderItem = voidEditOrderItem;
window.saveOrderEdits = saveOrderEdits;

window.addEventListener('DOMContentLoaded', initPOS);
