/**
 * Kitchen Display System (KDS) Logic - Multi-Round KOT Ticket Support
 * Ultra-Responsive Zero-Refresh SSE & Mesh Synchronization (RestroBit Theme)
 */

let kitchenTickets = [];
let activeFilter = 'all';
let searchQuery = '';
let soundEnabled = true;

const ticketsContainer = document.getElementById('kds-tickets-container');
const countPendingEl = document.getElementById('kds-count-pending');
const countPreparingEl = document.getElementById('kds-count-preparing');
const audioToggleBtn = document.getElementById('btn-audio-toggle');
const audioStatusLabel = document.getElementById('audio-status-label');
const fullscreenBtn = document.getElementById('btn-fullscreen');
const tvModeBtn = document.getElementById('btn-tv-mode');
const tvModeLabel = document.getElementById('tv-mode-label');
const searchInput = document.getElementById('kds-search-input');

async function initKitchen() {
  await loadKitchenTickets();
  setupEventListeners();
  autoDetectTvMode();

  setInterval(updateAllTimers, 1000);
  setInterval(loadKitchenTickets, 2500); // Live poll sync

  kotSocket.on('*', () => {
    loadKitchenTickets();
  });
}

/**
 * Auto-detect if this window is on an extended display (not the primary monitor)
 * or if opened with ?tv=1 query param. If so, enter TV mode automatically.
 */
function autoDetectTvMode() {
  const params = new URLSearchParams(window.location.search);
  // Force TV mode via query string: /kitchen?tv=1
  if (params.get('tv') === '1' || params.get('kiosk') === '1') {
    enableTvMode(true);
    return;
  }

  // Auto-detect: if window is positioned beyond the primary screen width,
  // it's likely on an extended display — switch to TV mode
  try {
    if (window.screenLeft > window.screen.width || window.screenX > window.screen.width) {
      enableTvMode(true);
    }
  } catch (e) {
    // screenLeft/screenX not available in some environments; skip
  }
}

function enableTvMode(on) {
  if (on) {
    document.body.classList.add('kds-tv-mode');
    if (tvModeLabel) tvModeLabel.textContent = 'Exit TV';
    sessionStorage.setItem('kds-tv-mode', '1');
  } else {
    document.body.classList.remove('kds-tv-mode');
    if (tvModeLabel) tvModeLabel.textContent = 'TV Mode';
    sessionStorage.removeItem('kds-tv-mode');
  }
}

function toggleTvMode() {
  const isOn = document.body.classList.contains('kds-tv-mode');
  enableTvMode(!isOn);
}

async function loadKitchenTickets() {
  try {
    const res = await fetch('/api/kitchen/tickets');
    const data = await res.json();
    if (data.success) {
      const prevIds = new Set(kitchenTickets.map(t => t.id));
      kitchenTickets = data.tickets || [];
      
      // Play bell if new ticket arrived
      const hasNew = kitchenTickets.some(t => !prevIds.has(t.id) && t.status === 'pending_approval');
      if (hasNew && soundEnabled) {
        KotAudio.playKitchenBell();
      }

      updateCounts();
      renderTickets();
    }
  } catch (e) {
    console.error('Error loading kitchen tickets:', e);
  }
}

function updateCounts() {
  const pending = kitchenTickets.filter(t => t.status === 'pending_approval').length;
  const preparing = kitchenTickets.filter(t => t.status === 'preparing').length;
  if (countPendingEl) countPendingEl.textContent = pending;
  if (countPreparingEl) countPreparingEl.textContent = preparing;
}

