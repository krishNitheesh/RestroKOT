/**
 * Service Area Expediter & Dispatch System - Ticket-level multi-round support
 * Instant Zero-Refresh Notification Engine (RestroBit Theme)
 */

let activeTickets = [];
let activeFilter = 'all';
let searchQuery = '';
let soundEnabled = true;

const readyContainer = document.getElementById('ready-orders-container');
const prepContainer = document.getElementById('prep-orders-container');
const countReadyEl = document.getElementById('count-ready');
const countPrepEl = document.getElementById('count-preparing');
const audioToggleBtn = document.getElementById('btn-audio-toggle');
const audioStatusLabel = document.getElementById('audio-status-label');
const fullscreenBtn = document.getElementById('btn-fullscreen');
const searchInput = document.getElementById('service-search-input');

async function initService() {
  await loadServiceTickets();
  setupEventListeners();

  setInterval(updateTimers, 1000);
  setInterval(loadServiceTickets, 2500);

  kotSocket.on('*', () => {
    loadServiceTickets();
  });
}

async function loadServiceTickets() {
  try {
    const res = await fetch('/api/service/tickets');
    const data = await res.json();
    if (data.success) {
      const prevReadyIds = new Set(activeTickets.filter(t => t.status === 'ready').map(t => t.id));
      activeTickets = data.tickets || [];

      // Check if new ticket became ready
      const hasNewReady = activeTickets.some(t => t.status === 'ready' && !prevReadyIds.has(t.id));
      if (hasNewReady && soundEnabled) {
        KotAudio.playOrderReadyChime();
      }

      renderColumns();
    }
  } catch (e) {
    console.error('Failed to load service tickets:', e);
  }
}

