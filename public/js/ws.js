/**
 * Real-time Zero-Latency Event Engine (SSE + BroadcastChannel Mesh + Fast Sync)
 * Instantly synchronizes Kitchen, Service, POS, and TV Displays without refreshing!
 */

// 1. Station Isolation & Role Hierarchy Enforcement (per-window sessionStorage)
(function initStationAuth() {
  const urlParams = new URLSearchParams(window.location.search);
  const pin = urlParams.get('pin');
  const roleParam = urlParams.get('role');
  const path = window.location.pathname;

  if (pin) {
    sessionStorage.setItem('station_pin', pin);
    if (roleParam) {
      sessionStorage.setItem('station_role', roleParam);
    } else if (pin === '1234') {
      sessionStorage.setItem('station_role', 'manager');
    } else if (pin === '2222') {
      sessionStorage.setItem('station_role', 'kitchen');
    } else if (pin === '3333') {
      sessionStorage.setItem('station_role', 'service');
    }
  } else {
    // When navigating to a specific station page, synchronize the station role
    if (path.includes('/kitchen')) {
      sessionStorage.setItem('station_role', 'kitchen');
      sessionStorage.setItem('station_pin', '2222');
    } else if (path.includes('/service')) {
      sessionStorage.setItem('station_role', 'service');
      sessionStorage.setItem('station_pin', '3333');
    } else if (path.includes('/settings') || path.includes('/pos') || path === '/' || path.includes('/launch')) {
      sessionStorage.setItem('station_role', 'manager');
      sessionStorage.setItem('station_pin', '1234');
    }
  }

  // Intercept fetch to add station headers
  const originalFetch = window.fetch;
  window.fetch = function(url, options = {}) {
    options.headers = options.headers || {};
    const role = sessionStorage.getItem('station_role') || 'manager';
    const pinVal = sessionStorage.getItem('station_pin') || '1234';

    if (role && pinVal) {
      if (options.headers instanceof Headers) {
        options.headers.set('X-Station-Role', role);
        options.headers.set('X-Station-Pin', pinVal);
      } else if (typeof options.headers === 'object') {
        options.headers['X-Station-Role'] = role;
        options.headers['X-Station-Pin'] = pinVal;
      }
    }
    return originalFetch(url, options);
  };
})();

// Role Hierarchy Navigation & Dynamic Sidebar Filter
function applyRoleHierarchyNavigation() {
  const path = window.location.pathname;
  let role = sessionStorage.getItem('station_role') || 'manager';

  // Ensure role matches page context if on manager routes
  if (path.includes('/settings') || path.includes('/pos') || path === '/' || path.includes('/launch')) {
    role = 'manager';
    sessionStorage.setItem('station_role', 'manager');
    sessionStorage.setItem('station_pin', '1234');
  } else if (path.includes('/kitchen')) {
    role = 'kitchen';
  } else if (path.includes('/service')) {
    role = 'service';
  }

  // 1. Dynamic Sidebar Role Profile
  const userCard = document.querySelector('.restro-user-card');
  if (userCard) {
    const avatar = userCard.querySelector('.restro-avatar');
    const title = userCard.querySelector('.restro-user-title') || userCard.querySelector('div > div:first-child');
    const subtitle = userCard.querySelector('.restro-user-subtitle') || userCard.querySelector('div > div:nth-child(2)');

    if (role === 'kitchen') {
      if (avatar) { avatar.textContent = 'K'; avatar.style.background = '#fef3c7'; avatar.style.color = '#b45309'; }
      if (title) title.textContent = 'Head Chef Desk';
      if (subtitle) { subtitle.textContent = '● Kitchen Terminal'; subtitle.style.color = '#d97706'; }
    } else if (role === 'service') {
      if (avatar) { avatar.textContent = 'S'; avatar.style.background = '#dcfce7'; avatar.style.color = '#15803d'; }
      if (title) title.textContent = 'Service Expediter';
      if (subtitle) { subtitle.textContent = '● Floor Waitstaff'; subtitle.style.color = '#16a34a'; }
    } else {
      if (avatar) { avatar.textContent = 'M'; avatar.style.background = '#ffedd5'; avatar.style.color = '#ea580c'; }
      if (title) title.textContent = 'Manager Desk';
      if (subtitle) { subtitle.textContent = '● Active Terminal'; subtitle.style.color = '#16a34a'; }
    }
  }

  // 2. Dynamic Sidebar Navigation Links Visibility
  document.querySelectorAll('[data-roles]').forEach(el => {
    const allowed = el.dataset.roles.split(',').map(r => r.trim().toLowerCase());
    if (!allowed.includes(role)) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });

  // 3. Update Top Bar Role Badge if present
  const roleBadge = document.querySelector('.user-role-badge');
  if (roleBadge) {
    if (role === 'kitchen') {
      roleBadge.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3Z"/></svg> Kitchen Chef`;
    } else if (role === 'service') {
      roleBadge.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg> Service Staff`;
    } else {
      roleBadge.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Manager`;
    }
  }
}

