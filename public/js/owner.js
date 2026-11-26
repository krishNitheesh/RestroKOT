/**
 * RestroKOT — Owner Executive Portal & Daily Sales Dashboard
 */

let selectedDate = new Date().toISOString().split('T')[0];
let currentBills = [];
let autoRefreshTimer = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('owner-date-input');
  if (dateInput) {
    dateInput.value = selectedDate;
  }
  loadOwnerDashboard();
  loadRestaurantProfile();

  // Auto-refresh every 30 seconds for live updates
  autoRefreshTimer = setInterval(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    if (selectedDate === todayStr) {
      loadOwnerDashboard(true);
    }
  }, 30000);
});

async function loadRestaurantProfile() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings && data.settings.restaurant_name) {
      const el = document.getElementById('restro-name-header');
      if (el) el.textContent = data.settings.restaurant_name;
    }
  } catch (e) {
    console.error('Failed to load profile:', e);
  }
}

function setOwnerDatePreset(preset) {
  const now = new Date();
  if (preset === 'today') {
    selectedDate = now.toISOString().split('T')[0];
  } else if (preset === 'yesterday') {
    now.setDate(now.getDate() - 1);
    selectedDate = now.toISOString().split('T')[0];
  }

  const dateInput = document.getElementById('owner-date-input');
  if (dateInput) dateInput.value = selectedDate;

  // Toggle pill styles
  document.querySelectorAll('.date-pill-btn').forEach(b => b.classList.remove('active'));
  if (preset === 'today') {
    document.getElementById('btn-date-today')?.classList.add('active');
  } else if (preset === 'yesterday') {
    document.getElementById('btn-date-yesterday')?.classList.add('active');
  }

  loadOwnerDashboard();
}

function onOwnerDateChanged() {
  const dateInput = document.getElementById('owner-date-input');
  if (dateInput && dateInput.value) {
    selectedDate = dateInput.value;
    document.querySelectorAll('.date-pill-btn').forEach(b => b.classList.remove('active'));
    loadOwnerDashboard();
  }
}

async function loadOwnerDashboard(isSilent = false) {
  try {
    // 1. Fetch Daily Settlement & Summary stats
    const settleRes = await fetch(`/api/reports/settlement?date=${selectedDate}`);
    const settleData = await settleRes.json();
    
    // 2. Fetch Bills
    const billsRes = await fetch(`/api/reports/daily-bills?date=${selectedDate}`);
    const billsData = await billsRes.json();

    const summary = settleData.live_summary || settleData.summary || {};
    if (settleData.success && (settleData.live_summary || settleData.summary)) {
      renderKPICards(summary, settleData.settlement);
      renderBreakdowns(summary);
      if (document.getElementById('owner-view-settlement')?.classList.contains('hidden') === false) {
        renderSettlementTab(summary, settleData.settlement);
      }
    }

    if (billsData.success && Array.isArray(billsData.bills)) {
      currentBills = billsData.bills;
      renderBillsTable();
    }

  } catch (err) {
    console.error('loadOwnerDashboard error:', err);
    if (!isSilent) showToast('Error loading owner sales data', 'error');
  }
}