function renderColumns() {
  let readyTickets = activeTickets.filter(t => t.status === 'ready');
  let prepTickets = activeTickets.filter(t => t.status === 'preparing');
  let outTickets = activeTickets.filter(t => t.status === 'served');

  const countOutEl = document.getElementById('count-out');
  if (countOutEl) countOutEl.textContent = outTickets.length;

  if (activeFilter === 'out_only') {
    readyTickets = outTickets;
    prepTickets = [];
  } else if (activeFilter !== 'all') {
    readyTickets = readyTickets.filter(t => t.channel === activeFilter);
    prepTickets = prepTickets.filter(t => t.channel === activeFilter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const filterFn = t => {
      const tbl = (t.table_name || '').toLowerCase();
      const kot = (t.kot_number || '').toLowerCase();
      const tok = String(t.token_number || '');
      const waiter = (t.waiter_name || '').toLowerCase();
      const itemsMatch = (t.items || []).some(i => i.item_name.toLowerCase().includes(q));
      return tbl.includes(q) || kot.includes(q) || tok.includes(q) || waiter.includes(q) || itemsMatch;
    };
    readyTickets = readyTickets.filter(filterFn);
    prepTickets = prepTickets.filter(filterFn);
  }

  if (countReadyEl) countReadyEl.textContent = readyTickets.length;
  if (countPrepEl) countPrepEl.textContent = prepTickets.length;

  // 1. Ready Column
  if (readyTickets.length === 0) {
    readyContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 4.5rem 1rem;">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem; opacity: 0.35;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        </div>
        <p style="font-size: 1rem; font-weight: 700; color: #334155;">No dishes waiting for pickup</p>
        <p style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem;">Dishes marked ready by kitchen chefs will appear here with chime</p>
      </div>
    `;
  } else {
    readyContainer.innerHTML = '';
    for (const ticket of readyTickets) {
      const card = document.createElement('div');
      card.className = 'restro-ready-card';

      const itemsSummary = (ticket.items || []).map(i => `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.92rem; padding: 5px 0; border-bottom: 1px dashed #f1f5f9; gap: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.45rem; flex: 1; min-width: 0;">
            <span class="food-indicator ${i.food_type || 'veg'}"></span>
            <span style="font-size: 0.8rem; font-weight: 800; background: #0f172a; color: #ffffff; padding: 1px 6px; border-radius: 4px;">${i.quantity}x</span>
            <span style="font-weight: 700; color: #0f172a; ${i.status === 'served' ? 'text-decoration: line-through; opacity: 0.55;' : ''}">${i.item_name}</span>
          </div>
          ${i.status === 'served'
            ? `<span style="font-size: 0.72rem; font-weight: 800; color: #16a34a; background: #dcfce7; padding: 2px 8px; border-radius: 6px;">OUT ✓</span>`
            : `<button type="button" onclick="serveDishItem(${i.id})" style="background: #16a34a; color: #fff; border: none; border-radius: 6px; padding: 3px 10px; font-size: 0.75rem; font-weight: 800; cursor: pointer;">OUT</button>`
          }
        </div>
      `).join('');

      let destinationBadge = '';
      if (ticket.channel === 'dine_in') {
        destinationBadge = `<div style="font-size: 1.4rem; font-weight: 900; color: #15803d; line-height: 1.2;">TABLE ${ticket.table_name || 'N/A'}</div>`;
      } else if (ticket.channel === 'takeaway') {
        destinationBadge = `<div style="font-size: 1.3rem; font-weight: 900; color: #7c3aed; line-height: 1.2;">TAKEAWAY #${ticket.token_number}</div>`;
      } else if (ticket.channel === 'swiggy') {
        destinationBadge = `<div style="font-size: 1.3rem; font-weight: 900; color: #ea580c; line-height: 1.2;">SWIGGY #${ticket.token_number}</div>`;
      } else if (ticket.channel === 'zomato') {
        destinationBadge = `<div style="font-size: 1.3rem; font-weight: 900; color: #e11d48; line-height: 1.2;">ZOMATO #${ticket.token_number}</div>`;
      }

      const roundTag = ticket.round_number > 1 ? ` (Round ${ticket.round_number} Add-on)` : '';

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.65rem;">
          <div>
            ${destinationBadge}
            <span style="font-size: 0.75rem; color: #64748b; font-weight: 600;">${ticket.kot_number}${roundTag}</span>
          </div>
          <span class="live-pill" style="background: #dcfce7; color: #15803d; border-color: #86efac; font-weight: 800; font-size: 0.78rem;">
            <span class="dot-pulse"></span> READY TO SERVE
          </span>
        </div>

        ${ticket.waiter_name ? `
          <div style="font-size: 0.82rem; color: #1d4ed8; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.35rem; font-weight: 700;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>Assigned Waiter: <strong>${ticket.waiter_name}</strong></span>
          </div>
        ` : ''}

        <div style="background: #f8fafc; border: 1px solid #edf2f7; border-radius: 10px; padding: 0.75rem 0.85rem; margin: 0.6rem 0;">
          ${itemsSummary}
        </div>

        <button class="btn btn-success btn-lg" style="width: 100%; font-weight: 800; font-size: 0.95rem; margin-top: 0.45rem; border-radius: 10px;" onclick="serveTicket(${ticket.id})" ${ticket.status === 'served' ? 'disabled style="width:100%;opacity:0.65;background:#475569;border:none;border-radius:10px;margin-top:0.45rem;"' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ${ticket.status === 'served' ? 'ALREADY OUT ✓' : 'OUT (MARK SERVED)'}
        </button>
      `;

      readyContainer.appendChild(card);
    }
  }

  // 2. Cooking Column
  if (prepTickets.length === 0) {
    prepContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 4.5rem 1rem;">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem; opacity: 0.35;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <p style="font-size: 1rem; font-weight: 700; color: #334155;">No orders currently cooking</p>
        <p style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem;">Active orders in the kitchen will show live stopwatch timers here</p>
      </div>
    `;
  } else {
    prepContainer.innerHTML = '';
    for (const ticket of prepTickets) {
      const card = document.createElement('div');
      card.className = 'restro-prep-card';

      const startTime = new Date(ticket.approved_at || ticket.created_at).getTime();
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
      const itemsSummary = (ticket.items || []).map(i => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed #e2e8f0; gap: 0.5rem;">
          <span style="${i.status === 'served' ? 'text-decoration: line-through; opacity: 0.55;' : ''}"><strong>${i.quantity}x</strong> ${i.item_name}</span>
          ${i.status === 'served'
            ? `<span style="font-size: 0.7rem; font-weight: 800; color: #16a34a; background: #dcfce7; padding: 2px 7px; border-radius: 6px;">OUT ✓</span>`
            : `<button type="button" onclick="serveDishItem(${i.id})" style="background: #16a34a; color: #fff; border: none; border-radius: 6px; padding: 2px 9px; font-size: 0.72rem; font-weight: 800; cursor: pointer;">OUT</button>`
          }
        </div>
      `).join('');
      const roundTag = ticket.round_number > 1 ? ` (R${ticket.round_number})` : '';

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2px;">
              <span class="badge-channel badge-${ticket.channel}">${ticket.channel.replace('_', ' ')}</span>
              <strong style="font-size: 1.15rem; color: #0284c7;">
                ${ticket.table_name ? 'Table ' + ticket.table_name + roundTag : 'Token #' + ticket.token_number}
              </strong>
            </div>
            <span style="font-size: 0.75rem; color: #64748b;">${ticket.kot_number} • Started: ${new Date(ticket.approved_at || ticket.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>

          <div style="font-family: var(--font-mono); font-weight: 800; font-size: 0.95rem; background: #e0f2fe; color: #0284c7; padding: 0.25rem 0.65rem; border-radius: 8px; border: 1px solid #bae6fd; display: inline-flex; align-items: center; gap: 0.35rem;" 
               data-start="${startTime}" class="service-timer">
            ⏱️ <span>${formatDuration(elapsedSec)}</span>
          </div>
        </div>

        <div style="font-size: 0.86rem; color: #334155; line-height: 1.4; margin-top: 0.45rem; background: #f8fafc; padding: 0.5rem 0.75rem; border-radius: 8px;">
          ${itemsSummary}
        </div>

        <button class="btn btn-sm" style="width: 100%; margin-top: 0.55rem; background: #16a34a; color: #fff; font-weight: 800; border: none; border-radius: 8px; padding: 0.45rem 0.75rem; cursor: pointer;" onclick="serveTicket(${ticket.id})">
          OUT (MARK SERVED) →
        </button>
      `;

      prepContainer.appendChild(card);
    }
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTimers() {
  document.querySelectorAll('.service-timer').forEach(el => {
    const startTime = parseInt(el.dataset.start, 10);
    if (!startTime) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const span = el.querySelector('span');
    if (span) span.textContent = formatDuration(elapsedSec);
  });
}

async function serveDishItem(itemId) {
  try {
    const res = await fetch(`/api/service/items/${itemId}/serve`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Dish marked OUT!', 'success');
      kotSocket.notifyAction('TICKET_SERVED', { item_id: itemId });
      loadServiceTickets();
    } else {
      showToast(data.error || 'Failed to mark dish OUT', 'error');
    }
  } catch (e) {
    showToast('Failed to mark dish OUT', 'error');
  }
}

async function serveTicket(ticketId) {
  try {
    const res = await fetch(`/api/service/tickets/${ticketId}/serve`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Dishes marked SERVED!', 'success');
      kotSocket.notifyAction('TICKET_SERVED', { ticket_id: ticketId });
      loadServiceTickets();
    } else {
      showToast(data.error || 'Failed to mark served', 'error');
    }
  } catch (e) {
    showToast('Failed to mark served', 'error');
  }
}

function setupEventListeners() {
  audioToggleBtn?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    if (audioStatusLabel) {
      audioStatusLabel.textContent = soundEnabled ? 'ON' : 'MUTED';
      audioStatusLabel.style.color = soundEnabled ? '#16a34a' : '#dc2626';
    }
    showToast(`Service audio alert ${soundEnabled ? 'enabled' : 'muted'}`, 'info');
  });

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => console.warn(err));
    } else {
      document.exitFullscreen().catch(err => console.warn(err));
    }
  });

  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderColumns();
  });

  document.querySelectorAll('#channel-filter-pills .restro-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#channel-filter-pills .restro-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderColumns();
    });
  });
}

// Global exports
window.serveTicket = serveTicket;
window.serveDishItem = serveDishItem;

window.addEventListener('DOMContentLoaded', initService);