function initResponsiveMobileNav() {
  const sidebar = document.querySelector('.restro-sidebar');
  const topBar = document.querySelector('.restro-top-bar');
  if (!sidebar || !topBar) return;

  // Create backdrop once
  let backdrop = document.querySelector('.mobile-nav-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'mobile-nav-backdrop';
    backdrop.addEventListener('click', () => document.body.classList.remove('mobile-nav-open'));
    document.body.appendChild(backdrop);
  }

  // Inject hamburger button at left of top bar if not already present
  if (!topBar.querySelector('.mobile-menu-btn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-menu-btn';
    btn.title = 'Open Navigation Menu';
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
    btn.addEventListener('click', () => document.body.classList.toggle('mobile-nav-open'));

    const firstChild = topBar.firstElementChild;
    if (firstChild) {
      firstChild.style.display = 'flex';
      firstChild.style.alignItems = 'center';
      firstChild.insertBefore(btn, firstChild.firstChild);
    } else {
      topBar.appendChild(btn);
    }
  }

  // Close drawer when clicking any nav link on mobile
  sidebar.querySelectorAll('a.restro-nav-link').forEach(link => {
    link.addEventListener('click', () => document.body.classList.remove('mobile-nav-open'));
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyRoleHierarchyNavigation();
      initResponsiveMobileNav();
    });
  } else {
    applyRoleHierarchyNavigation();
    initResponsiveMobileNav();
  }
}
window.applyRoleHierarchyNavigation = applyRoleHierarchyNavigation;

class KotSyncEngine {
  constructor() {
    this.handlers = new Map();
    this.version = 0;
    this.eventSource = null;
    this.fallbackTimer = null;
    
    // BroadcastChannel for instant cross-tab sync across monitors on this machine
    this.meshChannel = (typeof window.BroadcastChannel !== 'undefined') ? new BroadcastChannel('kot_mesh_sync') : null;
    if (this.meshChannel) {
      this.meshChannel.onmessage = (evt) => {
        const msg = evt.data;
        if (msg && msg.type) {
          this.emit(msg.type, msg.data, false);
          this.emit('*', msg, false);
        }
      };
    }

    this.connectSSE();
    this.startFallbackPoll();
  }

  connectSSE() {
    try {
      if (this.eventSource) {
        this.eventSource.close();
      }

      this.eventSource = new EventSource('/api/stream');

      this.eventSource.onopen = () => {
        this.updateConnectionPill(true);
      };

      this.eventSource.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.version) this.version = msg.version;
          if (msg.type) {
            this.emit(msg.type, msg.data, true);
            this.emit('*', msg, true);
          }
        } catch (err) {
          console.error('Error parsing SSE event:', err);
        }
      };

      this.eventSource.onerror = () => {
        this.updateConnectionPill(false);
      };
    } catch (e) {
      console.warn('SSE unsupported, using fast poll:', e);
      this.updateConnectionPill(false);
    }
  }

  startFallbackPoll() {
    // Fast version checker ensures consistency
    this.fallbackTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/sync?v=${this.version}`);
        const data = await res.json();
        if (data.changed && data.version > this.version) {
          this.version = data.version;
          this.emit('DATA_CHANGED', { version: this.version }, true);
          this.emit('*', { version: this.version }, true);
        }
      } catch (e) {}
    }, 1000);
  }

  on(event, callback) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(callback);
  }

  emit(event, data, broadcastToMesh = true) {
    if (this.handlers.has(event)) {
      for (const cb of this.handlers.get(event)) {
        try { cb(data); } catch (e) { console.error(e); }
      }
    }
    if (this.handlers.has('*') && event !== '*') {
      for (const cb of this.handlers.get('*')) {
        try { cb({ event, data }); } catch (e) { console.error(e); }
      }
    }

    // Broadcast across windows if triggered locally
    if (broadcastToMesh && this.meshChannel) {
      try {
        this.meshChannel.postMessage({ type: event, data: data, timestamp: Date.now() });
      } catch (e) {}
    }
  }

  // Explicit broadcast trigger when an action finishes
  notifyAction(actionType, payload) {
    this.emit(actionType, payload, true);
  }

  updateConnectionPill(online) {
    const pills = document.querySelectorAll('.ws-status-pill');
    pills.forEach(pill => {
      if (online) {
        pill.innerHTML = '<span class="dot-pulse"></span> Instant Sync (0ms)';
        pill.style.background = '#ecfdf5';
        pill.style.borderColor = '#a7f3d0';
        pill.style.color = '#059669';
      } else {
        pill.innerHTML = '<span class="dot-pulse" style="background:#f59e0b"></span> Fast Mesh (Syncing)';
        pill.style.background = '#fef3c7';
        pill.style.borderColor = '#fde68a';
        pill.style.color = '#b45309';
      }
    });
  }
}

window.kotSocket = new KotSyncEngine();

window.showToast = function(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let iconHtml = '';
  if (type === 'success') {
    iconHtml = `<span style="color:#16a34a; font-size:1.1rem; line-height:1;">✔</span>`;
  } else if (type === 'error') {
    iconHtml = `<span style="color:#dc2626; font-size:1.1rem; line-height:1;">✕</span>`;
  } else if (type === 'warning') {
    iconHtml = `<span style="color:#d97706; font-size:1.1rem; line-height:1;">⚠</span>`;
  } else {
    iconHtml = `<span style="color:#2563eb; font-size:1.1rem; line-height:1;">ℹ</span>`;
  }

  toast.innerHTML = `
    ${iconHtml}
    <div style="flex:1; line-height:1.35;">${message}</div>
    <button style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:1rem; padding:0 4px;" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
};

window.logoutUser = async function() {
  sessionStorage.removeItem('station_role');
  sessionStorage.removeItem('station_pin');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  window.location.href = '/login';
};