function renderTickets() {
  let filtered = kitchenTickets;
  if (activeFilter !== 'all') {
    filtered = filtered.filter(t => t.channel === activeFilter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(t => {
      const tbl = (t.table_name || '').toLowerCase();
      const kot = (t.kot_number || '').toLowerCase();
      const tok = String(t.token_number || '');
      const waiter = (t.waiter_name || '').toLowerCase();
      const itemsMatch = (t.items || []).some(i => i.item_name.toLowerCase().includes(q));
      return tbl.includes(q) || kot.includes(q) || tok.includes(q) || waiter.includes(q) || itemsMatch;
    });
  }

  if (filtered.length === 0) {
    ticketsContainer.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 5rem 1rem;">
        <div style="font-size: 3rem; margin-bottom: 0.75rem; opacity: 0.35;">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3Z"/></svg>
        </div>
        <h3 style="font-size: 1.25rem; color: var(--text-secondary); font-weight: 700;">No active kitchen tickets</h3>
        <p style="font-size: 0.88rem; color: var(--text-muted); margin-top: 0.25rem;">
          ${searchQuery ? 'Try clearing your search query.' : 'New orders punched from POS will appear here live with audio alerts.'}
        </p>
      </div>
    `;
    return;
  }

  ticketsContainer.innerHTML = '';

  for (const ticket of filtered) {
    const card = document.createElement('div');
    const items = ticket.items || [];
    const totalItems = items.length;
    const readyItems = items.filter(i => Boolean(i.is_ready)).length;
    const isAllOut = totalItems > 0 && readyItems === totalItems;
    const isPending = ticket.status === 'pending_approval';

    card.className = `restro-kds-ticket ${isAllOut ? 'completed ticket-all-ready' : (isPending ? 'pending' : 'preparing')}`;
    card.id = `kds-ticket-${ticket.id}`;

    const startTime = new Date(ticket.approved_at || ticket.created_at).getTime();
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const timerClass = getTimerClass(elapsedSec);

    let destinationTitle = '';
    if (ticket.channel === 'dine_in') {
      destinationTitle = `<span style="font-size: 1.25rem; font-weight: 800; color: #1d4ed8;">TABLE ${ticket.table_name || 'N/A'}</span>`;
    } else if (ticket.channel === 'takeaway') {
      destinationTitle = `<span style="font-size: 1.2rem; font-weight: 800; color: #7c3aed;">TAKEAWAY #${ticket.token_number}</span>`;
    } else if (ticket.channel === 'swiggy') {
      destinationTitle = `<span style="font-size: 1.2rem; font-weight: 800; color: #ea580c;">SWIGGY #${ticket.token_number}</span>`;
    } else if (ticket.channel === 'zomato') {
      destinationTitle = `<span style="font-size: 1.2rem; font-weight: 800; color: #e11d48;">ZOMATO #${ticket.token_number}</span>`;
    }

    const roundTag = ticket.round_number > 1
      ? `<span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">ROUND ${ticket.round_number} (ADD-ON)</span>`
      : `<span style="background: #f1f5f9; color: #475569; font-size: 0.72rem; font-weight: 700; padding: 2px 7px; border-radius: 6px;">ROUND 1</span>`;

    const statusPill = isAllOut
      ? `<span class="badge-completed-pill">✓ COMPLETED</span>`
      : (readyItems > 0 ? `<span class="badge-progress-pill">${readyItems}/${totalItems} OUT</span>` : '');

    let itemsHtml = '';
    for (const item of items) {
      const isItemOut = Boolean(item.is_ready);
      itemsHtml += `
        <div class="restro-kds-item ${isItemOut ? 'item-done' : ''}" id="kds-item-${item.id}">
          <div class="restro-qty-badge">${item.quantity}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
              <span class="dish-item-name" style="font-size: 0.95rem; font-weight: 700; color: ${isItemOut ? '#94a3b8' : '#0f172a'}; ${isItemOut ? 'text-decoration: line-through;' : ''}">
                ${item.item_name}
              </span>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                <span class="food-indicator ${item.food_type || 'veg'}"></span>
                <button class="btn-dish-out ${isItemOut ? 'is-out' : ''}" 
                        type="button"
                        onclick="toggleDishOut(event, ${item.id}, ${ticket.id})" 
                        title="${isItemOut ? 'Mark back to cooking' : 'Mark dish as OUT (Cooked)'}">
                  ${isItemOut ? '✓ OUT' : 'OUT'}
                </button>
              </div>
            </div>
            ${item.notes ? `
              <div style="background: #fef3c7; color: #b45309; border: 1px solid #fde68a; border-radius: 6px; padding: 2px 6px; font-size: 0.75rem; font-weight: 600; margin-top: 4px; display: inline-flex; align-items: center; gap: 0.25rem;">
                <span>✍️ ${item.notes}</span>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }

    let actionBtnHtml = '';
    if (isAllOut) {
      actionBtnHtml = `
        <button class="btn-completed-kds" onclick="readyTicket(${ticket.id})">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>✓ COMPLETED — DISPATCH TO SERVICE →</span>
        </button>
      `;
    } else if (isPending) {
      actionBtnHtml = `
        <button class="btn-approve-kds" onclick="approveTicket(${ticket.id})">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>APPROVE & START COOKING ${readyItems > 0 ? `(${readyItems}/${totalItems} OUT)` : ''}</span>
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button class="btn-ready-kds" onclick="readyTicket(${ticket.id})">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>MARK ALL READY FOR SERVICE (${readyItems}/${totalItems} OUT)</span>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="restro-ticket-head">
        <div>
          <div style="display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.25rem; flex-wrap: wrap;">
            <span class="badge-channel badge-${ticket.channel}">${ticket.channel.replace('_', ' ')}</span>
            ${roundTag}
            ${statusPill}
          </div>
          <div>
            ${destinationTitle}
          </div>
          <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">
            ${ticket.kot_number} • ${new Date(ticket.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            ${ticket.waiter_name ? ` • Waiter: ${ticket.waiter_name}` : ''}
          </div>
        </div>
        <div class="restro-timer-pill ${isAllOut ? 'timer-green' : timerClass}" id="timer-${ticket.id}" data-start="${startTime}">
          ${isAllOut ? `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>DONE</span>
          ` : `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>${formatDuration(elapsedSec)}</span>
          `}
        </div>
      </div>

      <div class="restro-ticket-body">
        ${itemsHtml}
        ${isAllOut ? `
          <div class="restro-all-out-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>ALL DISHES OUT • ORDER COMPLETED</span>
          </div>
        ` : ''}
        ${ticket.notes ? `<div style="background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 0.4rem 0.6rem; border-radius: 8px; font-size: 0.78rem; font-weight: 700; margin-top: 0.65rem;">Special Instruction: ${ticket.notes}</div>` : ''}
      </div>

      <div class="restro-ticket-actions">
        ${actionBtnHtml}
      </div>
    `;

    ticketsContainer.appendChild(card);
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getTimerClass(sec) {
  if (sec >= 1200) return 'timer-red';
  if (sec >= 600) return 'timer-amber';
  return 'timer-green';
}

function updateAllTimers() {
  document.querySelectorAll('[id^="timer-"]').forEach(el => {
    const startTime = parseInt(el.dataset.start, 10);
    if (!startTime) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const span = el.querySelector('span');
    if (span) span.textContent = formatDuration(elapsedSec);
    el.className = `restro-timer-pill ${getTimerClass(elapsedSec)}`;
  });
}

async function approveTicket(ticketId) {
  try {
    const res = await fetch(`/api/kitchen/tickets/${ticketId}/approve`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('KOT Approved! Cooking timer started.', 'success');
      kotSocket.notifyAction('TICKET_APPROVED', { ticket_id: ticketId });
      loadKitchenTickets();
    } else {
      showToast(data.error || 'Failed to approve ticket', 'error');
    }
  } catch (e) {
    showToast('Failed to approve ticket', 'error');
  }
}

async function readyTicket(ticketId) {
  try {
    const res = await fetch(`/api/kitchen/tickets/${ticketId}/ready`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('KOT marked READY! Notified Service Area & TVs', 'success');
      KotAudio.playOrderReadyChime();
      kotSocket.notifyAction('TICKET_READY', { ticket_id: ticketId });
      loadKitchenTickets();
    } else {
      showToast(data.error || 'Failed to mark ready', 'error');
    }
  } catch (e) {
    showToast('Failed to mark ready', 'error');
  }
}

async function toggleDishOut(event, itemId, ticketId) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }

  const ticket = kitchenTickets.find(t => t.id === ticketId);
  const item = ticket?.items?.find(i => i.id === itemId);
  if (!item) return;

  const wasReady = Boolean(item.is_ready);
  const newReady = !wasReady;
  item.is_ready = newReady ? 1 : 0;

  // Optimistic check: are all items in this ticket now OUT?
  const totalItems = (ticket.items || []).length;
  const readyCount = (ticket.items || []).filter(i => Boolean(i.is_ready)).length;
  const allOut = totalItems > 0 && readyCount === totalItems;

  if (allOut && soundEnabled) {
    KotAudio.playOrderReadyChime();
    showToast(`🎉 Table ${ticket.table_name || ticket.token_number}: All dishes OUT! Order completed!`, 'success');
  }

  // Re-render UI immediately for instant responsive feedback
  renderTickets();

  try {
    const res = await fetch(`/api/kitchen/items/${itemId}/toggle-out`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Failed to update dish status', 'error');
      loadKitchenTickets();
    } else {
      kotSocket.notifyAction('ITEM_OUT_TOGGLED', { item_id: itemId, ticket_id: ticketId });
    }
  } catch (e) {
    console.error('Failed to toggle dish out:', e);
    loadKitchenTickets();
  }
}

function toggleItemDone(event, itemId) {
  // Legacy fallback if entire row clicked
  const btn = event.currentTarget.querySelector('.btn-dish-out');
  if (btn) btn.click();
}

function setupEventListeners() {
  audioToggleBtn?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    if (audioStatusLabel) {
      audioStatusLabel.textContent = soundEnabled ? 'ON' : 'MUTED';
      audioStatusLabel.style.color = soundEnabled ? '#16a34a' : '#dc2626';
    }
    showToast(`Kitchen audio alert ${soundEnabled ? 'enabled' : 'muted'}`, 'info');
  });

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => console.warn(err));
    } else {
      document.exitFullscreen().catch(err => console.warn(err));
    }
  });

  tvModeBtn?.addEventListener('click', () => {
    toggleTvMode();
  });

  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderTickets();
  });

  document.querySelectorAll('#channel-filter-pills .restro-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#channel-filter-pills .restro-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderTickets();
    });
  });
}

// Global exports
window.approveTicket = approveTicket;
window.readyTicket = readyTicket;
window.toggleItemDone = toggleItemDone;
window.toggleDishOut = toggleDishOut;
window.toggleTvMode = toggleTvMode;

window.addEventListener('DOMContentLoaded', () => {
  // Restore TV mode from session
  if (sessionStorage.getItem('kds-tv-mode') === '1') {
    enableTvMode(true);
  }
  initKitchen();
});
