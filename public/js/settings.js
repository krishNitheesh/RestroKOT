/**
 * Settings & Menu / Dish Management (Add, Edit, Delete, 86 Toggle)
 * Real-Time Broadcast Integration
 */

let settings = {};
let categories = [];
let menuItems = [];

async function initSettings() {
  setupTabs();
  await loadSettingsData();
  await loadMenuData();
  await loadTablesData();
  await loadReports();

  const urlParams = new URLSearchParams(window.location.search);
  const qTab = urlParams.get('tab');
  const qAction = urlParams.get('action');
  if (qTab === 'reports') {
    switchSettingsTab('tab-reports');
    if (qAction === 'handover') {
      setTimeout(openCashHandoverModal, 250);
    } else if (qAction === 'settle') {
      setTimeout(openDailySettlementModal, 250);
    }
  }

  if (typeof kotSocket !== 'undefined' && kotSocket.on) {
    kotSocket.on('MENU_UPDATED', async () => {
      await loadMenuData();
    });
    kotSocket.on('TABLE_UPDATED', async () => {
      await loadTablesData();
    });
    kotSocket.on('BILL_SETTLED', async () => {
      await loadReports();
    });
    kotSocket.on('ORDER_CREATED', async () => {
      await loadReports();
    });
    kotSocket.on('ORDER_CANCELLED', async () => {
      await loadReports();
    });
  }
}

function switchSettingsTab(paneId) {
  const tabButtons = document.querySelectorAll('.settings-tab-btn, #settings-pills .restro-pill');
  const targetBtn = Array.from(tabButtons).find(b => b.dataset.tab === paneId);
  const targetPane = document.getElementById(paneId);
  if (!targetPane) return;

  tabButtons.forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));

  if (targetBtn) targetBtn.classList.add('active');
  targetPane.classList.remove('hidden');

  // Sync sidebar active highlight
  const navDishes = document.getElementById('nav-dishes');
  const navSettings = document.getElementById('nav-settings');
  if (navDishes && navSettings) {
    if (paneId === 'tab-menu' || paneId === 'tab-categories') {
      navDishes.classList.add('active');
      navSettings.classList.remove('active');
    } else {
      navSettings.classList.add('active');
      navDishes.classList.remove('active');
    }
  }

  if (paneId === 'tab-reports') {
    loadReports();
  } else if (paneId === 'tab-tables') {
    loadTablesData();
  } else if (paneId === 'tab-categories' || paneId === 'tab-menu') {
    loadMenuData();
  } else if (paneId === 'tab-cloud') {
    loadCloudTab();
  } else if (paneId === 'tab-pins') {
    loadCaptainsList();
  }
}

function setupTabs() {
  const tabButtons = document.querySelectorAll('.settings-tab-btn, #settings-pills .restro-pill');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const paneId = btn.dataset.tab;
      window.location.hash = paneId;
      switchSettingsTab(paneId);
    });
  });

  // Open tab from URL hash if provided (e.g. /settings#tab-tables or /settings#tab-gst)
  const initialHash = window.location.hash ? window.location.hash.substring(1) : '';
  if (initialHash && document.getElementById(initialHash)) {
    switchSettingsTab(initialHash);
  }

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash ? window.location.hash.substring(1) : '';
    if (hash && document.getElementById(hash)) {
      switchSettingsTab(hash);
    }
  });
}
window.switchSettingsTab = switchSettingsTab;

// ----------------- SETTINGS DATA ----------------- //

async function loadSettingsData() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      settings = data.settings;
      document.getElementById('cfg-restaurant_name').value = settings.restaurant_name || '';
      document.getElementById('cfg-tagline').value = settings.tagline || '';
      document.getElementById('cfg-address').value = settings.address || '';
      document.getElementById('cfg-phone').value = settings.phone || '';
      document.getElementById('cfg-gstin').value = settings.gstin || '';
      document.getElementById('cfg-fssai').value = settings.fssai || '';
      document.getElementById('cfg-upi_id').value = settings.upi_id || '';

      document.getElementById('cfg-cgst_rate').value = settings.cgst_rate || '2.5';
      document.getElementById('cfg-sgst_rate').value = settings.sgst_rate || '2.5';
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveProfile(e) {
  e.preventDefault();
  const updates = {
    restaurant_name: document.getElementById('cfg-restaurant_name').value.trim(),
    tagline: document.getElementById('cfg-tagline').value.trim(),
    address: document.getElementById('cfg-address').value.trim(),
    phone: document.getElementById('cfg-phone').value.trim(),
    gstin: document.getElementById('cfg-gstin').value.trim(),
    fssai: document.getElementById('cfg-fssai').value.trim(),
    upi_id: document.getElementById('cfg-upi_id').value.trim()
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Profile details updated!', 'success');
      kotSocket.notifyAction('SETTINGS_UPDATED', updates);
    }
  } catch (err) {
    showToast('Failed to save profile', 'error');
  }
}

async function saveGST(e) {
  e.preventDefault();
  const updates = {
    cgst_rate: document.getElementById('cfg-cgst_rate').value.trim(),
    sgst_rate: document.getElementById('cfg-sgst_rate').value.trim(),
    gstin: document.getElementById('cfg-gstin').value.trim(),
    fssai: document.getElementById('cfg-fssai').value.trim()
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    if (data.success) {
      showToast('GST tax settings updated!', 'success');
      kotSocket.notifyAction('SETTINGS_UPDATED', updates);
    }
  } catch (err) {
    showToast('Failed to save GST rates', 'error');
  }
}

async function savePins(e) {
  e.preventDefault();
  const updates = {
    pin_owner: document.getElementById('pin-owner')?.value.trim() || '',
    pin_manager: document.getElementById('pin-manager')?.value.trim() || '',
    pin_kitchen: document.getElementById('pin-kitchen')?.value.trim() || '',
    pin_service: document.getElementById('pin-service')?.value.trim() || ''
  };

  try {
    const res = await fetch('/api/settings/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Station security PINs updated!', 'success');
      if (document.getElementById('pin-owner')) document.getElementById('pin-owner').value = '';
      if (document.getElementById('pin-manager')) document.getElementById('pin-manager').value = '';
      if (document.getElementById('pin-kitchen')) document.getElementById('pin-kitchen').value = '';
      if (document.getElementById('pin-service')) document.getElementById('pin-service').value = '';
    } else {
      showToast(data.error || 'Failed to update PINs', 'error');
    }
  } catch (err) {
    showToast('Network error saving PINs', 'error');
  }
}

// ----------------- MENU & DISH MANAGEMENT ----------------- //

async function loadMenuData() {
  try {
    const res = await fetch('/api/menu');
    const data = await res.json();
    if (data.success) {
      categories = data.categories || [];
      menuItems = data.items || [];
      renderMenuTable(menuItems);
      renderCategoriesTable();
      populateCategoryDropdowns();
    }
  } catch (e) {
    console.error('Failed to load menu data:', e);
  }
}

function populateCategoryDropdowns() {
  const formSelect = document.getElementById('item-form-category');
  const filterSelect = document.getElementById('menu-mgmt-cat-filter');

  if (formSelect) {
    formSelect.innerHTML = '';
    for (const cat of categories) {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = `${cat.name}`;
      formSelect.appendChild(opt);
    }
  }

  if (filterSelect) {
    filterSelect.innerHTML = '<option value="all">All Categories</option>';
    for (const cat of categories) {
      const opt = document.createElement('option');
      opt.value = cat.code;
      opt.textContent = `${cat.name}`;
      filterSelect.appendChild(opt);
    }
  }
}

function filterMenuTable() {
  const search = (document.getElementById('menu-mgmt-search')?.value || '').toLowerCase().trim();
  const catFilter = document.getElementById('menu-mgmt-cat-filter')?.value || 'all';

  let filtered = menuItems;
  if (catFilter !== 'all') {
    filtered = filtered.filter(i => i.category_code === catFilter);
  }
  if (search) {
    filtered = filtered.filter(i => i.name.toLowerCase().includes(search) || (i.description && i.description.toLowerCase().includes(search)));
  }
  renderMenuTable(filtered);
}

function renderMenuTable(itemsToRender) {
  const tbody = document.getElementById('menu-table-body');
  if (!tbody) return;

  if (itemsToRender.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3.5rem 1rem;">
          <div style="font-size: 1.1rem; font-weight: 700; color: #0f172a; margin-bottom: 0.25rem;">No Dishes in Menu</div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Your menu is clean. Click the button below to add your dishes.</p>
          <button class="btn btn-primary btn-sm" onclick="openAddDishModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            + Add First Dish
          </button>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';

  for (const item of itemsToRender) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong style="font-size: 0.95rem; color: var(--text-primary);">${item.name}</strong>
        ${item.description ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${item.description}</div>` : ''}
      </td>
      <td style="color: var(--text-secondary); font-size: 0.85rem;">${item.category_name}</td>
      <td>
        <span class="food-indicator ${item.food_type}"></span>
        <span style="font-size: 0.8rem; text-transform: capitalize; margin-left: 6px; font-weight: 500;">
          ${item.food_type.replace('_', ' ')}
        </span>
      </td>
      <td><strong style="color: #2563eb; font-size: 1rem; font-weight: 800;">₹${item.price}</strong></td>
      <td>
        <span class="live-pill" style="${item.is_available ? 'background: #dcfce7; color: #15803d; border-color: #86efac;' : 'background: #fee2e2; color: #b91c1c; border-color: #fca5a5;'}">
          ${item.is_available ? 'In Stock' : '86 / Out of Stock'}
        </span>
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-sm ${item.is_available ? 'btn-secondary' : 'btn-success'}" style="margin-right: 0.35rem;" onclick="toggleAvailability(${item.id}, ${item.is_available ? 0 : 1})" title="Toggle stock availability">
          ${item.is_available ? '86 (Out)' : 'Mark In'}
        </button>
        <button class="btn btn-secondary btn-sm" style="margin-right: 0.35rem;" onclick='openEditItemModal(${JSON.stringify(item)})' title="Edit price or details">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          Edit
        </button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteDish(${item.id}, '${item.name.replace(/'/g, "\\'")}')" title="Delete dish">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// Open modal for Adding new dish
function openAddItemModal() {
  document.getElementById('item-modal-title').textContent = 'Add New Dish';
  document.getElementById('edit-item-id').value = '';
  document.getElementById('item-form-name').value = '';
  document.getElementById('item-form-price').value = '';
  document.getElementById('item-form-desc').value = '';
  document.getElementById('item-form-type').value = 'veg';
  document.getElementById('item-form-submit-btn').textContent = 'Save Dish';
  document.getElementById('item-modal').classList.remove('hidden');
  document.getElementById('item-form-name').focus();
}

// Open modal for Editing existing dish
function openEditItemModal(item) {
  document.getElementById('item-modal-title').textContent = 'Edit Dish Details';
  document.getElementById('edit-item-id').value = item.id;
  document.getElementById('item-form-name').value = item.name;
  document.getElementById('item-form-category').value = item.category_id;
  document.getElementById('item-form-type').value = item.food_type;
  document.getElementById('item-form-price').value = item.price;
  document.getElementById('item-form-desc').value = item.description || '';
  document.getElementById('item-form-submit-btn').textContent = 'Update Dish';
  document.getElementById('item-modal').classList.remove('hidden');
}

function closeItemModal() {
  document.getElementById('item-modal').classList.add('hidden');
}

// Save dish (Insert or Update)
async function saveItemForm(e) {
  e.preventDefault();
  const id = document.getElementById('edit-item-id').value;
  const payload = {
    name: document.getElementById('item-form-name').value.trim(),
    category_id: parseInt(document.getElementById('item-form-category').value, 10),
    food_type: document.getElementById('item-form-type').value,
    price: parseFloat(document.getElementById('item-form-price').value) || 0,
    description: document.getElementById('item-form-desc').value.trim()
  };

  if (id) {
    payload.id = parseInt(id, 10);
  }

  try {
    const res = await fetch('/api/menu/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast(id ? 'Dish updated successfully!' : 'New dish added to menu!', 'success');
      kotSocket.notifyAction('MENU_UPDATED', payload);
      closeItemModal();
      await loadMenuData();
    } else {
      showToast(data.error || 'Failed to save dish', 'error');
    }
  } catch (err) {
    showToast('Failed to save dish', 'error');
  }
}

// Delete Dish
async function confirmDeleteDish(itemId, itemName) {
  if (!confirm(`Are you sure you want to delete "${itemName}" from the menu?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/menu/item/${itemId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`"${itemName}" deleted from menu`, 'info');
      kotSocket.notifyAction('MENU_UPDATED', { deleted_id: itemId });
      await loadMenuData();
    } else {
      showToast(data.error || 'Failed to delete dish', 'error');
    }
  } catch (err) {
    showToast('Network error deleting dish', 'error');
  }
}