function renderKPICards(summary, settlement) {
  const netSales = Number(summary.net_sales || 0);
  const grossSales = Number(summary.gross_sales || 0);
  const taxAmount = Number(summary.tax_amount || 0);
  const paidOrders = Number(summary.paid_orders || 0);
  const unpaidOrders = Number(summary.unpaid_orders || 0);

  // Net Sales
  const elNet = document.getElementById('kpi-net-sales');
  if (elNet) elNet.textContent = `₹${netSales.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

  const elGross = document.getElementById('kpi-gross-sales');
  if (elGross) elGross.textContent = `₹${grossSales.toLocaleString('en-IN', {minimumFractionDigits: 0})}`;

  const elTax = document.getElementById('kpi-tax-amount');
  if (elTax) elTax.textContent = `₹${taxAmount.toLocaleString('en-IN', {minimumFractionDigits: 0})}`;

  // Paid Bills & AOV
  const elPaid = document.getElementById('kpi-paid-bills');
  if (elPaid) elPaid.textContent = `${paidOrders} Bills`;

  const elAov = document.getElementById('kpi-aov');
  const aov = paidOrders > 0 ? (netSales / paidOrders) : 0;
  if (elAov) elAov.textContent = `₹${aov.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

  // Cash in Drawer & Reconciliation
  const cashSales = Number(summary.cash_sales || 0);
  const elCashTotal = document.getElementById('kpi-cash-total');
  if (elCashTotal) elCashTotal.textContent = `₹${cashSales.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

  const elCashSub = document.getElementById('kpi-cash-sub');
  if (elCashSub) {
    if (settlement && settlement.status === 'settled') {
      const variance = Number(settlement.cash_variance || 0);
      const varColor = variance === 0 ? '#16a34a' : (variance > 0 ? '#2563eb' : '#ef4444');
      const varPrefix = variance > 0 ? '+₹' : (variance < 0 ? '-₹' : '₹');
      elCashSub.innerHTML = `Settled: Actual ₹${(settlement.actual_cash || 0).toLocaleString()} • Var: <strong style="color: ${varColor};">${varPrefix}${Math.abs(variance).toLocaleString()}</strong>`;
    } else {
      elCashSub.textContent = `System Cash Sales: ₹${cashSales.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }
  }

  // Running Active Tables & Unpaid orders
  let runningAmount = 0;
  if (Array.isArray(currentBills)) {
    runningAmount = currentBills
      .filter(b => b.payment_status === 'unpaid' && b.status !== 'cancelled')
      .reduce((acc, b) => acc + Number(b.grand_total || 0), 0);
  }

  const elRunningCount = document.getElementById('kpi-running-tables');
  if (elRunningCount) elRunningCount.textContent = `${unpaidOrders} Active`;

  const elRunningAmt = document.getElementById('kpi-running-amount');
  if (elRunningAmt) elRunningAmt.textContent = `₹${runningAmount.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
}

function renderBreakdowns(summary) {
  const netSales = Number(summary.net_sales || 0);
  const cash = Number(summary.cash_sales || 0);
  const upi = Number(summary.upi_sales || 0);
  const card = Number(summary.card_sales || 0);

  // Payment Mode percentages
  const totalPay = cash + upi + card;
  const cashPct = totalPay > 0 ? ((cash / totalPay) * 100).toFixed(1) : 0;
  const upiPct = totalPay > 0 ? ((upi / totalPay) * 100).toFixed(1) : 0;
  const cardPct = totalPay > 0 ? ((card / totalPay) * 100).toFixed(1) : 0;

  const txtCash = document.getElementById('txt-cash-sales');
  if (txtCash) txtCash.textContent = `₹${cash.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${cashPct}%)`;
  const barCash = document.getElementById('bar-cash');
  if (barCash) barCash.style.width = `${cashPct}%`;

  const txtUpi = document.getElementById('txt-upi-sales');
  if (txtUpi) txtUpi.textContent = `₹${upi.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${upiPct}%)`;
  const barUpi = document.getElementById('bar-upi');
  if (barUpi) barUpi.style.width = `${upiPct}%`;

  const txtCard = document.getElementById('txt-card-sales');
  if (txtCard) txtCard.textContent = `₹${card.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${cardPct}%)`;
  const barCard = document.getElementById('bar-card');
  if (barCard) barCard.style.width = `${cardPct}%`;

  // Channels
  const dinein = Number(summary.dine_in_sales || 0);
  const takeaway = Number(summary.takeaway_sales || 0);
  const delivery = Number(summary.delivery_sales || 0);
  const totalChan = dinein + takeaway + delivery;

  const dineinPct = totalChan > 0 ? ((dinein / totalChan) * 100).toFixed(1) : 0;
  const takePct = totalChan > 0 ? ((takeaway / totalChan) * 100).toFixed(1) : 0;
  const delPct = totalChan > 0 ? ((delivery / totalChan) * 100).toFixed(1) : 0;

  const txtDine = document.getElementById('txt-dinein-sales');
  if (txtDine) txtDine.textContent = `₹${dinein.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${dineinPct}%)`;
  const barDine = document.getElementById('bar-dinein');
  if (barDine) barDine.style.width = `${dineinPct}%`;

  const txtTake = document.getElementById('txt-takeaway-sales');
  if (txtTake) txtTake.textContent = `₹${takeaway.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${takePct}%)`;
  const barTake = document.getElementById('bar-takeaway');
  if (barTake) barTake.style.width = `${takePct}%`;

  const txtDel = document.getElementById('txt-delivery-sales');
  if (txtDel) txtDel.textContent = `₹${delivery.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${delPct}%)`;
  const barDel = document.getElementById('bar-delivery');
  if (barDel) barDel.style.width = `${delPct}%`;
}

function filterOwnerBillsTable() {
  renderBillsTable();
}

function renderBillsTable() {
  const tbody = document.getElementById('owner-bills-table-body');
  if (!tbody) return;

  const search = (document.getElementById('owner-bill-search')?.value || '').trim().toLowerCase();
  const channelFilter = document.getElementById('owner-channel-filter')?.value || 'all';
  const statusFilter = document.getElementById('owner-status-filter')?.value || 'all';

  const filtered = currentBills.filter(b => {
    // Channel match
    if (channelFilter !== 'all' && b.channel !== channelFilter) return false;

    // Status match
    if (statusFilter === 'paid' && b.payment_status !== 'paid') return false;
    if (statusFilter === 'unpaid' && (b.payment_status === 'paid' || b.status === 'cancelled')) return false;
    if (statusFilter === 'cancelled' && b.status !== 'cancelled') return false;

    // Search query
    if (search) {
      const orderNum = (b.order_number || '').toLowerCase();
      const token = String(b.token_number || '');
      const table = (b.table_name || '').toLowerCase();
      const cust = (b.customer_name || '').toLowerCase();
      if (!orderNum.includes(search) && !token.includes(search) && !table.includes(search) && !cust.includes(search)) {
        return false;
      }
    }
    return true;
  });

  const countEl = document.getElementById('owner-bills-count');
  if (countEl) countEl.textContent = `${filtered.length} of ${currentBills.length} bills`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2.5rem; color: #94a3b8;">
          <div style="font-size: 1.5rem; margin-bottom: 0.35rem;">🔍</div>
          <div style="font-weight: 700; color: #64748b;">No bills found for the selected filters</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(b => {
    const isPaid = b.payment_status === 'paid';
    const isCancelled = b.status === 'cancelled';
    
    let statusPill = '';
    if (isCancelled) {
      statusPill = '<span style="background: #fee2e2; color: #b91c1c; font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; font-weight: 800;">CANCELLED</span>';
    } else if (isPaid) {
      statusPill = `<span style="background: #dcfce7; color: #15803d; font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; font-weight: 800; text-transform: uppercase;">PAID • ${b.payment_method || 'CASH'}</span>`;
    } else {
      statusPill = '<span style="background: #fef3c7; color: #b45309; font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; font-weight: 800;">UNPAID / RUNNING</span>';
    }

    const itemsSummary = Array.isArray(b.items)
      ? b.items.map(i => `${i.quantity}x ${i.item_name}`).join(', ')
      : 'Items on bill';

    const orderTime = b.created_at ? b.created_at.split(' ')[1]?.substring(0, 5) : '';

    return `
      <tr>
        <td>
          <div style="font-weight: 800; color: #0f172a; font-size: 0.88rem;">${b.order_number}</div>
          <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">Token #${b.token_number}</div>
        </td>
        <td>
          <strong style="color: #475569;">${orderTime}</strong>
        </td>
        <td>
          <div style="font-weight: 700; color: #0f172a;">${b.table_name || 'Counter'}</div>
          <div style="font-size: 0.72rem; color: #64748b; text-transform: capitalize;">${(b.channel || 'dine_in').replace('_', ' ')}</div>
        </td>
        <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${itemsSummary}">
          <span style="font-size: 0.82rem; color: #334155;">${itemsSummary}</span>
        </td>
        <td>${statusPill}</td>
        <td>
          <strong style="font-size: 0.95rem; color: #0f172a;">₹${Number(b.grand_total || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
        </td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="viewOwnerBill(${b.id})"
                  style="font-size: 0.78rem; font-weight: 700; padding: 0.35rem 0.65rem; border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; cursor: pointer;">
            👁️ Invoice
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function switchOwnerTab(tabName) {
  document.querySelectorAll('.owner-tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-btn-${tabName}`)?.classList.add('active');

  const views = ['bills', 'settlement', 'handover', 'history', 'cloud'];
  views.forEach(v => {
    const el = document.getElementById(`owner-view-${v}`);
    if (el) {
      if (v === tabName) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  if (tabName === 'settlement') {
    loadOwnerSettlementData();
  } else if (tabName === 'handover') {
    loadOwnerHandoverData();
  } else if (tabName === 'history') {
    loadOwnerHistoryData();
  } else if (tabName === 'cloud') {
    loadOwnerCloudData();
  }
}

async function loadOwnerSettlementData() {
  const container = document.getElementById('owner-settlement-container');
  if (!container) return;

  container.innerHTML = `<div style="text-align: center; padding: 2rem; color: #94a3b8;">Loading settlement audit for ${selectedDate}...</div>`;

  try {
    const res = await fetch(`/api/reports/settlement?date=${selectedDate}`);
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="color: #ef4444; padding: 1rem;">Failed to load settlement.</div>`;
      return;
    }

    renderSettlementTab(data.live_summary || data.summary || {}, data.settlement);
  } catch (e) {
    console.error('loadOwnerSettlementData error:', e);
  }
}

function renderSettlementTab(summary, settlement) {
  const container = document.getElementById('owner-settlement-container');
  if (!container) return;

  const isSettled = settlement && settlement.status === 'settled';

  if (!isSettled) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2.5rem;">
        <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">☀️</div>
        <h3 style="margin: 0 0 0.5rem 0; font-weight: 800; color: #0f172a;">Day Close (EOD Settlement) Pending</h3>
        <p style="color: #64748b; font-size: 0.88rem; max-width: 480px; margin: 0 auto 1.5rem auto;">
          The cashier / manager has not finalized daily settlement for <strong>${selectedDate}</strong> yet. Live order sales are actively accruing.
        </p>
        <div style="display: inline-block; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1rem 1.5rem; text-align: left;">
          <div>Live Accrued Net Sales: <strong>₹${Number(summary.net_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></div>
          <div style="margin-top: 4px;">Live Paid Orders: <strong>${summary.paid_orders || 0}</strong></div>
          <div style="margin-top: 4px;">Live System Cash Sales: <strong>₹${Number(summary.cash_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></div>
        </div>
      </div>
    `;
    return;
  }

  const variance = Number(settlement.cash_variance || 0);
  const varColor = variance === 0 ? '#16a34a' : (variance > 0 ? '#2563eb' : '#ef4444');
  const varLabel = variance === 0 ? 'Exact Match (₹0.00)' : (variance > 0 ? `Surplus (+₹${variance.toLocaleString()})` : `Shortage (-₹${Math.abs(variance).toLocaleString()})`);

  let denomRows = '';
  try {
    const denoms = JSON.parse(settlement.denominations_json || '{}');
    denomRows = Object.entries(denoms)
      .filter(([_, count]) => Number(count) > 0)
      .map(([val, count]) => `
        <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed #e2e8f0; font-size: 0.82rem;">
          <span>₹${val} × ${count}</span>
          <strong>₹${(Number(val) * Number(count)).toLocaleString()}</strong>
        </div>
      `).join('');
  } catch (e) {}

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 1rem; flex-wrap: wrap; gap: 1rem;">
      <div>
        <div style="display: inline-flex; align-items: center; gap: 0.4rem; background: #dcfce7; color: #15803d; padding: 0.25rem 0.65rem; border-radius: 20px; font-size: 0.75rem; font-weight: 800; margin-bottom: 0.5rem;">
          ✓ EOD SETTLED & VERIFIED
        </div>
        <h3 style="margin: 0; font-size: 1.3rem; font-weight: 800; color: #0f172a;">Daily Settlement (Z-Report Audit)</h3>
        <div style="font-size: 0.82rem; color: #64748b; margin-top: 4px;">
          Settled by <strong>${settlement.settled_by}</strong> on ${settlement.settled_at}
        </div>
      </div>

      <button type="button" class="btn btn-secondary" onclick="printSettlementSlipDirectly()"
              style="padding: 0.5rem 1rem; border-radius: 8px; font-weight: 700; cursor: pointer;">
        🖨️ Print 80mm Z-Report Slip
      </button>
    </div>

    <!-- Settlement Details Grid -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem;">
      
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.25rem;">
        <div style="font-size: 0.85rem; font-weight: 800; color: #0f172a; margin-bottom: 0.75rem;">💰 Revenue Summary</div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Gross Food Sales:</span>
          <strong>₹${Number(settlement.gross_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Discounts Given:</span>
          <span style="color: #ef4444;">-₹${Number(settlement.discount_amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Taxes (CGST + SGST):</span>
          <span>₹${Number(settlement.tax_amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #cbd5e1; font-size: 1rem; font-weight: 800;">
          <span>Net Revenue:</span>
          <span style="color: #16a34a;">₹${Number(settlement.net_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.25rem;">
        <div style="font-size: 0.85rem; font-weight: 800; color: #0f172a; margin-bottom: 0.75rem;">💵 Cash Drawer Reconciliation</div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Opening Drawer Float:</span>
          <span>₹${Number(settlement.opening_float || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">System Cash Sales:</span>
          <span>+₹${Number(settlement.cash_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Petty Cash Expenses:</span>
          <span style="color: #ef4444;">-₹${Number(settlement.petty_expenses || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem;">
          <span style="color: #64748b;">Actual Physical Cash:</span>
          <strong>₹${Number(settlement.actual_cash || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #cbd5e1; font-size: 0.95rem; font-weight: 800;">
          <span>Cash Variance:</span>
          <span style="color: ${varColor};">${varLabel}</span>
        </div>
      </div>

      ${denomRows ? `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.25rem;">
          <div style="font-size: 0.85rem; font-weight: 800; color: #0f172a; margin-bottom: 0.75rem;">🧮 Physical Denominations Count</div>
          ${denomRows}
        </div>
      ` : ''}

    </div>

    ${settlement.notes ? `
      <div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 0.85rem 1rem; font-size: 0.85rem; color: #92400e;">
        <strong>Manager Notes:</strong> ${settlement.notes}
      </div>
    ` : ''}
  `;
}

async function loadOwnerHandoverData() {
  const container = document.getElementById('owner-handover-container');
  if (!container) return;

  container.innerHTML = `<div style="text-align: center; padding: 2rem; color: #94a3b8;">Loading cash handover register for ${selectedDate}...</div>`;

  try {
    const res = await fetch(`/api/reports/cash-handover?date=${selectedDate}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.handovers) || data.handovers.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2.5rem; color: #94a3b8;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🤝</div>
          <div style="font-weight: 700; color: #64748b;">No shift handovers logged for ${selectedDate}</div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="font-size: 1rem; font-weight: 800; color: #0f172a; margin-bottom: 1rem;">
        🤝 Cash Drawer Shift Handovers (${selectedDate})
      </div>
      <div style="overflow-x: auto;">
        <table class="restro-table-modern">
          <thead>
            <tr>
              <th>Time</th>
              <th>Shift Name</th>
              <th>Handed By → Received By</th>
              <th>System Expected (₹)</th>
              <th>Actual Cash (₹)</th>
              <th>Variance (₹)</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${data.handovers.map(h => {
              const variance = Number(h.variance || 0);
              const varColor = variance === 0 ? '#16a34a' : (variance > 0 ? '#2563eb' : '#ef4444');
              return `
                <tr>
                  <td><strong>${h.created_at ? h.created_at.split(' ')[1]?.substring(0, 5) : ''}</strong></td>
                  <td><span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-weight: 700;">${h.shift_name}</span></td>
                  <td><strong>${h.handed_by}</strong> → <strong>${h.received_by}</strong></td>
                  <td>₹${Number(h.expected_cash || 0).toLocaleString()}</td>
                  <td><strong>₹${Number(h.actual_cash || 0).toLocaleString()}</strong></td>
                  <td><strong style="color: ${varColor};">${variance >= 0 ? '+' : ''}₹${variance.toLocaleString()}</strong></td>
                  <td style="color: #64748b; font-size: 0.82rem;">${h.notes || '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    console.error('loadOwnerHandoverData error:', e);
  }
}

async function loadOwnerHistoryData() {
  const tbody = document.getElementById('owner-history-table-body');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem; color: #94a3b8;">Loading 30-day historical trend...</td></tr>`;

  try {
    const res = await fetch('/api/reports/daily-sales?limit=30');
    const data = await res.json();
    if (!data.success || !Array.isArray(data.days) || data.days.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem; color: #64748b;">No sales history recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.days.map(d => {
      const isSelected = d.sale_date === selectedDate;
      return `
        <tr style="${isSelected ? 'background: #eff6ff;' : ''}">
          <td>
            <strong>📅 ${d.sale_date}</strong>
            ${isSelected ? '<span style="background: #dbeafe; color: #1e40af; font-size: 0.68rem; padding: 1px 6px; border-radius: 10px; font-weight: 800; margin-left: 4px;">ACTIVE</span>' : ''}
          </td>
          <td><strong style="color: #16a34a; font-size: 0.95rem;">₹${Number(d.total_sales || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></td>
          <td><strong>${d.paid_bills || 0} bills</strong></td>
          <td>₹${Number(d.cash_sales || 0).toLocaleString()}</td>
          <td>₹${Number(d.upi_sales || 0).toLocaleString()}</td>
          <td>₹${Number(d.card_sales || 0).toLocaleString()}</td>
          <td>₹${Number(d.tax_amount || 0).toLocaleString()}</td>
          <td style="text-align: right;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="selectOwnerHistoryDate('${d.sale_date}')"
                    style="font-size: 0.78rem; font-weight: 700; padding: 0.35rem 0.65rem; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer;">
              View Day →
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('loadOwnerHistoryData error:', e);
  }
}

function selectOwnerHistoryDate(dateStr) {
  selectedDate = dateStr;
  const dateInput = document.getElementById('owner-date-input');
  if (dateInput) dateInput.value = selectedDate;
  switchOwnerTab('bills');
  loadOwnerDashboard();
}

async function loadOwnerCloudData() {
  const tbody = document.getElementById('owner-cloud-backups-body');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 1.5rem; color: #94a3b8;">Loading cloud backups...</td></tr>`;

  try {
    const statusRes = await fetch('/api/cloud/status');
    const statusData = await statusRes.json();
    if (statusData.success && statusData.config) {
      const cfg = statusData.config;
      const elPush = document.getElementById('owner-cloud-lastpush');
      if (elPush) elPush.textContent = cfg.last_push || 'Never';
      const elCount = document.getElementById('owner-cloud-count');
      if (elCount) elCount.textContent = `${statusData.vault_files_count || statusData.backup_count || 0} Backups`;
    }

    const backupsRes = await fetch('/api/cloud/backups');
    const backupsData = await backupsRes.json();
    if (!backupsData.success || !Array.isArray(backupsData.backups) || backupsData.backups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 1.5rem; color: #64748b;">No cloud backups found.</td></tr>`;
      return;
    }

    tbody.innerHTML = backupsData.backups.map(b => {
      const sizeKb = (b.file_size / 1024).toFixed(1);
      return `
        <tr>
          <td><strong>🗄️ ${b.backup_filename}</strong></td>
          <td><span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">${b.trigger_type}</span></td>
          <td>${sizeKb} KB</td>
          <td><strong>₹${Number(b.net_sales || 0).toLocaleString()}</strong></td>
          <td style="color: #64748b; font-size: 0.82rem;">${b.created_at}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.error('loadOwnerCloudData error:', e);
  }
}

async function triggerOwnerCloudPush() {
  const btn = document.getElementById('btn-owner-push');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/cloud/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_type: 'manual', notes: 'Pushed from Owner Executive Desk' })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`☁️ Cloud Snapshot taken successfully! (${data.backup.filename})`, 'success');
      loadOwnerCloudData();
    } else {
      showToast(data.message || 'Cloud push failed', 'error');
    }
  } catch (e) {
    showToast('Network error pushing cloud backup', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function viewOwnerBill(orderId) {
  const modal = document.getElementById('owner-invoice-modal');
  const content = document.getElementById('modal-invoice-content');
  if (!modal || !content) return;

  content.innerHTML = `<div style="text-align: center; padding: 2rem; color: #94a3b8;">Loading bill details...</div>`;
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`/api/orders/${orderId}`);
    const data = await res.json();
    if (!data.success || !data.order) {
      content.innerHTML = `<div style="color: #ef4444;">Failed to load order bill.</div>`;
      return;
    }

    const o = data.order;
    const itemsHtml = (o.items || []).map(i => `
      <div style="display: flex; justify-content: space-between; font-size: 0.88rem; margin-bottom: 4px;">
        <span>${i.quantity} × ${i.item_name}</span>
        <strong>₹${Number(i.total_price || (i.price * i.quantity)).toFixed(2)}</strong>
      </div>
    `).join('');

    content.innerHTML = `
      <div id="printable-bill-receipt" style="font-family: monospace; font-size: 0.88rem; max-width: 320px; margin: 0 auto; color: #000;">
        <div style="text-align: center; margin-bottom: 0.75rem;">
          <h2 style="margin: 0; font-size: 1.15rem; font-weight: 900;">GRAND PALACE HOTEL</h2>
          <div style="font-size: 0.75rem;">Commercial Road, Central District</div>
          <div style="font-size: 0.75rem;">GSTIN: 33AABCU9603R1ZM</div>
        </div>
        <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 6px 0; margin-bottom: 8px;">
          <div>Bill: <strong>${o.order_number}</strong> (Token #${o.token_number})</div>
          <div>Table: <strong>${o.table_name || 'Counter'}</strong> • ${o.channel}</div>
          <div>Date: ${o.created_at}</div>
        </div>
        <div style="margin-bottom: 8px;">
          ${itemsHtml}
        </div>
        <div style="border-top: 1px dashed #000; padding-top: 6px;">
          <div style="display: flex; justify-content: space-between;">
            <span>Subtotal:</span>
            <span>₹${Number(o.subtotal || 0).toFixed(2)}</span>
          </div>
          ${Number(o.discount_amount || 0) > 0 ? `
            <div style="display: flex; justify-content: space-between; color: red;">
              <span>Discount:</span>
              <span>-₹${Number(o.discount_amount || 0).toFixed(2)}</span>
            </div>
          ` : ''}
          <div style="display: flex; justify-content: space-between;">
            <span>CGST (2.5%):</span>
            <span>₹${Number(o.cgst_amount || 0).toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>SGST (2.5%):</span>
            <span>₹${Number(o.sgst_amount || 0).toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 1.1rem; font-weight: 900; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px;">
            <span>GRAND TOTAL:</span>
            <span>₹${Number(o.grand_total || 0).toFixed(2)}</span>
          </div>
          <div style="text-align: center; margin-top: 8px; font-weight: 800; text-transform: uppercase;">
            ${o.payment_status === 'paid' ? `PAID VIA ${o.payment_method || 'CASH'}` : 'UNPAID / RUNNING'}
          </div>
        </div>
      </div>
    `;

  } catch (e) {
    console.error('viewOwnerBill error:', e);
  }
}

function closeOwnerInvoiceModal() {
  document.getElementById('owner-invoice-modal')?.classList.add('hidden');
}

function printInvoiceModalContent() {
  const content = document.getElementById('printable-bill-receipt');
  if (!content) return;
  const printWindow = window.open('', '', 'width=400,height=600');
  printWindow.document.write(`
    <html>
      <head><title>Print Invoice</title></head>
      <body style="margin: 0; padding: 10px; font-family: monospace;">
        ${content.innerHTML}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  printWindow.close();
}

function printSettlementSlipDirectly() {
  window.print();
}

async function logoutOwner() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  window.location.href = '/login';
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: ${type === 'success' ? '#16a34a' : (type === 'error' ? '#ef4444' : '#0f172a')};
    color: #fff;
    padding: 0.75rem 1.25rem;
    border-radius: 8px;
    font-weight: 700;
    font-size: 0.88rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100000;
    transition: opacity 0.3s;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Window globals
window.setOwnerDatePreset = setOwnerDatePreset;
window.onOwnerDateChanged = onOwnerDateChanged;
window.loadOwnerDashboard = loadOwnerDashboard;
window.filterOwnerBillsTable = filterOwnerBillsTable;
window.switchOwnerTab = switchOwnerTab;
window.selectOwnerHistoryDate = selectOwnerHistoryDate;
window.triggerOwnerCloudPush = triggerOwnerCloudPush;
window.viewOwnerBill = viewOwnerBill;
window.closeOwnerInvoiceModal = closeOwnerInvoiceModal;
window.printInvoiceModalContent = printInvoiceModalContent;
window.printSettlementSlipDirectly = printSettlementSlipDirectly;
window.logoutOwner = logoutOwner;
