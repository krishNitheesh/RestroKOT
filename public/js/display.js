/**
 * Burger King / McDonald's Style Order Status Display
 * Instant real-time updates without refreshing!
 */

let preparingTokens = [];
let readyTokens = [];
let prevReadyTokenIds = new Set();
let settings = {};

// DOM Elements
const prepTokensGrid = document.getElementById('tv-tokens-prep');
const readyTokensGrid = document.getElementById('tv-tokens-ready');
const countPrepEl = document.getElementById('tv-count-prep');
const countReadyEl = document.getElementById('tv-count-ready');
const clockTimeEl = document.getElementById('tv-clock-time');
const clockDateEl = document.getElementById('tv-clock-date');
const hotelTitleEl = document.getElementById('tv-hotel-title');

async function initDisplay() {
  await loadSettings();
  await refreshTokens(true);

  updateClock();
  setInterval(updateClock, 1000);

  // Fast background heartbeat (every 2.5s)
  setInterval(() => refreshTokens(false), 2500);

  // Instant real-time triggers from SSE stream & local mesh
  kotSocket.on('TICKET_READY', () => refreshTokens(false));
  kotSocket.on('TICKET_APPROVED', () => refreshTokens(false));
  kotSocket.on('TICKET_SERVED', () => refreshTokens(false));
  kotSocket.on('ORDER_CREATED', () => refreshTokens(false));
  kotSocket.on('BILL_SETTLED', () => refreshTokens(false));
  kotSocket.on('SETTINGS_UPDATED', (newSettings) => {
    settings = newSettings;
    if (settings.restaurant_name) hotelTitleEl.textContent = settings.restaurant_name;
  });
  kotSocket.on('*', () => refreshTokens(false));
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      settings = data.settings;
      if (settings.restaurant_name) {
        hotelTitleEl.textContent = settings.restaurant_name;
      }
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function refreshTokens(isInitial = false) {
  try {
    const res = await fetch('/api/display/tokens');
    const data = await res.json();
    if (data.success) {
      preparingTokens = data.preparing || [];
      const newReadyTokens = data.ready || [];

      // Check for new ready tokens to chime & speak
      if (!isInitial) {
        for (const token of newReadyTokens) {
          if (!prevReadyTokenIds.has(token.id)) {
            handleOrderReadyAlert(token);
            break;
          }
        }
      }

      prevReadyTokenIds = new Set(newReadyTokens.map(t => t.id));
      readyTokens = newReadyTokens;

      renderPreparingColumn();
      renderReadyColumn();
    }
  } catch (e) {
    console.error('Failed to refresh TV display tokens:', e);
  }
}

function handleOrderReadyAlert(order) {
  KotAudio.playOrderReadyChime();
  const channelText = order.table_name ? `Table ${order.table_name}` : (order.channel === 'takeaway' ? 'Takeaway' : order.channel);
  KotAudio.speakOrderReady(order.token_number, channelText);
}

function renderPreparingColumn() {
  countPrepEl.textContent = `${preparingTokens.length} In Kitchen`;

  if (preparingTokens.length === 0) {
    prepTokensGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4rem 1rem;">
        <div style="font-size: 3rem; margin-bottom: 0.5rem; opacity: 0.3;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <p style="font-size: 1.1rem; font-weight: 600; color: var(--text-secondary);">Kitchen is clear</p>
      </div>
    `;
    return;
  }

  prepTokensGrid.innerHTML = '';
  for (const t of preparingTokens) {
    const card = document.createElement('div');
    card.className = 'token-card-prep';

    let tag = '';
    if (t.channel === 'dine_in') {
      const roundTag = t.current_round > 1 ? ` (R${t.current_round})` : '';
      tag = `<span style="font-size: 0.95rem; font-weight: 800; color: #1d4ed8; margin-top: 6px;">TABLE ${t.table_name || 'Dine-In'}${roundTag}</span>`;
    } else if (t.channel === 'takeaway') {
      tag = `<span style="font-size: 0.85rem; font-weight: 700; color: #7c3aed; margin-top: 6px;">TAKEAWAY</span>`;
    } else if (t.channel === 'swiggy') {
      tag = `<span style="font-size: 0.85rem; font-weight: 700; color: #ea580c; margin-top: 6px;">SWIGGY</span>`;
    } else if (t.channel === 'zomato') {
      tag = `<span style="font-size: 0.85rem; font-weight: 700; color: #e11d48; margin-top: 6px;">ZOMATO</span>`;
    }

    card.innerHTML = `
      <div class="token-number-prep">#${t.token_number}</div>
      ${tag}
    `;

    prepTokensGrid.appendChild(card);
  }
}

function renderReadyColumn() {
  countReadyEl.textContent = `${readyTokens.length} Ready`;

  if (readyTokens.length === 0) {
    readyTokensGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 4rem 1rem;">
        <div style="font-size: 3.5rem; margin-bottom: 0.5rem; opacity: 0.3;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        </div>
        <p style="font-size: 1.25rem; font-weight: 600; color: #16a34a;">Waiting for chef's ready signal</p>
        <p style="font-size: 0.9rem; color: #64748b; margin-top: 0.35rem;">Tokens will flash GREEN here when food is plated and ready for pickup</p>
      </div>
    `;
    return;
  }

  readyTokensGrid.innerHTML = '';
  for (const t of readyTokens) {
    const card = document.createElement('div');
    card.className = 'token-card-ready';

    let tag = '';
    if (t.channel === 'dine_in') {
      tag = `<div style="font-size: 1.3rem; font-weight: 800; color: #ffffff; margin-top: 8px;">TABLE ${t.table_name}</div>`;
    } else if (t.channel === 'takeaway') {
      tag = `<div style="font-size: 1.2rem; font-weight: 800; color: #f5f3ff; margin-top: 8px;">TAKEAWAY</div>`;
    } else if (t.channel === 'swiggy') {
      tag = `<div style="font-size: 1.2rem; font-weight: 800; color: #fff7ed; margin-top: 8px;">SWIGGY ${t.online_order_id || ''}</div>`;
    } else if (t.channel === 'zomato') {
      tag = `<div style="font-size: 1.2rem; font-weight: 800; color: #fff1f2; margin-top: 8px;">ZOMATO ${t.online_order_id || ''}</div>`;
    }

    card.innerHTML = `
      <div class="token-number-ready">#${t.token_number}</div>
      ${tag}
      <div style="background: rgba(255, 255, 255, 0.25); color: #ffffff; font-size: 0.75rem; font-weight: 800; padding: 3px 12px; border-radius: 9999px; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.05em;">
        NOW SERVING
      </div>
    `;

    readyTokensGrid.appendChild(card);
  }
}

function updateClock() {
  const now = new Date();
  clockTimeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  clockDateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

window.addEventListener('DOMContentLoaded', initDisplay);