// Toggle Stock Availability (86)
async function toggleAvailability(itemId, isAvailable) {
  try {
    const res = await fetch('/api/menu/toggle-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, isAvailable })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Dish stock status updated', 'info');
      kotSocket.notifyAction('MENU_UPDATED', { item_id: itemId, is_available: isAvailable });
      await loadMenuData();
    }
  } catch (e) {
    showToast('Failed to update stock status', 'error');
  }
}

// ----------------- CATEGORY MANAGEMENT ----------------- //

function renderCategoriesTable() {
  const tbody = document.getElementById('categories-table-body');
  if (!tbody) return;

  if (!categories || categories.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3rem 1rem;">
          <div style="font-size: 1rem; font-weight: 700; color: #0f172a; margin-bottom: 0.25rem;">No Categories Defined</div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Create categories to organize dishes on the POS menu and station screens.</p>
          <button class="btn-restro-orange btn-sm" onclick="openAddCategoryModal()">+ Add First Category</button>
        </td>
      </tr>
    `;
    return;
  }

  // Count active items per category
  const dishCounts = {};
  for (const item of menuItems) {
    if (item.category_id) {
      dishCounts[item.category_id] = (dishCounts[item.category_id] || 0) + 1;
    }
  }

  tbody.innerHTML = '';
  for (const cat of categories) {
    const count = dishCounts[cat.id] || 0;
    const catJson = JSON.stringify(cat).replace(/"/g, '&quot;');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span style="font-size: 1.4rem; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
          ${cat.icon || '🍽️'}
        </span>
      </td>
      <td>
        <strong style="font-size: 0.95rem; color: #0f172a;">${cat.name}</strong>
      </td>
      <td>
        <code style="background: #f1f5f9; padding: 2px 7px; border-radius: 6px; font-size: 0.82rem; color: #475569; font-weight: 600;">${cat.code}</code>
      </td>
      <td>
        <span style="font-size: 0.85rem; font-weight: 600; color: #64748b;">${cat.sort_order ?? 0}</span>
      </td>
      <td>
        <span class="live-pill" style="background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; font-weight: 700;">
          ${count} dish${count === 1 ? '' : 'es'}
        </span>
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-secondary btn-sm" style="margin-right: 0.35rem;" onclick='openEditCategoryModal(${catJson})' title="Edit Category">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          Edit
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteCategoryPrompt(${cat.id}, '${cat.name.replace(/'/g, "\\'")}', ${count})" title="Delete Category">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function openAddCategoryModal() {
  document.getElementById('category-form-id').value = '';
  document.getElementById('category-form-name').value = '';
  document.getElementById('category-form-code').value = '';
  document.getElementById('category-form-icon').value = '🍽️';
  document.getElementById('category-form-sort').value = (categories.length || 0) + 1;
  document.getElementById('category-modal-title').textContent = 'Add New Category';
  document.getElementById('category-form-submit-btn').textContent = 'Save Category';
  document.getElementById('category-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('category-form-name').focus(), 60);
}

function openEditCategoryModal(cat) {
  if (typeof cat === 'string') {
    try { cat = JSON.parse(cat); } catch (e) {}
  }
  document.getElementById('category-form-id').value = cat.id || '';
  document.getElementById('category-form-name').value = cat.name || '';
  document.getElementById('category-form-code').value = cat.code || '';
  document.getElementById('category-form-icon').value = cat.icon || '🍽️';
  document.getElementById('category-form-sort').value = cat.sort_order ?? 1;
  document.getElementById('category-modal-title').textContent = `Edit Category: ${cat.name}`;
  document.getElementById('category-form-submit-btn').textContent = 'Update Category';
  document.getElementById('category-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('category-form-name').focus(), 60);
}

function closeCategoryModal() {
  document.getElementById('category-modal').classList.add('hidden');
}

async function saveCategoryForm(e) {
  e.preventDefault();
  const id = document.getElementById('category-form-id').value;
  const name = document.getElementById('category-form-name').value.trim();
  const code = document.getElementById('category-form-code').value.trim();
  const icon = document.getElementById('category-form-icon').value.trim() || '🍽️';
  const sort_order = parseInt(document.getElementById('category-form-sort').value) || 0;

  if (!name) {
    showToast('Please enter category name', 'warning');
    return;
  }

  const payload = { name, code, icon, sort_order };
  if (id) payload.id = parseInt(id, 10);

  try {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast(id ? `Category "${name}" updated!` : `Category "${name}" added!`, 'success');
      closeCategoryModal();
      await loadMenuData();
      if (typeof kotSocket !== 'undefined' && kotSocket.notifyAction) {
        kotSocket.notifyAction('MENU_UPDATED', { type: 'category', id: data.category?.id });
      }
    } else {
      showToast(data.error || 'Failed to save category', 'error');
    }
  } catch (err) {
    showToast('Network error saving category', 'error');
  }
}

async function deleteCategoryPrompt(catId, catName, dishCount) {
  if (dishCount > 0) {
    alert(`Cannot delete "${catName}": It has ${dishCount} active dish(es) assigned to it.\n\nPlease delete or change the category of those dishes before removing this category.`);
    return;
  }

  if (!confirm(`Are you sure you want to delete category "${catName}"? This action cannot be undone.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/categories/${catId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Category "${catName}" deleted!`, 'success');
      await loadMenuData();
      if (typeof kotSocket !== 'undefined' && kotSocket.notifyAction) {
        kotSocket.notifyAction('MENU_UPDATED', { type: 'category_delete', id: catId });
      }
    } else {
      showToast(data.error || 'Failed to delete category', 'error');
    }
  } catch (err) {
    showToast('Network error deleting category', 'error');
  }
}

// ----------------- DAILY SALES & DAY-END BILLS (VANILLA JS) ----------------- //

let currentReportDate = new Date().toISOString().split('T')[0];
let currentDailyBills = [];
let currentSalesSummary = {};
let salesHistoryDays = [];
let currentReportSubTab = 'bills';

function getLocalDateStr() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setReportDate(mode) {
  const todayStr = getLocalDateStr();
  if (mode === 'today') {
    currentReportDate = todayStr;
  } else if (mode === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    currentReportDate = `${year}-${month}-${day}`;
  }

  const dateInput = document.getElementById('report-date-input');
  if (dateInput) dateInput.value = currentReportDate;

  updateDateButtonStyles();
  loadDailyBills(currentReportDate);
}

function onReportDateChanged() {
  const dateInput = document.getElementById('report-date-input');
  if (dateInput && dateInput.value) {
    currentReportDate = dateInput.value;
    updateDateButtonStyles();
    loadDailyBills(currentReportDate);
  }
}

function updateDateButtonStyles() {
  const todayStr = getLocalDateStr();
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const btnToday = document.getElementById('btn-report-today');
  const btnYest = document.getElementById('btn-report-yesterday');

  if (btnToday) {
    if (currentReportDate === todayStr) {
      btnToday.classList.add('btn-primary');
      btnToday.classList.remove('btn-secondary');
    } else {
      btnToday.classList.add('btn-secondary');
      btnToday.classList.remove('btn-primary');
    }
  }

  if (btnYest) {
    if (currentReportDate === yesterdayStr) {
      btnYest.classList.add('btn-primary');
      btnYest.classList.remove('btn-secondary');
    } else {
      btnYest.classList.add('btn-secondary');
      btnYest.classList.remove('btn-primary');
    }
  }
}

function switchReportSubTab(subTab) {
  currentReportSubTab = subTab;
  const btnBills = document.getElementById('subtab-btn-bills');
  const btnSettlement = document.getElementById('subtab-btn-settlement');
  const btnHandover = document.getElementById('subtab-btn-handover');
  const btnHistory = document.getElementById('subtab-btn-history');

  const viewBills = document.getElementById('report-subview-bills');
  const viewSettlement = document.getElementById('report-subview-settlement');
  const viewHandover = document.getElementById('report-subview-handover');
  const viewHistory = document.getElementById('report-subview-history');
  const filterStrip = document.getElementById('bills-filter-strip');

  const allTabs = [
    { id: 'bills', btn: btnBills, view: viewBills },
    { id: 'settlement', btn: btnSettlement, view: viewSettlement },
    { id: 'handover', btn: btnHandover, view: viewHandover },
    { id: 'history', btn: btnHistory, view: viewHistory }
  ];

  allTabs.forEach(item => {
    const isActive = (item.id === subTab);
    if (item.btn) {
      item.btn.style.borderBottomColor = isActive ? '#ea580c' : 'transparent';
      item.btn.style.color = isActive ? '#ea580c' : '#64748b';
    }
    if (item.view) {
      if (isActive) item.view.classList.remove('hidden');
      else item.view.classList.add('hidden');
    }
  });

  if (filterStrip) {
    filterStrip.style.display = (subTab === 'bills') ? 'flex' : 'none';
  }

  if (subTab === 'settlement') {
    loadDailySettlementView(currentReportDate);
  } else if (subTab === 'handover') {
    loadCashHandoverView(currentReportDate);
  } else if (subTab === 'history') {
    loadSalesHistory();
  } else if (subTab === 'bills') {
    loadDailyBills(currentReportDate);
  }
}

async function loadReports() {
  if (!currentReportDate) {
    currentReportDate = getLocalDateStr();
  }
  const dateInput = document.getElementById('report-date-input');
  if (dateInput && !dateInput.value) {
    dateInput.value = currentReportDate;
  }
  updateDateButtonStyles();
  await loadDailyBills(currentReportDate);
  if (currentReportSubTab === 'settlement') {
    await loadDailySettlementView(currentReportDate);
  } else if (currentReportSubTab === 'handover') {
    await loadCashHandoverView(currentReportDate);
  } else if (currentReportSubTab === 'history') {
    await loadSalesHistory();
  }
}

async function loadDailyBills(dateStr) {
  try {
    const res = await fetch(`/api/reports/daily-bills?date=${dateStr}`);
    const data = await res.json();
    if (data.success) {
      currentDailyBills = data.bills || [];
      currentSalesSummary = data.summary || {};

      const countEl = document.getElementById('day-bills-count');
      if (countEl) countEl.textContent = currentDailyBills.length;

      renderDailyKpiGrid(currentSalesSummary, dateStr);
      filterDailyBillsTable();
    }
  } catch (err) {
    console.error('Failed to load daily bills:', err);
  }
}

function renderDailyKpiGrid(s, dateStr) {
  const grid = document.getElementById('audit-metrics-grid');
  if (!grid) return;

  const totalSales = s.total_sales || 0;
  const paidBills = s.paid_bills || 0;
  const totalBills = s.total_bills || 0;
  const cashSales = s.cash_sales || 0;
  const upiSales = s.upi_sales || 0;
  const cardSales = s.card_sales || 0;
  const taxAmount = s.tax_amount || 0;
  const discountAmount = s.discount_amount || 0;

  const todayStr = getLocalDateStr();
  const isToday = dateStr === todayStr;
  const dateLabel = isToday ? "Today's Sales" : `Sales on ${dateStr}`;

  grid.innerHTML = `
    <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.78rem; color: #64748b; text-transform: uppercase; font-weight: 700;">${dateLabel}</span>
        <span class="live-pill" style="background: #dcfce7; color: #166534; border-color: #86efac; font-weight: 700;">
          ${paidBills} Settled
        </span>
      </div>
      <div style="font-size: 2.1rem; font-weight: 900; color: #16a34a; margin-top: 0.4rem; letter-spacing: -0.5px;">
        ₹${Math.round(totalSales).toLocaleString('en-IN')}
      </div>
      <div style="font-size: 0.8rem; color: #64748b; margin-top: 0.25rem;">
        Total Orders Punched: <strong>${totalBills}</strong> ${s.cancelled_bills > 0 ? `• <span style="color:#dc2626;">${s.cancelled_bills} Cancelled</span>` : ''}
      </div>
    </div>

    <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
      <div style="font-size: 0.78rem; color: #64748b; text-transform: uppercase; font-weight: 700;">Payment Breakdown</div>
      <div style="margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">💵 Cash Received:</span>
          <strong style="color: #0f172a;">₹${Math.round(cashSales).toLocaleString('en-IN')}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">📱 UPI Payments:</span>
          <strong style="color: #0f172a;">₹${Math.round(upiSales).toLocaleString('en-IN')}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">💳 Card / POS:</span>
          <strong style="color: #0f172a;">₹${Math.round(cardSales).toLocaleString('en-IN')}</strong>
        </div>
      </div>
    </div>

    <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
      <div style="font-size: 0.78rem; color: #64748b; text-transform: uppercase; font-weight: 700;">Channel Breakdown</div>
      <div style="margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">🍽️ Dine-In:</span>
          <strong>${s.dine_in_count || 0} bills</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">🛍️ Takeaway / Parcel:</span>
          <strong>${s.takeaway_count || 0} bills</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">🛵 Online (Swiggy/Zomato):</span>
          <strong>${s.delivery_count || 0} bills</strong>
        </div>
      </div>
    </div>

    <div style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 1.25rem; box-shadow: var(--shadow-sm);">
      <div style="font-size: 0.78rem; color: #64748b; text-transform: uppercase; font-weight: 700;">Taxes & Deductions</div>
      <div style="margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">GST Tax (CGST+SGST):</span>
          <strong style="color: #7c3aed;">₹${taxAmount.toFixed(2)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">Discounts Given:</span>
          <strong style="color: #ea580c;">₹${discountAmount.toFixed(2)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #475569;">Net Food Subtotal:</span>
          <strong>₹${Math.round(s.subtotal || 0).toLocaleString('en-IN')}</strong>
        </div>
      </div>
    </div>
  `;
}

function filterDailyBillsTable() {
  const search = (document.getElementById('report-bill-search')?.value || '').toLowerCase().trim();
  const channel = document.getElementById('report-channel-filter')?.value || 'all';
  const status = document.getElementById('report-status-filter')?.value || 'all';

  let filtered = currentDailyBills;

  if (channel !== 'all') {
    filtered = filtered.filter(b => b.channel === channel);
  }

  if (status === 'paid') {
    filtered = filtered.filter(b => b.payment_status === 'paid');
  } else if (status === 'unpaid') {
    filtered = filtered.filter(b => b.payment_status === 'unpaid' && b.status !== 'cancelled');
  } else if (status === 'cancelled') {
    filtered = filtered.filter(b => b.status === 'cancelled');
  }

  if (search) {
    filtered = filtered.filter(b => 
      (b.order_number && b.order_number.toLowerCase().includes(search)) ||
      String(b.token_number || '').includes(search) ||
      (b.table_name && b.table_name.toLowerCase().includes(search)) ||
      (b.waiter_name && b.waiter_name.toLowerCase().includes(search)) ||
      (b.items_summary && b.items_summary.toLowerCase().includes(search))
    );
  }

  renderDailyBillsTable(filtered);
}

function renderDailyBillsTable(bills) {
  const tbody = document.getElementById('daily-bills-table-body');
  if (!tbody) return;

  if (bills.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 3rem 1rem;">
          <div style="font-size: 1.05rem; font-weight: 700; color: #0f172a; margin-bottom: 0.25rem;">No Bills Found</div>
          <p style="font-size: 0.85rem; color: #64748b;">No bills recorded matching the selected date and filters.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  for (const b of bills) {
    const timeStr = b.created_at ? new Date(b.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '--';
    const isPaid = b.payment_status === 'paid';
    const isCancelled = b.status === 'cancelled';

    let statusBadge = '';
    if (isCancelled) {
      statusBadge = '<span class="live-pill" style="background:#fee2e2; color:#b91c1c; border-color:#fca5a5;">Cancelled</span>';
    } else if (isPaid) {
      statusBadge = `<span class="live-pill" style="background:#dcfce7; color:#15803d; border-color:#86efac; font-weight:700;">PAID (${(b.payment_method || 'cash').toUpperCase()})</span>`;
    } else {
      statusBadge = '<span class="live-pill" style="background:#fef3c7; color:#b45309; border-color:#fde68a;">UNPAID</span>';
    }

    const channelBadge = b.channel === 'dine_in' 
      ? `<span style="font-weight:700; color:#0f172a;">${b.table_name || 'Table'}</span> <span style="font-size:0.75rem; color:#64748b;">(Dine-In)</span>`
      : `<span style="font-weight:700; text-transform:capitalize; color:#0f172a;">${b.channel}</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong style="color: #0f172a; font-size: 0.92rem;">${b.order_number}</strong>
        <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">Token #${b.token_number}</div>
      </td>
      <td style="font-size: 0.85rem; color: #475569; font-weight: 600;">
        ${timeStr}
      </td>
      <td style="font-size: 0.88rem;">
        ${channelBadge}
        ${b.waiter_name ? `<div style="font-size: 0.74rem; color: #64748b;">Captain: ${b.waiter_name}</div>` : ''}
      </td>
      <td>
        <div style="font-size: 0.84rem; color: #1e293b; max-width: 320px; white-space: normal; line-height: 1.35;">
          ${b.items_summary || 'No items'}
        </div>
        <div style="font-size: 0.74rem; color: #64748b; margin-top: 2px;">
          ${b.item_count} items ordered
        </div>
      </td>
      <td>
        ${statusBadge}
      </td>
      <td>
        <strong style="font-size: 1.05rem; font-weight: 800; color: #0f172a;">₹${b.grand_total}</strong>
      </td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="viewBillInvoice(${b.id})" title="View and Print Thermal Tax Invoice">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
          View Bill
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadSalesHistory() {
  try {
    const res = await fetch('/api/reports/daily-sales?limit=30');
    const data = await res.json();
    if (data.success) {
      salesHistoryDays = data.days || [];
      renderSalesHistoryTable(salesHistoryDays);
    }
  } catch (err) {
    console.error('Failed to load sales history:', err);
  }
}

function renderSalesHistoryTable(days) {
  const tbody = document.getElementById('sales-history-table-body');
  if (!tbody) return;

  if (days.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 3rem 1rem;">
          <div style="font-size: 1rem; font-weight: 700; color: #0f172a;">No Sales History</div>
          <p style="font-size: 0.85rem; color: #64748b;">Sales history will accumulate automatically as bills are punched.</p>
        </td>
      </tr>
    `;
    return;
  }

  const todayStr = getLocalDateStr();
  tbody.innerHTML = '';
  for (const d of days) {
    const isToday = d.sale_date === todayStr;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong style="color: #0f172a; font-size: 0.92rem;">${d.sale_date}</strong>
        ${isToday ? '<span class="live-pill" style="margin-left: 6px; background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; font-weight:700;">Today</span>' : ''}
      </td>
      <td>
        <strong style="font-size: 1.05rem; font-weight: 800; color: #16a34a;">₹${Math.round(d.total_sales).toLocaleString('en-IN')}</strong>
      </td>
      <td>
        <span class="live-pill" style="background: #f8fafc; border-color: #e2e8f0; font-weight: 700; color: #0f172a;">
          ${d.paid_bills} / ${d.total_bills} bills
        </span>
      </td>
      <td style="font-weight: 600; color: #475569;">₹${Math.round(d.cash_sales).toLocaleString('en-IN')}</td>
      <td style="font-weight: 600; color: #475569;">₹${Math.round(d.upi_sales).toLocaleString('en-IN')}</td>
      <td style="font-weight: 600; color: #475569;">₹${Math.round(d.card_sales).toLocaleString('en-IN')}</td>
      <td style="font-weight: 700; color: #7c3aed;">₹${d.tax_amount ? d.tax_amount.toFixed(2) : '0.00'}</td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="selectHistoryDay('${d.sale_date}')">
          Inspect Bills
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function selectHistoryDay(dateStr) {
  currentReportDate = dateStr;
  const dateInput = document.getElementById('report-date-input');
  if (dateInput) dateInput.value = dateStr;
  updateDateButtonStyles();
  switchReportSubTab('bills');
  loadDailyBills(dateStr);
}

// ----------------- THERMAL BILL VIEW & PRINT (MANAGER CONSOLE) ----------------- //

async function viewBillInvoice(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`);
    const data = await res.json();
    if (data.success && data.order) {
      renderThermalBill(data.order);
      openPrintModal();
    } else {
      showToast(data.error || 'Failed to load order bill details', 'error');
    }
  } catch (err) {
    showToast('Network error loading bill receipt', 'error');
  }
}

function openPrintModal() {
  const modal = document.getElementById('print-modal');
  if (modal) modal.classList.remove('hidden');
}

function closePrintModal() {
  const modal = document.getElementById('print-modal');
  if (modal) modal.classList.add('hidden');
}

function renderThermalBill(order) {
  const container = document.getElementById('thermal-receipt-area');
  if (!container) return;

  const now = new Date(order.created_at || Date.now());
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const channelTitle = (order.channel || 'dine_in').toUpperCase().replace('_', ' ');
  const refText = order.table_name ? `TABLE: ${order.table_name}` : (order.online_order_id ? `ID: ${order.online_order_id}` : `TOKEN: ${order.token_number}`);

  let itemsRows = '';
  if (order.items && order.items.length > 0) {
    itemsRows = order.items.map(it => {
      const lineTotal = (it.price * it.quantity).toFixed(2);
      const roundTag = it.round_number && it.round_number > 1 ? ` (R${it.round_number})` : '';
      return `
        <tr>
          <td style="padding: 2px 0; text-align: left;">${it.item_name}${roundTag}</td>
          <td style="padding: 2px 0; text-align: center;">${it.quantity}</td>
          <td style="padding: 2px 0; text-align: right;">${Number(it.price).toFixed(2)}</td>
          <td style="padding: 2px 0; text-align: right;">${lineTotal}</td>
        </tr>
      `;
    }).join('');
  }

  const restName = settings.restaurant_name || 'RESTRO KOT';
  const restAddr = settings.address || '';
  const restPhone = settings.phone || '';
  const restGstin = settings.gstin || '';
  const restFssai = settings.fssai || '';

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px;">
      <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${restName}</h2>
      ${restAddr ? `<div style="font-size: 10px;">${restAddr}</div>` : ''}
      ${restPhone ? `<div style="font-size: 10px;">Phone: ${restPhone}</div>` : ''}
      ${(restGstin || restFssai) ? `<div style="font-size: 10px; font-weight: bold; margin-top: 2px;">GSTIN: ${restGstin || '--'} | FSSAI: ${restFssai || '--'}</div>` : ''}
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
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        <span>Item Subtotal:</span>
        <span>₹${Number(order.subtotal || 0).toFixed(2)}</span>
      </div>
      ${order.discount_amount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <span>Discount:</span>
          <span>- ₹${Number(order.discount_amount).toFixed(2)}</span>
        </div>
      ` : ''}
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        <span>CGST (${order.cgst_rate || 2.5}%):</span>
        <span>₹${Number(order.cgst_amount || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
        <span>SGST (${order.sgst_rate || 2.5}%):</span>
        <span>₹${Number(order.sgst_amount || 0).toFixed(2)}</span>
      </div>
      ${order.round_off ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <span>Round Off:</span>
          <span>₹${Number(order.round_off).toFixed(2)}</span>
        </div>
      ` : ''}
      <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: bold; border-top: 1px solid #000; margin-top: 4px; padding-top: 4px;">
        <span>NET PAYABLE:</span>
        <span>₹${Number(order.grand_total || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 10px; margin-top: 3px;">
        <span>Payment Status:</span>
        <span style="font-weight: bold; text-transform: uppercase;">${order.payment_status} (${(order.payment_method || 'cash').toUpperCase()})</span>
      </div>
    </div>

    <div style="text-align: center; font-size: 9px; margin-top: 8px; border-top: 1px dashed #000; padding-top: 6px;">
      <div>Thank You! Visit Again!</div>
      <div style="color: #666; font-size: 8px; margin-top: 2px;">Powered by RestroKOT POS</div>
    </div>
  `;
}

async function seedSampleMenu() {
  if (!confirm('Load 20+ authentic Indian restaurant dishes into the catalog?')) return;
  try {
    const res = await fetch('/api/menu/seed-samples', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Sample menu loaded!', 'success');
      kotSocket.notifyAction('MENU_UPDATED', {});
      await loadMenuData();
    } else {
      showToast(data.error || 'Failed to seed dishes', 'error');
    }
  } catch (e) {
    showToast('Failed to seed dishes', 'error');
  }
}

async function clearAllDishes() {
  if (!confirm('WARNING: Are you sure you want to remove ALL dishes from the menu catalog?')) return;
  try {
    const res = await fetch('/api/menu/clear-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('All dishes removed from catalog', 'info');
      kotSocket.notifyAction('MENU_UPDATED', {});
      await loadMenuData();
    } else {
      showToast(data.error || 'Failed to clear dishes', 'error');
    }
  } catch (e) {
    showToast('Failed to clear dishes', 'error');
  }
}

window.seedSampleMenu = seedSampleMenu;
window.clearAllDishes = clearAllDishes;

// ----------------- DINING TABLES MANAGEMENT ----------------- //

let diningTables = [];

async function loadTablesData() {
  try {
    const res = await fetch('/api/tables');
    const data = await res.json();
    if (data.success) {
      diningTables = data.tables || [];
      renderTablesData();
    }
  } catch (e) {
    console.error('Failed to load tables:', e);
  }
}

function renderTablesData() {
  const tbody = document.getElementById('settings-tables-tbody');
  if (!tbody) return;

  if (diningTables.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          No dining tables configured yet. Click "+ Add New Table" above!
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  for (const table of diningTables) {
    const isOccupied = table.is_occupied || Boolean(table.active_order);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong style="font-size: 1.05rem; color: #0f172a;">${table.name}</strong>
      </td>
      <td>
        <span style="font-size: 0.85rem; color: #475569; font-weight: 600;">${table.section || 'AC Hall'}</span>
      </td>
      <td>
        <span style="font-size: 0.85rem; color: #475569;">👥 ${table.capacity || 4} Seats</span>
      </td>
      <td>
        <span class="live-pill" style="font-size: 0.75rem; background: ${isOccupied ? '#ffedd5' : '#dcfce7'}; color: ${isOccupied ? '#c2410c' : '#15803d'}; border-color: ${isOccupied ? '#fed7aa' : '#86efac'};">
          <span class="dot-pulse" style="background: ${isOccupied ? '#ea580c' : '#16a34a'};"></span>
          ${isOccupied ? 'Occupied (' + (table.active_order ? '₹' + table.active_order.grand_total : 'Active') + ')' : 'Vacant'}
        </span>
      </td>
      <td style="text-align: right;">
        <div style="display: flex; gap: 0.4rem; justify-content: flex-end;">
          <button class="btn btn-secondary btn-sm" onclick='openEditTableSettingsModal(${JSON.stringify(table)})'>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            Edit
          </button>
          <button class="btn btn-secondary btn-sm" onclick="deleteTableSettings(${table.id}, '${table.name}', ${isOccupied})" style="color: #ef4444; border-color: #fca5a5;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
            Delete
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function openAddTableSettingsModal() {
  document.getElementById('edit-table-settings-id').value = '';
  document.getElementById('table-settings-name').value = '';
  document.getElementById('table-settings-section').value = 'AC Hall';
  document.getElementById('table-settings-capacity').value = 4;
  document.getElementById('table-settings-modal-title').textContent = 'Add New Dining Table';
  document.getElementById('table-settings-modal').classList.remove('hidden');
}

function openEditTableSettingsModal(table) {
  document.getElementById('edit-table-settings-id').value = table.id;
  document.getElementById('table-settings-name').value = table.name;
  document.getElementById('table-settings-section').value = table.section || 'AC Hall';
  document.getElementById('table-settings-capacity').value = table.capacity || 4;
  document.getElementById('table-settings-modal-title').textContent = `Edit Table: ${table.name}`;
  document.getElementById('table-settings-modal').classList.remove('hidden');
}

function closeTableSettingsModal() {
  document.getElementById('table-settings-modal').classList.add('hidden');
}

async function saveTableSettingsForm(e) {
  e.preventDefault();
  const id = document.getElementById('edit-table-settings-id').value;
  const name = document.getElementById('table-settings-name').value.trim();
  const section = document.getElementById('table-settings-section').value.trim() || 'AC Hall';
  const capacity = parseInt(document.getElementById('table-settings-capacity').value) || 4;

  if (!name) {
    showToast('Please enter table name/code', 'warning');
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
      showToast(id ? `Table ${name} updated!` : `Table ${name} added!`, 'success');
      closeTableSettingsModal();
      await loadTablesData();
      kotSocket.notifyAction('TABLE_UPDATED', { id, name });
    } else {
      showToast(data.error || 'Failed to save table', 'error');
    }
  } catch (err) {
    showToast('Error saving table', 'error');
  }
}

async function deleteTableSettings(tableId, tableName, isOccupied) {
  if (isOccupied) {
    showToast(`Cannot delete ${tableName}: Active order seated. Settle bill first!`, 'warning');
    return;
  }
  if (!confirm(`Delete table ${tableName}? This cannot be undone.`)) return;

  try {
    const res = await fetch(`/api/tables/${tableId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Table ${tableName} deleted`, 'success');
      await loadTablesData();
      kotSocket.notifyAction('TABLE_UPDATED', { tableId, action: 'delete' });
    } else {
      showToast(data.error || 'Failed to delete table', 'error');
    }
  } catch (err) {
    showToast('Failed to delete table', 'error');
  }
}

// ----------------- DAILY SETTLEMENT (EOD CLOSE) ----------------- //

let currentSettlementData = null;

async function loadDailySettlementView(dateStr) {
  const container = document.getElementById('settlement-container');
  if (!container) return;

  container.innerHTML = `
    <div style="text-align: center; padding: 3rem; color: #64748b;">
      <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">⏳</div>
      <div>Loading day-end settlement data for ${dateStr}...</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/reports/settlement?date=${dateStr}`);
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Failed to load settlement: ${data.error || 'Server error'}</div>`;
      return;
    }

    currentSettlementData = data;
    renderSettlementView(data);
  } catch (err) {
    container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Network error loading settlement data</div>`;
  }
}

function renderSettlementView(data) {
  const container = document.getElementById('settlement-container');
  if (!container) return;

  const dateStr = data.date;
  const isSettled = Boolean(data.is_settled);
  const s = isSettled ? data.settlement : data.live_summary;
  const unpaidOrders = data.unpaid_orders || [];
  const hasUnpaid = unpaidOrders.length > 0;

  let unpaidWarningHtml = '';
  if (hasUnpaid) {
    const tableNames = unpaidOrders.map(o => o.table_name ? `Table ${o.table_name} (₹${Number(o.grand_total).toFixed(2)})` : `Token #${o.token_number} (₹${Number(o.grand_total).toFixed(2)})`).join(', ');
    unpaidWarningHtml = `
      <div style="background: #fffbeb; border: 1.5px solid #fde68a; border-radius: 12px; padding: 1rem 1.25rem; display: flex; align-items: flex-start; gap: 0.75rem; color: #92400e;">
        <span style="font-size: 1.35rem; line-height: 1;">⚠️</span>
        <div style="flex: 1;">
          <div style="font-size: 0.92rem; font-weight: 800; margin-bottom: 2px;">Active Running Tables Unpaid (${unpaidOrders.length})</div>
          <div style="font-size: 0.8rem; line-height: 1.4;">
            The following orders are still open / unpaid: <strong>${tableNames}</strong>. 
            Before closing the day, settle or complete these orders in the POS!
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <!-- Top Status Banner -->
    <div style="background: #ffffff; border: 1.5px solid ${isSettled ? '#86efac' : '#e2e8f0'}; border-radius: 14px; padding: 1.25rem 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
      <div>
        <div style="display: flex; align-items: center; gap: 0.65rem; margin-bottom: 0.25rem;">
          <span style="font-size: 1.15rem; font-weight: 900; color: #0f172a;">Daily Settlement for ${dateStr}</span>
          ${isSettled ? `
            <span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; font-size: 0.76rem; font-weight: 800; padding: 3px 10px; border-radius: 8px; display: inline-flex; align-items: center; gap: 4px;">
              ✓ DAY CLOSED / SETTLED
            </span>
          ` : `
            <span style="background: #fef3c7; color: #b45309; border: 1px solid #fde68a; font-size: 0.76rem; font-weight: 800; padding: 3px 10px; border-radius: 8px;">
              🟠 PENDING DAY CLOSE
            </span>
          `}
        </div>
        <div style="font-size: 0.8rem; color: #64748b;">
          ${isSettled 
            ? `Settled at ${new Date(s.settled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} by <strong>${s.settled_by}</strong>`
            : `Live active register figures. Settle day at closing time to lock records.`
          }
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap;">
        ${!isSettled ? `
          <button type="button" class="btn-restro-orange" onclick="openDailySettlementModal()" style="padding: 0.55rem 1rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span>Settle Day & Close Register</span>
          </button>
        ` : `
          <button type="button" class="btn btn-secondary" onclick="openDailySettlementModal()" style="padding: 0.55rem 0.85rem; font-size: 0.82rem;">
            ✏️ Re-Settle / Update
          </button>
        `}
        <button type="button" class="btn btn-secondary" onclick="printSettlementZReport()" style="padding: 0.55rem 1rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
          <span>Print Z-Report (80mm)</span>
        </button>
      </div>
    </div>

    ${unpaidWarningHtml}

    <!-- Financial Matrix Cards -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem;">
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1.15rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Gross Sales</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #0f172a; margin-top: 4px;">₹${Number(s.gross_sales || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 2px;">Before discounts & taxes</div>
      </div>
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1.15rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Discounts Given</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #ea580c; margin-top: 4px;">-₹${Number(s.discount_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 2px;">Promotional deductions</div>
      </div>
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1.15rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase;">GST Collected</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #0284c7; margin-top: 4px;">₹${Number(s.tax_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 2px;">CGST + SGST tax</div>
      </div>
      <div style="background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 12px; padding: 1.15rem; box-shadow: 0 2px 6px rgba(34,197,94,0.1);">
        <div style="font-size: 0.75rem; font-weight: 800; color: #166534; text-transform: uppercase;">Net Realized Sales</div>
        <div style="font-size: 1.45rem; font-weight: 900; color: #15803d; margin-top: 4px;">₹${Number(s.net_sales || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
        <div style="font-size: 0.72rem; color: #166534; margin-top: 2px;">Total paid revenue collected</div>
      </div>
    </div>

    <!-- 2 Column Breakdown Grid: Payment Mode + Channel & Order Audit -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;">
      
      <!-- Payment Mode Breakdown -->
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 14px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <h4 style="font-size: 0.92rem; font-weight: 800; color: #0f172a; margin-bottom: 0.85rem; display: flex; align-items: center; gap: 0.45rem;">
          <span>💳 Payment Collection Breakdown</span>
        </h4>
        <div style="display: flex; flex-direction: column; gap: 0.65rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155; display: flex; align-items: center; gap: 6px;">💵 Cash Sales (In Drawer)</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.cash_sales || 0).toFixed(2)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155; display: flex; align-items: center; gap: 6px;">📱 UPI / QR Payments</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.upi_sales || 0).toFixed(2)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155; display: flex; align-items: center; gap: 6px;">💳 Card / Swipe POS</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.card_sales || 0).toFixed(2)}</strong>
          </div>
        </div>
      </div>

      <!-- Channel & Orders Audit -->
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 14px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <h4 style="font-size: 0.92rem; font-weight: 800; color: #0f172a; margin-bottom: 0.85rem; display: flex; align-items: center; gap: 0.45rem;">
          <span>🍽️ Sales Channels & Orders Audit</span>
        </h4>
        <div style="display: flex; flex-direction: column; gap: 0.65rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155;">Dine-In Tables</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.dine_in_sales || 0).toFixed(2)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155;">Takeaway Counters</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.takeaway_sales || 0).toFixed(2)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0.75rem; background: #f8fafc; border-radius: 8px;">
            <span style="font-weight: 700; color: #334155;">Online Delivery (Swiggy / Zomato)</span>
            <strong style="font-size: 1rem; color: #0f172a;">₹${Number(s.delivery_sales || 0).toFixed(2)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: #64748b; padding-top: 4px; border-top: 1px dashed #e2e8f0;">
            <span>Orders Summary: <strong>${s.total_orders || 0} Total</strong> (${s.paid_orders || 0} Paid, ${s.cancelled_orders || 0} Cancelled, ${s.unpaid_orders || 0} Unpaid)</span>
          </div>
        </div>
      </div>

    </div>

    <!-- Daily Cash Drawer Reconciliation & Shift Handovers -->
    <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 14px; padding: 1.25rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem; flex-wrap: wrap; gap: 0.5rem;">
        <h4 style="font-size: 0.95rem; font-weight: 800; color: #0f172a; margin: 0; display: flex; align-items: center; gap: 0.45rem;">
          <span>💰 Physical Cash Drawer Reconciliation</span>
        </h4>
        <span style="font-size: 0.8rem; font-weight: 700; color: #64748b;">
          ${(data.cash_reconciliation?.handovers || []).length} shift handover(s) recorded for this day
        </span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 0.75rem;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.75rem;">
          <div style="font-size: 0.7rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Opening Cash Float</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #0f172a; margin-top: 2px;">₹${Number(data.cash_reconciliation?.opening_float || 0).toFixed(2)}</div>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.75rem;">
          <div style="font-size: 0.7rem; font-weight: 700; color: #64748b; text-transform: uppercase;">System Cash Sales</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #16a34a; margin-top: 2px;">+₹${Number(data.cash_reconciliation?.system_cash_sales || s.cash_sales || 0).toFixed(2)}</div>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.75rem;">
          <div style="font-size: 0.7rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Petty Expenses</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #ea580c; margin-top: 2px;">-₹${Number(data.cash_reconciliation?.petty_expenses || 0).toFixed(2)}</div>
        </div>
        <div style="background: ${Number(data.cash_reconciliation?.variance || 0) < 0 ? '#fef2f2' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? '#eff6ff' : '#f0fdf4')}; border: 1.5px solid ${Number(data.cash_reconciliation?.variance || 0) < 0 ? '#fecaca' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? '#bfdbfe' : '#86efac')}; border-radius: 10px; padding: 0.75rem;">
          <div style="font-size: 0.7rem; font-weight: 800; color: ${Number(data.cash_reconciliation?.variance || 0) < 0 ? '#dc2626' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? '#1d4ed8' : '#166534')}; text-transform: uppercase;">Cash Drawer Variance</div>
          <div style="font-size: 1.15rem; font-weight: 900; color: ${Number(data.cash_reconciliation?.variance || 0) < 0 ? '#dc2626' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? '#1d4ed8' : '#15803d')}; margin-top: 2px;">
            ${Number(data.cash_reconciliation?.variance || 0) >= 0 ? '+' : ''}₹${Number(data.cash_reconciliation?.variance || 0).toFixed(2)}
          </div>
          <div style="font-size: 0.7rem; font-weight: 700; color: ${Number(data.cash_reconciliation?.variance || 0) < 0 ? '#dc2626' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? '#1d4ed8' : '#15803d')};">
            ${Number(data.cash_reconciliation?.variance || 0) === 0 ? '✓ Balanced' : (Number(data.cash_reconciliation?.variance || 0) > 0 ? 'Surplus Cash' : 'Cash Shortage')}
          </div>
        </div>
      </div>
    </div>
  `;
}

async function openDailySettlementModal() {
  const modal = document.getElementById('modal-daily-settlement');
  if (!modal) return;

  const dateStr = currentReportDate || getLocalDateStr();
  const dateDisp = document.getElementById('settle-modal-date-display');
  if (dateDisp) dateDisp.textContent = dateStr;

  try {
    const res = await fetch(`/api/reports/settlement?date=${dateStr}`);
    const data = await res.json();
    if (data.success) {
      currentSettlementData = data;
      const s = data.is_settled ? data.settlement : data.live_summary;
      const isSettled = Boolean(data.is_settled);

      const badge = document.getElementById('settle-modal-status-badge');
      if (badge) {
        if (isSettled) {
          badge.textContent = '✓ DAY SETTLED';
          badge.style.background = '#dcfce7';
          badge.style.color = '#15803d';
          badge.style.borderColor = '#86efac';
        } else {
          badge.textContent = 'PENDING DAY CLOSE';
          badge.style.background = '#fef3c7';
          badge.style.color = '#b45309';
          badge.style.borderColor = '#fde68a';
        }
      }

      const grossEl = document.getElementById('settle-kpi-gross');
      if (grossEl) grossEl.textContent = `₹${Number(s.gross_sales || 0).toFixed(2)}`;

      const taxEl = document.getElementById('settle-kpi-tax');
      if (taxEl) taxEl.textContent = `₹${Number(s.tax_amount || 0).toFixed(2)}`;

      const netEl = document.getElementById('settle-kpi-net');
      if (netEl) netEl.textContent = `₹${Number(s.net_sales || 0).toFixed(2)}`;

      const cashEl = document.getElementById('settle-kpi-cash');
      if (cashEl) cashEl.textContent = `₹${Number(s.cash_sales || 0).toFixed(2)}`;

      const upiEl = document.getElementById('settle-kpi-upi');
      if (upiEl) upiEl.textContent = `₹${Number(s.upi_sales || 0).toFixed(2)}`;

      const cardEl = document.getElementById('settle-kpi-card');
      if (cardEl) cardEl.textContent = `₹${Number(s.card_sales || 0).toFixed(2)}`;

      const countEl = document.getElementById('settle-kpi-count');
      if (countEl) countEl.textContent = `${s.paid_orders || 0} paid bills`;

      // Check unpaid tables
      const unpaidOrders = data.unpaid_orders || [];
      const alertBox = document.getElementById('settle-unpaid-alert');
      const alertText = document.getElementById('settle-unpaid-list-text');
      if (unpaidOrders.length > 0) {
        if (alertBox) alertBox.classList.remove('hidden');
        if (alertText) {
          const names = unpaidOrders.map(o => o.table_name ? `Table ${o.table_name}` : `Token #${o.token_number}`).join(', ');
          alertText.textContent = `There are ${unpaidOrders.length} active unpaid table orders (${names}). Please settle or close them first in the POS.`;
        }
      } else {
        if (alertBox) alertBox.classList.add('hidden');
      }

      const notesInput = document.getElementById('settle-input-notes');
      if (notesInput && s.notes) notesInput.value = s.notes;

      const byInput = document.getElementById('settle-input-by');
      if (byInput && s.settled_by) byInput.value = s.settled_by;

      // Populate Daily Cash Drawer Reconciliation fields
      const cashRec = data.cash_reconciliation || {};
      const floatInput = document.getElementById('settle-cash-float');
      if (floatInput) floatInput.value = Number(cashRec.opening_float || 0);

      const pettyInput = document.getElementById('settle-cash-petty');
      if (pettyInput) pettyInput.value = Number(cashRec.petty_expenses || 0);

      const actualInput = document.getElementById('settle-actual-cash');
      if (actualInput) actualInput.value = Number(cashRec.actual_cash || 0);

      // Populate denominations if recorded
      try {
        const denoms = JSON.parse(cashRec.denominations_json || '{}');
        if (denoms.d500 !== undefined) document.getElementById('settle-denom-500').value = denoms.d500;
        if (denoms.d200 !== undefined) document.getElementById('settle-denom-200').value = denoms.d200;
        if (denoms.d100 !== undefined) document.getElementById('settle-denom-100').value = denoms.d100;
        if (denoms.d50 !== undefined) document.getElementById('settle-denom-50').value = denoms.d50;
        if (denoms.d20 !== undefined) document.getElementById('settle-denom-20').value = denoms.d20;
        if (denoms.d10 !== undefined) document.getElementById('settle-denom-10').value = denoms.d10;
        if (denoms.coins !== undefined) document.getElementById('settle-denom-coins').value = denoms.coins;
      } catch (err) {}

      recalcSettleCashVariance();
    }
  } catch (e) {
    console.error('Error fetching settlement for modal:', e);
  }

  modal.classList.remove('hidden');
}

function closeDailySettlementModal() {
  const modal = document.getElementById('modal-daily-settlement');
  if (modal) modal.classList.add('hidden');
}

function toggleSettleDenominationsDrawer() {
  const d = document.getElementById('settle-denominations-drawer');
  if (d) d.classList.toggle('hidden');
}

function calcSettleDenominations() {
  const n500 = parseInt(document.getElementById('settle-denom-500')?.value, 10) || 0;
  const n200 = parseInt(document.getElementById('settle-denom-200')?.value, 10) || 0;
  const n100 = parseInt(document.getElementById('settle-denom-100')?.value, 10) || 0;
  const n50  = parseInt(document.getElementById('settle-denom-50')?.value, 10)  || 0;
  const n20  = parseInt(document.getElementById('settle-denom-20')?.value, 10)  || 0;
  const n10  = parseInt(document.getElementById('settle-denom-10')?.value, 10)  || 0;
  const coins = parseFloat(document.getElementById('settle-denom-coins')?.value) || 0;

  const total = (n500 * 500) + (n200 * 200) + (n100 * 100) + (n50 * 50) + (n20 * 20) + (n10 * 10) + coins;
  
  const totalLabel = document.getElementById('settle-denom-total-label');
  if (totalLabel) totalLabel.textContent = `₹${total.toFixed(2)}`;

  const actualInput = document.getElementById('settle-actual-cash');
  if (actualInput) {
    actualInput.value = total;
    recalcSettleCashVariance();
  }
}

function recalcSettleCashVariance() {
  const opFloat = parseFloat(document.getElementById('settle-cash-float')?.value) || 0;
  const petty = parseFloat(document.getElementById('settle-cash-petty')?.value) || 0;
  const actual = parseFloat(document.getElementById('settle-actual-cash')?.value) || 0;
  
  const sysCash = Number(currentSettlementData?.is_settled ? currentSettlementData.settlement?.cash_sales : currentSettlementData?.live_summary?.cash_sales) || 0;
  const expected = opFloat + sysCash - petty;

  const expLabel = document.getElementById('settle-expected-cash-label');
  if (expLabel) expLabel.textContent = `₹${expected.toFixed(2)}`;

  const variance = actual - expected;
  const pill = document.getElementById('settle-variance-pill');
  const valEl = document.getElementById('settle-variance-val');

  if (pill && valEl) {
    if (actual === 0 && expected === 0) {
      pill.style.background = '#f1f5f9';
      pill.style.color = '#475569';
      valEl.textContent = '₹0.00 (Balanced)';
    } else if (variance === 0) {
      pill.style.background = '#dcfce7';
      pill.style.color = '#15803d';
      valEl.textContent = '₹0.00 (Perfect Match)';
    } else if (variance > 0) {
      pill.style.background = '#eff6ff';
      pill.style.color = '#1d4ed8';
      valEl.textContent = `+₹${variance.toFixed(2)} (Cash Surplus)`;
    } else {
      pill.style.background = '#fef2f2';
      pill.style.color = '#dc2626';
      valEl.textContent = `-₹${Math.abs(variance).toFixed(2)} (Cash Shortage)`;
    }
  }
}

async function confirmDailySettlement() {
  const dateStr = currentReportDate || getLocalDateStr();
  const settledBy = document.getElementById('settle-input-by')?.value.trim() || 'Manager';
  const notes = document.getElementById('settle-input-notes')?.value.trim() || '';
  const opFloat = parseFloat(document.getElementById('settle-cash-float')?.value) || 0;
  const pettyExp = parseFloat(document.getElementById('settle-cash-petty')?.value) || 0;
  const actCash = parseFloat(document.getElementById('settle-actual-cash')?.value) || 0;

  const denoms = {
    d500: parseInt(document.getElementById('settle-denom-500')?.value, 10) || 0,
    d200: parseInt(document.getElementById('settle-denom-200')?.value, 10) || 0,
    d100: parseInt(document.getElementById('settle-denom-100')?.value, 10) || 0,
    d50: parseInt(document.getElementById('settle-denom-50')?.value, 10) || 0,
    d20: parseInt(document.getElementById('settle-denom-20')?.value, 10) || 0,
    d10: parseInt(document.getElementById('settle-denom-10')?.value, 10) || 0,
    coins: parseFloat(document.getElementById('settle-denom-coins')?.value) || 0
  };

  try {
    const res = await fetch('/api/reports/settlement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: dateStr,
        settled_by: settledBy,
        notes: notes,
        opening_float: opFloat,
        petty_expenses: pettyExp,
        actual_cash: actCash,
        denominations: denoms
      })
    });
    const data = await res.json();
    if (data.success && data.settlement) {
      showToast('Daily settlement completed successfully! Z-Report ready.', 'success');
      closeDailySettlementModal();
      await loadDailySettlementView(dateStr);
      printSettlementZReport(data.settlement);
    } else {
      showToast(data.error || 'Failed to complete settlement', 'error');
    }
  } catch (err) {
    showToast('Network error confirming settlement', 'error');
  }
}

function printSettlementZReport(settlementData) {
  const container = document.getElementById('thermal-receipt-area');
  const titleEl = document.getElementById('print-modal-title');
  const actionLabel = document.getElementById('print-action-label');
  if (!container) return;

  if (titleEl) titleEl.textContent = 'Daily Settlement Z-Report';
  if (actionLabel) actionLabel.textContent = 'Print Z-Report (80mm)';

  const s = settlementData || (currentSettlementData?.is_settled ? currentSettlementData.settlement : currentSettlementData?.live_summary) || currentSalesSummary || {};
  const dateStr = (settlementData?.settlement_date) || currentReportDate || getLocalDateStr();
  const restName = settings.restaurant_name || 'RESTRO KOT';
  const restGstin = settings.gstin || '';
  const now = new Date();
  const printTimeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 8px;">
      <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${restName}</h2>
      <div style="font-size: 11px; font-weight: bold; margin-top: 2px;">DAILY SETTLEMENT REPORT</div>
      <div style="font-size: 10px; font-weight: bold;">(EOD Z-REPORT)</div>
      ${restGstin ? `<div style="font-size: 9px; margin-top: 2px;">GSTIN: ${restGstin}</div>` : ''}
    </div>

    <div style="font-size: 10px; line-height: 1.5; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <div><strong>Report Date:</strong> ${dateStr}</div>
      <div><strong>Print Time:</strong> ${printTimeStr}</div>
      <div><strong>Settled By:</strong> ${s.settled_by || 'Manager'}</div>
      <div><strong>Status:</strong> ${s.status === 'settled' ? 'CLOSED / SETTLED' : 'ACTIVE / LIVE'}</div>
    </div>

    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">ORDER SUMMARY</div>
    <table style="width: 100%; font-size: 10px; line-height: 1.5; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>Total Orders:</td>
        <td style="text-align: right; font-weight: bold;">${s.total_orders || s.total_bills || 0}</td>
      </tr>
      <tr>
        <td>Paid Bills:</td>
        <td style="text-align: right; font-weight: bold;">${s.paid_orders || s.paid_bills || 0}</td>
      </tr>
      <tr>
        <td>Cancelled Orders:</td>
        <td style="text-align: right;">${s.cancelled_orders || s.cancelled_bills || 0}</td>
      </tr>
      <tr>
        <td>Unpaid / Open:</td>
        <td style="text-align: right;">${s.unpaid_orders || 0}</td>
      </tr>
    </table>

    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">SALES & TAX BREAKDOWN</div>
    <table style="width: 100%; font-size: 10px; line-height: 1.6; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>Gross Sales:</td>
        <td style="text-align: right;">Rs. ${Number(s.gross_sales || s.subtotal || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>(-) Total Discount:</td>
        <td style="text-align: right;">Rs. ${Number(s.discount_amount || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>(+) GST Taxes:</td>
        <td style="text-align: right;">Rs. ${Number(s.tax_amount || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>Round-off:</td>
        <td style="text-align: right;">Rs. ${Number(s.round_off || 0).toFixed(2)}</td>
      </tr>
      <tr style="border-top: 1px dashed #000; font-size: 11px; font-weight: bold;">
        <td style="padding: 4px 0;">NET SALES REVENUE:</td>
        <td style="text-align: right; padding: 4px 0;">Rs. ${Number(s.net_sales || s.total_sales || 0).toFixed(2)}</td>
      </tr>
    </table>

    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">COLLECTIONS BY PAYMENT MODE</div>
    <table style="width: 100%; font-size: 10px; line-height: 1.6; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>💵 Cash Sales:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(s.cash_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>📱 UPI / QR:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(s.upi_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>💳 Card / POS:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(s.card_sales || 0).toFixed(2)}</td>
      </tr>
    </table>

    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">DAILY CASH DRAWER RECONCILIATION</div>
    <table style="width: 100%; font-size: 10px; line-height: 1.5; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>Opening Cash Float:</td>
        <td style="text-align: right;">Rs. ${Number(s.opening_float || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>(+) Cash Sales Collected:</td>
        <td style="text-align: right;">Rs. ${Number(s.cash_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>(-) Petty Expenses:</td>
        <td style="text-align: right;">Rs. ${Number(s.petty_expenses || 0).toFixed(2)}</td>
      </tr>
      <tr style="border-top: 1px dashed #000;">
        <td>Expected Cash in Drawer:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${(Number(s.opening_float || 0) + Number(s.cash_sales || 0) - Number(s.petty_expenses || 0)).toFixed(2)}</td>
      </tr>
      <tr>
        <td>Actual Cash Counted:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(s.actual_cash || 0).toFixed(2)}</td>
      </tr>
      <tr style="font-weight: bold;">
        <td>Cash Variance:</td>
        <td style="text-align: right;">Rs. ${Number(s.cash_variance || 0).toFixed(2)} (${Number(s.cash_variance || 0) === 0 ? 'Balanced' : (Number(s.cash_variance || 0) > 0 ? 'Surplus' : 'Shortage')})</td>
      </tr>
    </table>

    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">CHANNEL BREAKDOWN</div>
    <table style="width: 100%; font-size: 10px; line-height: 1.5; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>Dine-In:</td>
        <td style="text-align: right;">Rs. ${Number(s.dine_in_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>Takeaway:</td>
        <td style="text-align: right;">Rs. ${Number(s.takeaway_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>Online Delivery:</td>
        <td style="text-align: right;">Rs. ${Number(s.delivery_sales || 0).toFixed(2)}</td>
      </tr>
    </table>

    ${s.notes ? `
      <div style="font-size: 9px; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
        <strong>Closing Notes:</strong> ${s.notes}
      </div>
    ` : ''}

    <div style="font-size: 10px; margin-top: 14px; text-align: right;">
      <div>_________________</div>
      <div style="font-size: 8px; font-weight: bold; margin-top: 2px;">Manager Signature</div>
    </div>
  `;

  openPrintModal();
}

// ----------------- CASH HANDOVER & DRAWER REGISTER ----------------- //

let currentHandovers = [];

async function loadCashHandoverView(dateStr) {
  const container = document.getElementById('handover-container');
  if (!container) return;

  container.innerHTML = `
    <div style="text-align: center; padding: 3rem; color: #64748b;">
      <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">⏳</div>
      <div>Loading cash handover records for ${dateStr}...</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/reports/cash-handover?date=${dateStr}`);
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Failed to load handover: ${data.error || 'Server error'}</div>`;
      return;
    }

    currentHandovers = data.handovers || [];
    renderHandoverView(data);
  } catch (err) {
    container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Network error loading cash handover records</div>`;
  }
}

function renderHandoverView(data) {
  const container = document.getElementById('handover-container');
  if (!container) return;

  const dateStr = data.date;
  const systemSales = Number(data.system_cash_sales || 0);
  const handovers = data.handovers || [];

  const totalActual = handovers.reduce((acc, h) => acc + Number(h.actual_cash || 0), 0);
  const netVariance = handovers.reduce((acc, h) => acc + Number(h.variance || 0), 0);

  let rowsHtml = '';
  if (handovers.length === 0) {
    rowsHtml = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 3rem 1rem; color: #94a3b8;">
          <div style="font-size: 2rem; margin-bottom: 0.35rem; opacity: 0.4;">💰</div>
          <div style="font-size: 0.92rem; font-weight: 700; color: #64748b;">No Cash Handovers Recorded for ${dateStr}</div>
          <div style="font-size: 0.78rem; margin-top: 4px;">Click "+ Record Cash Handover" to reconcile cashier drawer and record shift transfer.</div>
        </td>
      </tr>
    `;
  } else {
    rowsHtml = handovers.map((h) => {
      const varNum = Number(h.variance || 0);
      let varBadge = '';
      if (varNum === 0) {
        varBadge = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">₹0.00 (Balanced)</span>`;
      } else if (varNum > 0) {
        varBadge = `<span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">+₹${varNum.toFixed(2)} (Excess)</span>`;
      } else {
        varBadge = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">-₹${Math.abs(varNum).toFixed(2)} (Short)</span>`;
      }

      const timeStr = h.created_at ? new Date(h.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      return `
        <tr>
          <td style="font-weight: 800; color: #0f172a;">${h.shift_name || 'Full Day Close'}<div style="font-size: 0.72rem; color: #64748b; font-weight: normal;">${timeStr}</div></td>
          <td style="font-size: 0.85rem;">${h.handed_by} ➔ <strong>${h.received_by}</strong></td>
          <td style="font-size: 0.85rem;">₹${Number(h.opening_float || 0).toFixed(2)}</td>
          <td style="font-size: 0.85rem; font-weight: 700; color: #166534;">₹${Number(h.system_cash_sales || 0).toFixed(2)}</td>
          <td style="font-size: 0.85rem; color: #b91c1c;">₹${Number(h.petty_expenses || 0).toFixed(2)}</td>
          <td style="font-size: 0.85rem; font-weight: 700; color: #1d4ed8;">₹${Number(h.expected_cash || 0).toFixed(2)}</td>
          <td style="font-size: 0.95rem; font-weight: 900; color: #0f172a;">₹${Number(h.actual_cash || 0).toFixed(2)}</td>
          <td>${varBadge}</td>
          <td style="text-align: right;">
            <button class="btn btn-secondary btn-sm" onclick="printCashHandoverReceiptById(${h.id})" style="font-size: 0.76rem; padding: 3px 8px;">
              🖨️ Slip
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  container.innerHTML = `
    <!-- Top Action Row -->
    <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 14px; padding: 1.25rem 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
      <div>
        <h4 style="font-size: 1.15rem; font-weight: 900; color: #0f172a; margin-bottom: 2px;">Cash Handover & Drawer Register (${dateStr})</h4>
        <div style="font-size: 0.8rem; color: #64748b;">Record shift cash counts, float amounts, petty cash expenses and transfer receipts</div>
      </div>
      <button type="button" class="btn-restro-orange" onclick="openCashHandoverModal()" style="padding: 0.55rem 1rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 6v2m0 8v2"/></svg>
        <span>+ Record Cash Handover</span>
      </button>
    </div>

    <!-- Snapshot KPI Cards -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem;">
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase;">System Cash Sales</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #166534; margin-top: 3px;">₹${systemSales.toFixed(2)}</div>
        <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">Billed in cash today</div>
      </div>
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Handovers Count</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #0f172a; margin-top: 3px;">${handovers.length}</div>
        <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">Recorded shift transfers</div>
      </div>
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Counted Cash</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: #0f172a; margin-top: 3px;">₹${totalActual.toFixed(2)}</div>
        <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">Physically counted in drawer</div>
      </div>
      <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 12px; padding: 1rem; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
        <div style="font-size: 0.72rem; font-weight: 700; color: #64748b; text-transform: uppercase;">Net Cash Variance</div>
        <div style="font-size: 1.35rem; font-weight: 900; color: ${netVariance >= 0 ? '#15803d' : '#b91c1c'}; margin-top: 3px;">
          ${netVariance >= 0 ? '+' : ''}₹${netVariance.toFixed(2)}
        </div>
        <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">${netVariance === 0 ? 'Drawer perfectly balanced' : (netVariance > 0 ? 'Surplus cash in drawer' : 'Shortage in drawer')}</div>
      </div>
    </div>

    <!-- Handovers Table -->
    <div style="background: #ffffff; border: 1.5px solid #edf2f7; border-radius: 14px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">
      <div style="overflow-x: auto;">
        <table class="restro-table-modern">
          <thead>
            <tr>
              <th>Shift / Time</th>
              <th>Transfer (From ➔ To)</th>
              <th>Opening Float</th>
              <th>Cash Sales</th>
              <th>Petty Out</th>
              <th>Expected Cash</th>
              <th>Actual Counted</th>
              <th>Variance</th>
              <th style="text-align: right;">Slip</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function openCashHandoverModal() {
  const modal = document.getElementById('modal-cash-handover');
  if (!modal) return;

  const dateInput = document.getElementById('handover-input-date');
  if (dateInput) {
    dateInput.value = currentReportDate || getLocalDateStr();
  }

  await onHandoverDateChanged();

  // Reset inputs to clean defaults
  const floatInput = document.getElementById('handover-input-float');
  if (floatInput && !floatInput.value) floatInput.value = '1000';

  const expInput = document.getElementById('handover-input-expenses');
  if (expInput) expInput.value = '0';

  const expNotes = document.getElementById('handover-input-exp-notes');
  if (expNotes) expNotes.value = '';

  const actualInput = document.getElementById('handover-input-actual');
  if (actualInput) actualInput.value = '';

  const notesInput = document.getElementById('handover-input-notes');
  if (notesInput) notesInput.value = '';

  // Reset denominations inputs
  document.querySelectorAll('.denom-input').forEach(inp => inp.value = '');
  const denomTotal = document.getElementById('denom-calc-total');
  if (denomTotal) denomTotal.textContent = '₹0';

  recalcHandoverVariance();
  modal.classList.remove('hidden');
}

function closeCashHandoverModal() {
  const modal = document.getElementById('modal-cash-handover');
  if (modal) modal.classList.add('hidden');
}

async function onHandoverDateChanged() {
  const dateInput = document.getElementById('handover-input-date');
  const salesInput = document.getElementById('handover-input-sales');
  const targetDate = dateInput ? dateInput.value : (currentReportDate || getLocalDateStr());

  try {
    const res = await fetch(`/api/reports/cash-handover?date=${targetDate}`);
    const data = await res.json();
    if (data.success && salesInput) {
      salesInput.value = Number(data.system_cash_sales || 0).toFixed(2);
    }
  } catch (e) {}
  recalcHandoverVariance();
}

function recalcHandoverVariance(fromDenoms = false) {
  const floatVal = parseFloat(document.getElementById('handover-input-float')?.value) || 0;
  const salesVal = parseFloat(document.getElementById('handover-input-sales')?.value) || 0;
  const expVal = parseFloat(document.getElementById('handover-input-expenses')?.value) || 0;

  const expected = Math.max(0, floatVal + salesVal - expVal);
  const dispExpected = document.getElementById('handover-display-expected');
  if (dispExpected) dispExpected.textContent = `₹${expected.toFixed(2)}`;

  const actualInput = document.getElementById('handover-input-actual');
  const actualVal = actualInput ? parseFloat(actualInput.value) || 0 : 0;
  const variance = actualVal - expected;

  const dispVar = document.getElementById('handover-display-variance');
  const varBox = document.getElementById('handover-variance-box');
  const varLbl = document.getElementById('handover-variance-label');

  if (dispVar) {
    if (actualVal === 0 && !actualInput?.value) {
      dispVar.textContent = '₹0.00';
      dispVar.style.color = '#64748b';
      if (varBox) { varBox.style.background = '#f8fafc'; varBox.style.borderColor = '#cbd5e1'; }
      if (varLbl) varLbl.textContent = 'Enter actual cash counted above';
    } else if (variance === 0) {
      dispVar.textContent = '₹0.00 (Balanced)';
      dispVar.style.color = '#15803d';
      if (varBox) { varBox.style.background = '#f0fdf4'; varBox.style.borderColor = '#86efac'; }
      if (varLbl) varLbl.textContent = '✓ Physical cash matches expected amount exactly';
    } else if (variance > 0) {
      dispVar.textContent = `+₹${variance.toFixed(2)} (Excess)`;
      dispVar.style.color = '#1d4ed8';
      if (varBox) { varBox.style.background = '#eff6ff'; varBox.style.borderColor = '#bfdbfe'; }
      if (varLbl) varLbl.textContent = 'Surplus cash in drawer';
    } else {
      dispVar.textContent = `-₹${Math.abs(variance).toFixed(2)} (Shortage)`;
      dispVar.style.color = '#b91c1c';
      if (varBox) { varBox.style.background = '#fef2f2'; varBox.style.borderColor = '#fca5a5'; }
      if (varLbl) varLbl.textContent = '⚠️ Cash shortage detected in drawer!';
    }
  }
}

function toggleDenominationsDrawer() {
  const box = document.getElementById('handover-denominations-box');
  if (box) box.classList.toggle('hidden');
}

function calcDenominationsTotal() {
  let total = 0;
  document.querySelectorAll('.denom-input').forEach(inp => {
    const multiplier = parseFloat(inp.dataset.val) || 0;
    const count = parseInt(inp.value, 10) || 0;
    total += multiplier * count;
  });

  const dispTotal = document.getElementById('denom-calc-total');
  if (dispTotal) dispTotal.textContent = `₹${total}`;

  const actualInput = document.getElementById('handover-input-actual');
  if (actualInput) {
    actualInput.value = total;
  }
  recalcHandoverVariance(true);
}

async function saveCashHandoverForm(e) {
  if (e) e.preventDefault();

  const handoverDate = document.getElementById('handover-input-date').value;
  const shiftName = document.getElementById('handover-input-shift').value;
  const handedBy = document.getElementById('handover-input-handed').value.trim();
  const receivedBy = document.getElementById('handover-input-received').value.trim();
  const openingFloat = parseFloat(document.getElementById('handover-input-float').value) || 0;
  const systemSales = parseFloat(document.getElementById('handover-input-sales').value) || 0;
  const pettyExpenses = parseFloat(document.getElementById('handover-input-expenses').value) || 0;
  const actualCash = parseFloat(document.getElementById('handover-input-actual').value) || 0;
  const expNotes = document.getElementById('handover-input-exp-notes').value.trim();
  const notes = document.getElementById('handover-input-notes').value.trim();

  const combinedNotes = expNotes ? (notes ? `${notes} | Expenses: ${expNotes}` : `Expenses: ${expNotes}`) : notes;

  const denoms = {};
  document.querySelectorAll('.denom-input').forEach(inp => {
    const v = parseInt(inp.value, 10) || 0;
    if (v > 0) denoms[inp.dataset.val] = v;
  });

  try {
    const res = await fetch('/api/reports/cash-handover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handover_date: handoverDate,
        shift_name: shiftName,
        handed_by: handedBy,
        received_by: receivedBy,
        opening_float: openingFloat,
        system_cash_sales: systemSales,
        petty_expenses: pettyExpenses,
        actual_cash: actualCash,
        denominations: denoms,
        notes: combinedNotes
      })
    });
    const data = await res.json();
    if (data.success && data.handover) {
      showToast('Cash handover recorded successfully!', 'success');
      closeCashHandoverModal();
      await loadCashHandoverView(handoverDate);
      printCashHandoverReceipt(data.handover);
    } else {
      showToast(data.error || 'Failed to save cash handover', 'error');
    }
  } catch (err) {
    showToast('Network error saving handover', 'error');
  }
}

function printCashHandoverReceiptById(id) {
  const h = currentHandovers.find(x => x.id === id);
  if (h) printCashHandoverReceipt(h);
}

function printCashHandoverReceipt(h) {
  const container = document.getElementById('thermal-receipt-area');
  const titleEl = document.getElementById('print-modal-title');
  const actionLabel = document.getElementById('print-action-label');
  if (!container) return;

  if (titleEl) titleEl.textContent = 'Cash Drawer Handover Slip';
  if (actionLabel) actionLabel.textContent = 'Print Handover Slip (80mm)';

  const restName = settings.restaurant_name || 'RESTRO KOT';
  const now = new Date(h.created_at || Date.now());
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const varNum = Number(h.variance || 0);
  const varText = varNum === 0 ? 'Rs. 0.00 (BALANCED)' : (varNum > 0 ? `+Rs. ${varNum.toFixed(2)} (EXCESS)` : `-Rs. ${Math.abs(varNum).toFixed(2)} (SHORTAGE)`);

  let denomsText = '';
  try {
    const d = typeof h.denominations_json === 'string' ? JSON.parse(h.denominations_json) : h.denominations_json;
    if (d && Object.keys(d).length > 0) {
      denomsText = Object.entries(d).map(([k, v]) => `  Rs.${k} x ${v} = Rs.${Number(k)*Number(v)}`).join('<br>');
    }
  } catch (e) {}

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 8px;">
      <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${restName}</h2>
      <div style="font-size: 11px; font-weight: bold; margin-top: 3px;">CASH DRAWER HANDOVER SLIP</div>
    </div>

    <div style="font-size: 10px; line-height: 1.5; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <div><strong>Date:</strong> ${dateStr} ${timeStr}</div>
      <div><strong>Shift:</strong> ${h.shift_name || 'Full Day Close'}</div>
      <div><strong>Handed By:</strong> ${h.handed_by}</div>
      <div><strong>Received By:</strong> ${h.received_by}</div>
    </div>

    <table style="width: 100%; font-size: 10px; line-height: 1.6; border-collapse: collapse; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
      <tr>
        <td>1. Opening Float:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(h.opening_float || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>2. (+) Cash Sales:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(h.system_cash_sales || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td>3. (-) Petty Expenses:</td>
        <td style="text-align: right; font-weight: bold;">Rs. ${Number(h.petty_expenses || 0).toFixed(2)}</td>
      </tr>
      <tr style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; font-weight: bold;">
        <td style="padding: 4px 0;">EXPECTED CASH:</td>
        <td style="text-align: right; padding: 4px 0;">Rs. ${Number(h.expected_cash || 0).toFixed(2)}</td>
      </tr>
      <tr style="font-size: 11px; font-weight: bold;">
        <td style="padding: 4px 0;">ACTUAL COUNTED:</td>
        <td style="text-align: right; padding: 4px 0;">Rs. ${Number(h.actual_cash || 0).toFixed(2)}</td>
      </tr>
      <tr style="font-weight: bold;">
        <td style="padding: 2px 0;">VARIANCE:</td>
        <td style="text-align: right; padding: 2px 0;">${varText}</td>
      </tr>
    </table>

    ${denomsText ? `
      <div style="font-size: 9px; line-height: 1.4; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 2px;">Denominations Counted:</div>
        ${denomsText}
      </div>
    ` : ''}

    ${h.notes ? `
      <div style="font-size: 9px; margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px;">
        <strong>Notes:</strong> ${h.notes}
      </div>
    ` : ''}

    <div style="font-size: 10px; margin-top: 14px; display: flex; justify-content: space-between;">
      <div>
        <div>_________________</div>
        <div style="font-size: 8px; font-weight: bold; margin-top: 2px;">Cashier Sign</div>
      </div>
      <div style="text-align: right;">
        <div>_________________</div>
        <div style="font-size: 8px; font-weight: bold; margin-top: 2px;">Manager Sign</div>
      </div>
    </div>
  `;

  openPrintModal();
}

window.openAddItemModal = openAddItemModal;
window.openAddDishModal = openAddItemModal;
window.openEditItemModal = openEditItemModal;
window.closeItemModal = closeItemModal;
window.saveItemForm = saveItemForm;
window.confirmDeleteDish = confirmDeleteDish;
window.toggleAvailability = toggleAvailability;
window.filterMenuTable = filterMenuTable;

window.renderCategoriesTable = renderCategoriesTable;
window.openAddCategoryModal = openAddCategoryModal;
window.openEditCategoryModal = openEditCategoryModal;
window.closeCategoryModal = closeCategoryModal;
window.saveCategoryForm = saveCategoryForm;
window.deleteCategoryPrompt = deleteCategoryPrompt;

window.saveProfile = saveProfile;
window.saveGST = saveGST;
window.savePins = savePins;

window.openAddTableSettingsModal = openAddTableSettingsModal;
window.openEditTableSettingsModal = openEditTableSettingsModal;
window.closeTableSettingsModal = closeTableSettingsModal;
window.saveTableSettingsForm = saveTableSettingsForm;
window.deleteTableSettings = deleteTableSettings;

window.setReportDate = setReportDate;
window.onReportDateChanged = onReportDateChanged;
window.switchReportSubTab = switchReportSubTab;
window.loadReports = loadReports;
window.filterDailyBillsTable = filterDailyBillsTable;
window.selectHistoryDay = selectHistoryDay;
window.viewBillInvoice = viewBillInvoice;
window.openPrintModal = openPrintModal;
window.closePrintModal = closePrintModal;

window.openDailySettlementModal = openDailySettlementModal;
window.closeDailySettlementModal = closeDailySettlementModal;
window.confirmDailySettlement = confirmDailySettlement;
window.printSettlementZReport = printSettlementZReport;
window.toggleSettleDenominationsDrawer = toggleSettleDenominationsDrawer;
window.calcSettleDenominations = calcSettleDenominations;
window.recalcSettleCashVariance = recalcSettleCashVariance;

window.openCashHandoverModal = openCashHandoverModal;
window.closeCashHandoverModal = closeCashHandoverModal;
window.onHandoverDateChanged = onHandoverDateChanged;
window.recalcHandoverVariance = recalcHandoverVariance;
window.toggleDenominationsDrawer = toggleDenominationsDrawer;
window.calcDenominationsTotal = calcDenominationsTotal;
window.saveCashHandoverForm = saveCashHandoverForm;
window.printCashHandoverReceipt = printCashHandoverReceipt;
window.printCashHandoverReceiptById = printCashHandoverReceiptById;

// ----------------------------------------------------------------------------
// CLOUD BACKUP & DISASTER RECOVERY CONTROLLER
// ----------------------------------------------------------------------------

async function loadCloudTab() {
  try {
    const res = await fetch('/api/cloud/status');
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || 'Failed to load cloud status', 'error');
      return;
    }

    const cfg = data.config || {};
    
    // Update Hero elements
    const lastPushEl = document.getElementById('cloud-last-push-text');
    if (lastPushEl) {
      lastPushEl.textContent = cfg.last_push ? cfg.last_push : 'Never pushed yet';
    }

    const lastPullEl = document.getElementById('cloud-last-pull-text');
    if (lastPullEl) {
      lastPullEl.textContent = cfg.last_pull ? cfg.last_pull : 'Never (Original Database)';
    }

    const countEl = document.getElementById('cloud-snapshots-count');
    if (countEl) {
      const total = data.vault_files_count || data.backup_count || 0;
      countEl.textContent = `${total} Snapshot${total === 1 ? '' : 's'}`;
    }

    const providerEl = document.getElementById('cloud-provider-text');
    if (providerEl) {
      providerEl.textContent = cfg.provider === 'webhook_http' ? 'Custom Cloud Webhook' : 'RestroKOT Cloud Vault';
    }

    const resolvedDirEl = document.getElementById('cloud-resolved-dir');
    if (resolvedDirEl) {
      resolvedDirEl.textContent = cfg.resolved_vault_dir || 'data/cloud_vault';
    }

    // Populate configuration form
    const selProvider = document.getElementById('cloud-form-provider');
    if (selProvider) selProvider.value = cfg.provider || 'cloud_vault';

    const inVaultPath = document.getElementById('cloud-form-vault-path');
    if (inVaultPath) inVaultPath.value = cfg.vault_path || '';

    const inEndpointUrl = document.getElementById('cloud-form-endpoint-url');
    if (inEndpointUrl) inEndpointUrl.value = cfg.endpoint_url || '';

    const chkAutoSettle = document.getElementById('cloud-form-auto-settle');
    if (chkAutoSettle) chkAutoSettle.checked = Boolean(cfg.auto_settle);

    const chkAutoHourly = document.getElementById('cloud-form-auto-hourly');
    if (chkAutoHourly) chkAutoHourly.checked = Boolean(cfg.auto_hourly);

    toggleCloudProviderFields();
    await loadCloudBackupsList();
  } catch (err) {
    console.error('loadCloudTab error:', err);
    showToast('Network error loading cloud status', 'error');
  }
}

function toggleCloudProviderFields() {
  const provider = document.getElementById('cloud-form-provider')?.value || 'cloud_vault';
  const groupVault = document.getElementById('group-vault-path');
  const groupUrl = document.getElementById('group-endpoint-url');
  const groupKey = document.getElementById('group-api-key');

  if (provider === 'webhook_http') {
    if (groupVault) groupVault.classList.add('hidden');
    if (groupUrl) groupUrl.classList.remove('hidden');
    if (groupKey) groupKey.classList.remove('hidden');
  } else {
    if (groupVault) groupVault.classList.remove('hidden');
    if (groupUrl) groupUrl.classList.add('hidden');
    if (groupKey) groupKey.classList.add('hidden');
  }
}

async function triggerManualCloudPush() {
  const btn = document.getElementById('btn-cloud-push');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="restro-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
      <span>☁️ Creating Snapshot & Pushing...</span>
    `;
  }

  try {
    const res = await fetch('/api/cloud/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'manual', notes: 'Manual push from Manager Desk' })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`☁️ Cloud Backup Created! (${data.backup.filename})`, 'success');
      await loadCloudTab();
    } else {
      showToast(data.message || 'Cloud push failed', 'error');
    }
  } catch (err) {
    console.error('triggerManualCloudPush error:', err);
    showToast('Network error pushing to cloud', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function confirmCloudPullPrompt(targetFilename = null) {
  const label = targetFilename ? targetFilename : 'the latest cloud snapshot';
  const confirmMsg = `⚠️ RESTORE RESTAURANT DATABASE FROM CLOUD?\n\nTarget Snapshot: ${label}\n\n🛡️ Safety Guarantee:\nA safety rollback backup of your current live database will be created automatically before restoring.\n\nAre you sure you want to pull and overwrite the current database?`;
  
  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById('btn-cloud-pull');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="restro-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
      <span>⬇️ Pulling & Restoring...</span>
    `;
  }

  try {
    const res = await fetch('/api/cloud/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: targetFilename })
    });
    const data = await res.json();
    if (data.success) {
      alert(`🎉 DATABASE RESTORED SUCCESSFULLY!\n\nRestored from: ${data.result.restored_from}\nRollback copy saved: ${data.result.rollback_file}\nTime: ${data.result.restored_at}`);
      showToast('Database restored successfully from cloud!', 'success');
      await loadCloudTab();
      // Reload reports in case data changed
      if (typeof loadReports === 'function') loadReports();
    } else {
      alert(`❌ Restore Failed: ${data.message}`);
      showToast(data.message || 'Cloud pull failed', 'error');
    }
  } catch (err) {
    console.error('confirmCloudPullPrompt error:', err);
    showToast('Network error pulling from cloud', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function saveCloudConfigForm(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('btn-save-cloud-config');
  if (btn) btn.disabled = true;

  const payload = {
    cloud_provider: document.getElementById('cloud-form-provider')?.value || 'cloud_vault',
    cloud_vault_path: document.getElementById('cloud-form-vault-path')?.value || '',
    cloud_endpoint_url: document.getElementById('cloud-form-endpoint-url')?.value || '',
    cloud_api_key: document.getElementById('cloud-form-api-key')?.value || '',
    cloud_auto_settle: document.getElementById('cloud-form-auto-settle')?.checked ? '1' : '0',
    cloud_auto_hourly: document.getElementById('cloud-form-auto-hourly')?.checked ? '1' : '0'
  };

  try {
    const res = await fetch('/api/cloud/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cloud configuration saved successfully!', 'success');
      await loadCloudTab();
    } else {
      showToast(data.message || 'Failed to save configuration', 'error');
    }
  } catch (err) {
    console.error('saveCloudConfigForm error:', err);
    showToast('Network error saving cloud configuration', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadCloudBackupsList() {
  const tbody = document.getElementById('cloud-backups-table-body');
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="6" style="text-align: center; padding: 2rem; color: #94a3b8;">
        <svg class="restro-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-bottom: 0.5rem;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
        <div>Loading cloud snapshots...</div>
      </td>
    </tr>
  `;

  try {
    const res = await fetch('/api/cloud/backups');
    const data = await res.json();
    if (!data.success || !data.backups || data.backups.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 2.5rem; color: #94a3b8;">
            <div style="font-size: 1.75rem; margin-bottom: 0.5rem;">☁️</div>
            <div style="font-weight: 700; color: #475569; margin-bottom: 0.25rem;">No cloud snapshots yet</div>
            <div style="font-size: 0.82rem;">Click <strong>Push to Cloud Now</strong> above to create your first safe backup snapshot.</div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = data.backups.map((b, idx) => {
      const isLatest = idx === 0;
      const sizeKb = (b.file_size / 1024).toFixed(1);
      const sizeStr = b.file_size > 1048576 ? `${(b.file_size / 1048576).toFixed(2)} MB` : `${sizeKb} KB`;
      
      let triggerBadge = '';
      if (b.trigger_type === 'settlement') {
        triggerBadge = '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 7px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">🌙 EOD Settlement</span>';
      } else if (b.trigger_type === 'hourly') {
        triggerBadge = '<span style="background: #f1f5f9; color: #475569; padding: 2px 7px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">⏱️ Hourly Sync</span>';
      } else {
        triggerBadge = '<span style="background: #dbeafe; color: #1e40af; padding: 2px 7px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">👤 Manual Push</span>';
      }

      return `
        <tr style="${isLatest ? 'background: #f8fafc;' : ''}">
          <td>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 1.1rem;">🗄️</span>
              <div>
                <div style="font-weight: 800; color: #0f172a; font-size: 0.88rem; display: flex; align-items: center; gap: 0.4rem;">
                  <span>${b.backup_filename}</span>
                  ${isLatest ? '<span style="background: #dcfce7; color: #15803d; font-size: 0.68rem; padding: 1px 6px; border-radius: 10px; font-weight: 800;">LATEST</span>' : ''}
                </div>
                <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">
                  📅 ${b.created_at} • By: ${b.pushed_by || 'Manager'}
                </div>
              </div>
            </div>
          </td>
          <td>${triggerBadge}</td>
          <td><strong style="color: #334155;">${sizeStr}</strong></td>
          <td>
            <div style="font-weight: 700; color: #0f172a;">${b.total_orders || 0} Orders</div>
            <div style="font-size: 0.76rem; color: #16a34a; font-weight: 700;">₹${(b.net_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})} Sales</div>
          </td>
          <td>
            <span style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; font-weight: 700; color: #16a34a;">
              <span style="display: inline-block; width: 6px; height: 6px; background: #22c55e; border-radius: 50%;"></span>
              Synced
            </span>
          </td>
          <td style="text-align: right;">
            <div style="display: inline-flex; align-items: center; gap: 0.5rem;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="confirmCloudPullPrompt('${b.backup_filename}')"
                      style="font-weight: 700; padding: 0.35rem 0.65rem; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 0.3rem;"
                      title="Restore database to this snapshot">
                <span>⬇️ Restore</span>
              </button>
              <a href="/api/cloud/download/${encodeURIComponent(b.backup_filename)}" class="btn btn-secondary btn-sm"
                 style="font-weight: 700; padding: 0.35rem 0.65rem; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 0.3rem; text-decoration: none;"
                 title="Download snapshot file">
                <span>💾 .db</span>
              </a>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('loadCloudBackupsList error:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 1.5rem; color: #ef4444;">
          Failed to load cloud backup history.
        </td>
      </tr>
    `;
  }
}

// ----------------------------------------------------------------------------
// CAPTAINS & WAITER STAFF CONTROLLER
// ----------------------------------------------------------------------------

async function loadCaptainsList() {
  const tbody = document.getElementById('captains-table-body');
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="6" style="text-align: center; padding: 1.5rem; color: #94a3b8;">
        Loading captains...
      </td>
    </tr>
  `;

  try {
    const res = await fetch('/api/captains');
    const data = await res.json();
    if (!data.success || !Array.isArray(data.captains) || data.captains.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 2rem; color: #64748b;">
            No captains found. Click <strong>Add New Captain</strong> to create one.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = data.captains.map(c => `
      <tr>
        <td>
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <div style="background: #e0f2fe; color: #0284c7; width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; font-weight: 800;">
              👨‍✈️
            </div>
            <div>
              <div style="font-weight: 800; color: #0f172a; font-size: 0.92rem;">${c.display_name}</div>
              <div style="font-size: 0.75rem; color: #64748b;">ID #${c.id}</div>
            </div>
          </div>
        </td>
        <td>
          <span style="background: #f1f5f9; color: #334155; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;">
            ${c.role}
          </span>
        </td>
        <td>
          <span style="font-family: monospace; font-size: 0.85rem; letter-spacing: 2px; color: #64748b;">••••</span>
        </td>
        <td>
          <span style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; font-weight: 700; color: #16a34a;">
            <span style="display: inline-block; width: 6px; height: 6px; background: #22c55e; border-radius: 50%;"></span>
            Active
          </span>
        </td>
        <td style="color: #64748b; font-size: 0.82rem;">${c.created_at || '—'}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; align-items: center; gap: 0.4rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openEditCaptainModal(${c.id}, '${c.display_name.replace(/'/g, "\\'")}')"
                    style="font-size: 0.78rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid #cbd5e1; cursor: pointer;">
              ✏️ Edit
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="deleteCaptain(${c.id}, '${c.display_name.replace(/'/g, "\\'")}')"
                    style="font-size: 0.78rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid #fecaca; color: #dc2626; background: #fff5f5; cursor: pointer;"
                    ${data.captains.length <= 1 ? 'disabled title="At least one captain must remain"' : ''}>
              🗑️ Remove
            </button>
          </div>
        </td>
      </tr>
    `).join('');

  } catch (err) {
    console.error('loadCaptainsList error:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 1.5rem;">Failed to load captains.</td></tr>`;
  }
}

function openAddCaptainModal() {
  document.getElementById('edit-captain-id').value = '';
  document.getElementById('captain-modal-title').textContent = 'Add New Captain';
  document.getElementById('captain-form-name').value = '';
  document.getElementById('captain-form-pin').value = '';
  document.getElementById('captain-form-pin').required = true;
  document.getElementById('captain-pin-label').textContent = 'Login PIN (4-6 digits) *';
  document.getElementById('captain-pin-hint').textContent = 'Required for new captains.';
  document.getElementById('captain-modal')?.classList.remove('hidden');
  document.getElementById('captain-form-name')?.focus();
}

function openEditCaptainModal(id, currentName) {
  document.getElementById('edit-captain-id').value = id;
  document.getElementById('captain-modal-title').textContent = `Edit Captain — ${currentName}`;
  document.getElementById('captain-form-name').value = currentName;
  document.getElementById('captain-form-pin').value = '';
  document.getElementById('captain-form-pin').required = false;
  document.getElementById('captain-pin-label').textContent = 'Change Login PIN (Optional)';
  document.getElementById('captain-pin-hint').textContent = 'Leave empty to keep current PIN.';
  document.getElementById('captain-modal')?.classList.remove('hidden');
  document.getElementById('captain-form-name')?.focus();
}

function closeCaptainModal() {
  document.getElementById('captain-modal')?.classList.add('hidden');
}

async function saveCaptainForm(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('edit-captain-id').value.trim();
  const displayName = document.getElementById('captain-form-name').value.trim();
  const pin = document.getElementById('captain-form-pin').value.trim();

  if (!displayName) {
    showToast('Captain name is required', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-captain');
  if (btn) btn.disabled = true;

  try {
    let url = '/api/captains';
    let method = 'POST';
    const payload = { display_name: displayName };

    if (id) {
      url = `/api/captains/${id}`;
      method = 'PUT';
      if (pin) payload.pin = pin;
    } else {
      if (!pin || pin.length < 4) {
        showToast('PIN must be at least 4 digits', 'error');
        if (btn) btn.disabled = false;
        return;
      }
      payload.pin = pin;
    }

    const res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message || 'Captain saved successfully!', 'success');
      closeCaptainModal();
      await loadCaptainsList();
    } else {
      showToast(data.message || 'Failed to save captain', 'error');
    }
  } catch (err) {
    console.error('saveCaptainForm error:', err);
    showToast('Network error saving captain', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteCaptain(id, name) {
  if (!confirm(`Are you sure you want to remove captain '${name}'?`)) return;

  try {
    const res = await fetch(`/api/captains/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `Captain '${name}' removed.`, 'success');
      await loadCaptainsList();
    } else {
      showToast(data.message || 'Failed to delete captain', 'error');
    }
  } catch (err) {
    console.error('deleteCaptain error:', err);
    showToast('Network error deleting captain', 'error');
  }
}

// Window exports
window.loadCloudTab = loadCloudTab;
window.toggleCloudProviderFields = toggleCloudProviderFields;
window.triggerManualCloudPush = triggerManualCloudPush;
window.confirmCloudPullPrompt = confirmCloudPullPrompt;
window.saveCloudConfigForm = saveCloudConfigForm;
window.loadCloudBackupsList = loadCloudBackupsList;

window.loadCaptainsList = loadCaptainsList;
window.openAddCaptainModal = openAddCaptainModal;
window.openEditCaptainModal = openEditCaptainModal;
window.closeCaptainModal = closeCaptainModal;
window.saveCaptainForm = saveCaptainForm;
window.deleteCaptain = deleteCaptain;

window.addEventListener('DOMContentLoaded', initSettings);
