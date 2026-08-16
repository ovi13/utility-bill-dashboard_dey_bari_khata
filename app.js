/* =========================================================================
   Dey Bari Utility Khata — client-side utility bill manager
   All data lives in localStorage on this device/browser. No server needed.
   ========================================================================= */

const STORAGE_KEY = 'deybari_utility_v1';

// ---- Household members, seeded from the original "Dey Bari" ledger ----
// gasFixed = fixed monthly gas charge (unchanged from the source spreadsheet)
// hasElectric = whether this member has their own electricity meter/bill
// hasMotor = whether this member shares the household motor (water) bill
const DEFAULT_USERS = [
  { id:'mridul',  name:'Mridul Kanti Dey',           consumerId:'41793600', meter:'250145',  gasFixed:2160, hasElectric:true,  hasMotor:true  },
  { id:'angshu',  name:'Angshu Debray',              consumerId:'41569323', meter:'094221',  gasFixed:0,    hasElectric:true,  hasMotor:false },
  { id:'mamoni',  name:'Rita Dey (Mamoni)',          consumerId:'41569338', meter:'094222',  gasFixed:1080, hasElectric:true,  hasMotor:true  },
  { id:'boumoni', name:'Rita Dey (Boumoni)',         consumerId:'41019683', meter:'27023',   gasFixed:1080, hasElectric:true,  hasMotor:false },
  { id:'pappu',   name:'Pappu Dey (Borda)',          consumerId:'—',        meter:'—',       gasFixed:2160, hasElectric:false, hasMotor:false },
];

const PREPARED_BY = 'Prothom Dey Ovi';
const HOUSEHOLD_NAME = 'Dey Bari';

function getPreparedByText(){
  const names = Array.isArray(STORE.adminNames) ? STORE.adminNames : [PREPARED_BY];
  const clean = names.map(n => String(n || '').trim()).filter(Boolean);
  return clean.length ? clean.join(', ') : PREPARED_BY;
}

let STORE = loadStore();
let currentView = 'dashboard';
let dashChartInstance = null;
let memberChartInstance = null;
let selectedMemberId = null;

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------
function defaultStore(){
  return {
    pinHash: null,
    adminNames: [PREPARED_BY],
    users: JSON.parse(JSON.stringify(DEFAULT_USERS)),
    // Seeded with the real March 2025 figures from the original "Dey Bari" ledger,
    // so the ledger isn't empty on first use and Prev. Due carry-forward has a starting point.
    records: {
      '2025-03': {
        motorTotal: 386,
        entries: {
          mridul:  { gas:2160, electricity:1332, bkash:30, paid:3750, paidDate:'', txnId:'' },
          angshu:  { gas:0,    electricity:1767, bkash:23, paid:2000, paidDate:'', txnId:'' },
          mamoni:  { gas:1080, electricity:2303, bkash:20, paid:3600, paidDate:'', txnId:'' },
          boumoni: { gas:1080, electricity:930,  bkash:20, paid:2030, paidDate:'', txnId:'' },
          pappu:   { gas:2160, electricity:0,    bkash:10, paid:2170, paidDate:'', txnId:'' }
        }
      }
    }
  };
}

function loadStore(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    // Merge in any new default users that don't exist yet (schema safety)
    const existingIds = new Set((parsed.users||[]).map(u=>u.id));
    DEFAULT_USERS.forEach(u=>{
      if(!existingIds.has(u.id)) parsed.users.push(JSON.parse(JSON.stringify(u)));
    });
    parsed.records = parsed.records || {};
    parsed.adminNames = Array.isArray(parsed.adminNames) && parsed.adminNames.length
      ? parsed.adminNames
      : [PREPARED_BY];
    return parsed;
  }catch(e){
    console.error('Failed to load store, resetting.', e);
    return defaultStore();
  }
}

function saveStore(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STORE));
}

function getUsers(){ return STORE.users; }
function getUser(id){ return STORE.users.find(u=>u.id===id); }
function motorMemberCount(){ return STORE.users.filter(u=>u.hasMotor).length || 1; }

// ---------------------------------------------------------------------
// Simple PIN hashing (djb2) — good enough for a family-privacy gate,
// not intended as cryptographic security.
// ---------------------------------------------------------------------
function hashPin(pin){
  let h = 5381;
  for(let i=0;i<pin.length;i++){ h = ((h*33) ^ pin.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}

// ---------------------------------------------------------------------
// Month helpers
// ---------------------------------------------------------------------
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthLabel(key){ // "2026-06" -> "June 2026"
  const [y,m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m-1]} ${y}`;
}
function currentMonthKey(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function allSavedMonths(){
  return Object.keys(STORE.records).sort(); // ascending "YYYY-MM"
}
function previousSavedMonth(monthKey){
  const months = allSavedMonths().filter(m=>m<monthKey);
  return months.length ? months[months.length-1] : null;
}

// ---------------------------------------------------------------------
// Core calculation — mirrors the original spreadsheet formulas:
//   Total Bill = Gas + Electricity + Motor Share + Bkash Charge + Previous Due
//   Balance    = Paid − Total Bill   (negative = still due, positive = return/advance)
//   Motor Share = Motor Total ÷ number of motor-sharing members
// ---------------------------------------------------------------------
function computeUserMonth(userId, monthKey){
  const user = getUser(userId);
  const record = STORE.records[monthKey] || { motorTotal:0, entries:{} };
  const entry = record.entries[userId] || {};

  // Gas is snapshotted onto the entry when a month is saved, so later changes
  // to a member's fixed gas rate (in Settings) never rewrite past invoices.
  const gas = (entry.gas !== undefined ? entry.gas : user.gasFixed) || 0;
  const electricity = user.hasElectric ? Number(entry.electricity||0) : 0;
  const motorShare = user.hasMotor ? Number(record.motorTotal||0) / motorMemberCount() : 0;
  const bkash = Number(entry.bkash||0);

  const total = gas + electricity + motorShare + bkash;
  const paid = Number(entry.paid||0);
  const balance = paid - total;

  return {
    gas,
    electricity,
    motorShare,
    bkash,
    prevDue: 0,
    total,
    paid,
    balance,
    paidDate: entry.paidDate||'',
    txnId: entry.txnId || entry.gasTxnId || '',
    gasTxnId: entry.gasTxnId || entry.txnId || '',
    electricityTxnId: entry.electricityTxnId || '',
    motorTxnId: entry.motorTxnId || ''
  };
}

function householdTotalsForMonth(monthKey){
  let totalBill=0, totalPaid=0, totalCashCollected=0, totalBalance=0;
  let totalCashReceived=0, totalOnlinePaid=0, totalBkashDeposit=0, totalCashReturn=0;
  const pappuPaid = Number((STORE.records[monthKey]?.entries?.pappu?.paid) || 0);

  getUsers().forEach(u=>{
    const c = computeUserMonth(u.id, monthKey);
    const entry = (STORE.records[monthKey]?.entries?.[u.id]) || {};
    const hasOnlineTxn = Boolean(entry.gasTxnId || entry.txnId || entry.electricityTxnId || entry.motorTxnId);
    const paid = Number(entry.paid || c.paid || 0);
    const cashCollected = hasOnlineTxn ? 0 : paid;
    const onlinePaid = hasOnlineTxn ? paid : 0;

    totalBill += c.total;
    totalPaid += paid;
    totalCashCollected += cashCollected;
    totalCashReceived += cashCollected;
    totalOnlinePaid += onlinePaid;
  });

  totalBalance = totalPaid - totalBill;
  totalCashCollected = Math.max(totalPaid - pappuPaid, 0);
  totalCashReceived = Math.max(totalCashCollected, 0);
  totalBkashDeposit = totalPaid - totalBalance - pappuPaid;
  totalCashReturn = totalBalance;

  return { totalBill, totalPaid, totalCashCollected, totalBalance, totalCashReceived, totalOnlinePaid, totalBkashDeposit, totalCashReturn };
}

function getDraftCashSummary(monthKey){
  if(!monthKey){ return { totalCashReceived:0, totalOnlinePaid:0, totalBkashDeposit:0, totalCashReturn:0 }; }
  const rows = document.querySelectorAll('#entryTable tbody tr');
  let totalCashReceived = 0;
  let totalOnlinePaid = 0;
  let totalPaid = 0;
  const pappuPaid = Number((STORE.records[monthKey]?.entries?.pappu?.paid) || 0);

  rows.forEach(tr => {
    const uid = tr.dataset.user;
    const user = getUser(uid);
    if(!user) return;
    const paid = Number(tr.querySelector('.f-paid')?.value || 0);
    const gasTxn = tr.querySelector('.f-gas-txn')?.value || '';
    const elecTxn = tr.querySelector('.f-electricity-txn')?.value || '';
    const motorTxn = tr.querySelector('.f-motor-txn')?.value || '';
    const isOnline = Boolean(gasTxn || elecTxn || motorTxn);

    totalPaid += paid;
    if(isOnline){
      totalOnlinePaid += paid;
    } else {
      totalCashReceived += paid;
    }
  });

  totalCashReceived = Math.max(totalPaid - pappuPaid, 0);
  const totalBkashDeposit = totalPaid - totalCashReceived - pappuPaid;
  const totalCashReturn = totalCashReceived - totalBkashDeposit;

  return { totalCashReceived, totalOnlinePaid, totalBkashDeposit, totalCashReturn };
}

function renderCashAccountsBox(summary){
  const cashBox = document.getElementById('cashAccountsBox');
  if(!cashBox) return;
  const cashReceived = Number(summary?.totalCashReceived || 0);
  const bkash = Number(summary?.totalBkashDeposit || 0);
  const netBalance = Number(summary?.totalCashReturn || 0);

  cashBox.innerHTML = `
    <div class="cash-box-title">Cash Accounts:</div>
    <div class="cash-row"><div>Cash Received:</div><div class="cash-num">${fmt(cashReceived)}</div></div>
    <div class="cash-row"><div>Deposit in Bkash:</div><div class="cash-num">${fmt(bkash)}</div></div>
    <div class="cash-row"><div>Net Balance:</div><div class="cash-num ${netBalance < 0 ? 'negative' : ''}">${netBalance < 0 ? '−' : ''}${fmt(Math.abs(netBalance))}</div></div>
  `;
}

function fmt(n){
  const v = Math.round((n||0)*100)/100;
  return '৳' + v.toLocaleString('en-BD', {maximumFractionDigits:2});
}
function escapeHtml(str){
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function balancePill(balance){
  if(Math.abs(balance) < 0.5) return `<span class="pill even">Settled</span>`;
  if(balance < 0) return `<span class="pill due">Due ${fmt(-balance)}</span>`;
  return `<span class="pill paid">Return ${fmt(balance)}</span>`;
}

function gasBalanceDisplay(balance){
  if(Math.abs(balance) < 0.5) return 'Settled';
  if(balance < 0) return `Due ${fmt(-balance)}`;
  return `Return ${fmt(balance)}`;
}

// =======================================================================
// LOGIN / PIN
// =======================================================================
let pinBuffer = '';

function initLogin(){
  const loginAccountantInput = document.getElementById('loginAccountantInput');
  if (loginAccountantInput) {
    loginAccountantInput.value = '';
  }

  const setupAccountantInput = document.getElementById('setupAccountantInput');
  if (setupAccountantInput) {
    setupAccountantInput.value = '';
  }

  if(!STORE.pinHash){
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('setupScreen').style.display='flex';
    return;
  }
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('setupScreen').style.display='none';

  document.getElementById('keypad').addEventListener('click', e=>{
    const btn = e.target.closest('button'); if(!btn) return;
    const k = btn.dataset.k;
    if(k==='clear'){ pinBuffer=''; }
    else if(k==='back'){ pinBuffer = pinBuffer.slice(0,-1); }
    else if(pinBuffer.length<4){ pinBuffer += k; }
    renderPinDots();
    if(pinBuffer.length===4){ checkPin(); }
  });
}

function renderPinDots(){
  const dots = document.querySelectorAll('#pinDots span');
  dots.forEach((d,i)=> d.classList.toggle('filled', i < pinBuffer.length));
}

function checkPin(){
  const errEl = document.getElementById('pinError');
  if(hashPin(pinBuffer) === STORE.pinHash){
    errEl.textContent='';
    unlockApp();
  }else{
    errEl.textContent='Incorrect PIN — try again';
    pinBuffer='';
    setTimeout(renderPinDots, 120);
  }
}

function unlockApp(){
  const loginAccountantInput = document.getElementById('loginAccountantInput');
  const value = loginAccountantInput ? loginAccountantInput.value.trim() : '';
  if (value) {
    const names = value.split(',').map(v => v.trim()).filter(Boolean);
    STORE.adminNames = names.length ? names : [PREPARED_BY];
    saveStore();
  }

  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='flex';
  boot();
}

document.getElementById('setupSaveBtn').addEventListener('click', ()=>{
  const p1 = document.getElementById('setupPinInput').value.trim();
  const p2 = document.getElementById('setupPinConfirm').value.trim();
  const err = document.getElementById('setupError');
  if(!/^\d{4}$/.test(p1)){ err.textContent='PIN must be exactly 4 digits.'; return; }
  if(p1!==p2){ err.textContent='PIN entries do not match.'; return; }
  const accountantName = document.getElementById('setupAccountantInput').value.trim();
  STORE.pinHash = hashPin(p1);
  STORE.adminNames = accountantName ? accountantName.split(',').map(v => v.trim()).filter(Boolean) : [PREPARED_BY];
  saveStore();
  document.getElementById('setupScreen').style.display='none';
  unlockApp();
});

document.getElementById('lockBtn').addEventListener('click', ()=>{
  document.getElementById('app').style.display='none';
  pinBuffer='';
  renderPinDots();
  const loginAccountantInput = document.getElementById('loginAccountantInput');
  if (loginAccountantInput) {
    loginAccountantInput.value = '';
  }
  document.getElementById('loginScreen').style.display='flex';
});

// =======================================================================
// NAVIGATION
// =======================================================================
function setupNav(){
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      showView(btn.dataset.view);
    });
  });
}
function showView(view){
  currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.style.display='none');
  document.getElementById('view-'+view).style.display='block';
  if(view==='dashboard') renderDashboard();
  if(view==='entry') renderEntry();
  if(view==='history') renderHistory();
  if(view==='users') renderUsers();
  if(view==='print') renderPrintView();
  if(view==='settings') renderSettings();
}

// =======================================================================
// BOOT
// =======================================================================
function boot(){
  setupNav();
  showView('dashboard');
}

// =======================================================================
// DASHBOARD
// =======================================================================
function renderDashboard(){
  const months = allSavedMonths();
  const sel = document.getElementById('dashMonthSelect');
  const prevSelected = sel.value;
  sel.innerHTML = months.length
    ? months.slice().reverse().map(m=>`<option value="${m}">${monthLabel(m)}</option>`).join('')
    : `<option value="">No months saved yet</option>`;
  if(months.includes(prevSelected)) sel.value = prevSelected;
  sel.onchange = renderDashboardBody;
  renderDashboardBody();
}

function renderDashboardBody(){
  const sel = document.getElementById('dashMonthSelect');
  const monthKey = sel.value;
  document.getElementById('dashMonthLabel').textContent = monthKey ? monthLabel(monthKey) : 'No data yet — start with Monthly Entry';

  const statGrid = document.getElementById('statGrid');
  const userTable = document.getElementById('dashUserTable');

  if(!monthKey){
    statGrid.innerHTML = '';
    userTable.innerHTML = `<tr><td class="muted" style="padding:16px;">No monthly bills saved yet. Go to <b>Monthly Entry</b> to add the first one.</td></tr>`;
    renderDashChart();
    return;
  }

  const totals = householdTotalsForMonth(monthKey);
  statGrid.innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Bill</div><div class="stat-value">${fmt(totals.totalBill)}</div></div>
    <div class="stat-card"><div class="stat-label">Total Paid</div><div class="stat-value">${fmt(totals.totalPaid)}</div></div>
    <div class="stat-card paid"><div class="stat-label">Cash Collected</div><div class="stat-value">${fmt(totals.totalCashCollected)}</div></div>
    <div class="stat-card ${totals.totalBalance<0?'due':'paid'}"><div class="stat-label">Net Balance</div><div class="stat-value">${totals.totalBalance<0?'−':''}${fmt(Math.abs(totals.totalBalance))}</div></div>
    <div class="stat-card"><div class="stat-label">Household Members</div><div class="stat-value">${getUsers().length}</div></div>
  `;

  renderCashAccountsBox({
    totalCashReceived: totals.totalCashReceived,
    totalBkashDeposit: totals.totalBkashDeposit,
    totalCashReturn: totals.totalCashReturn
  });

  let rows = `<thead><tr><th>Member</th><th>Gas</th><th>Electricity</th><th>Motor</th><th>Bkash</th><th>Total Bill</th><th>Paid</th><th>Balance</th></tr></thead><tbody>`;
  getUsers().forEach(u=>{
    const c = computeUserMonth(u.id, monthKey);
    rows += `<tr>
      <td>${u.name}</td>
      <td class="num">${fmt(c.gas)}</td>
      <td class="num">${u.hasElectric?fmt(c.electricity):'—'}</td>
      <td class="num">${u.hasMotor?fmt(c.motorShare):'—'}</td>
      <td class="num">${fmt(c.bkash)}</td>
      <td class="num"><b>${fmt(c.total)}</b></td>
      <td class="num">${fmt(c.paid)}</td>
      <td class="num">${balancePill(c.balance)}</td>
    </tr>`;
  });
  rows += `</tbody>`;
  userTable.innerHTML = rows;

  renderDashChart();
}

function renderDashChart(){
  const ctx = document.getElementById('dashChart');
  const months = allSavedMonths().slice(-6);
  const bills = months.map(m=>householdTotalsForMonth(m).totalBill);
  const cashCollected = months.map(m=>householdTotalsForMonth(m).totalCashCollected);

  if(typeof Chart === 'undefined' || !ctx){ return; }
  if(dashChartInstance) dashChartInstance.destroy();
  dashChartInstance = new Chart(ctx, {
    type:'bar',
    data:{
      labels: months.map(m=>monthLabel(m).replace(' ',' \'').replace('20','')),
      datasets:[
        {label:'Total Bill', data:bills, backgroundColor:'#A6521D'},
        {label:'Cash Collected', data:cashCollected, backgroundColor:'#2E6F5E'}
      ]
    },
    options:{
      responsive:true,
      plugins:{legend:{position:'bottom', labels:{font:{family:'Inter'}}}},
      scales:{
        y:{ticks:{callback:v=>'৳'+v}},
        x:{grid:{display:false}}
      }
    }
  });
}

// =======================================================================
// MONTHLY ENTRY
// =======================================================================
function updateCalculatorPreview(){
  const monthKey = document.getElementById('entryMonth')?.value;
  if(!monthKey){ return; }

  const record = STORE.records[monthKey] || { motorTotal: 0, entries: {} };
  const sharedMotorInput = document.getElementById('sharedMotorTotalInput');
  if(sharedMotorInput && !sharedMotorInput.value && record.motorTotal){
    sharedMotorInput.value = record.motorTotal;
  }

  getUsers().forEach(u => {
    const entry = record.entries?.[u.id] || {};
    const gasInput = document.querySelector(`.calc-user-gas[data-user="${u.id}"]`);
    const electricityInput = document.querySelector(`.calc-user-electricity[data-user="${u.id}"]`);
    const bkashInput = document.querySelector(`.calc-user-bkash[data-user="${u.id}"]`);
    const paidInput = document.querySelector(`.calc-user-paid[data-user="${u.id}"]`);

    if(gasInput && !gasInput.value) gasInput.value = Number((entry.gas ?? u.gasFixed) || 0);
    if(electricityInput && !electricityInput.value && entry.electricity !== undefined) electricityInput.value = Number(entry.electricity || 0);
    if(bkashInput && !bkashInput.value && entry.bkash !== undefined) bkashInput.value = Number(entry.bkash || 0);
    if(paidInput && !paidInput.value && entry.paid !== undefined) paidInput.value = Number(entry.paid || 0);
  });

  updateUserCalculatorTotals();
}

function generateUserBillCalculator(){
  const wrap = document.getElementById('userBillCalculator');
  if(!wrap) return;

  const users = getUsers();
  wrap.innerHTML = users.map(u => `
      <div class="panel" style="margin-bottom:12px; padding:16px; background:#fff; border:1px solid #e7dfd0; border-radius:12px;">
        <div class="panel-head" style="padding:0 0 8px;">
          <h3 style="margin:0; font-size:1rem;">${u.name}</h3>
        </div>
        <div class="motor-row">
          <label>Gas bill (৳)</label>
          <input type="number" min="0" step="1" class="calc-user-gas" data-user="${u.id}" value="${u.gasFixed || 0}" placeholder="0">
        </div>
        <div class="motor-row">
          <label>Electricity bill (৳)</label>
          <input type="number" min="0" step="1" class="calc-user-electricity" data-user="${u.id}" placeholder="0">
        </div>
        <div class="motor-row">
          <label>Bkash charge (৳)</label>
          <input type="number" min="0" step="1" class="calc-user-bkash" data-user="${u.id}" placeholder="0">
        </div>
        <div class="motor-row">
          <label>Paid amount (৳)</label>
          <input type="number" min="0" step="1" class="calc-user-paid" data-user="${u.id}" placeholder="0">
        </div>
        <div class="motor-row">
          <label>Member total</label>
          <strong class="calc-user-total" data-user="${u.id}">৳0</strong>
        </div>
      </div>
    `).join('');

  const sharedMotorInput = document.getElementById('sharedMotorTotalInput');
  if(sharedMotorInput){
    sharedMotorInput.addEventListener('input', updateUserCalculatorTotals);
  }

  wrap.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', updateUserCalculatorTotals);
  });

  updateCalculatorPreview();
}

function updateUserCalculatorTotals(){
  const users = getUsers();
  const sharedMotorInput = document.getElementById('sharedMotorTotalInput');
  const sharedMotorTotal = Number(sharedMotorInput?.value || 0);
  const motorUsers = getUsers().filter(u => u.hasMotor).length || 1;

  users.forEach(u => {
    const gasInput = document.querySelector(`.calc-user-gas[data-user="${u.id}"]`);
    const electricityInput = document.querySelector(`.calc-user-electricity[data-user="${u.id}"]`);
    const bkashInput = document.querySelector(`.calc-user-bkash[data-user="${u.id}"]`);
    const paidInput = document.querySelector(`.calc-user-paid[data-user="${u.id}"]`);
    const totalEl = document.querySelector(`.calc-user-total[data-user="${u.id}"]`);
    if(!totalEl) return;

    const gas = Number(gasInput?.value || u.gasFixed || 0);
    const electricity = Number(electricityInput?.value || 0);
    const bkash = Number(bkashInput?.value || 0);
    const paid = Number(paidInput?.value || 0);
    const motorShare = u.hasMotor ? sharedMotorTotal / motorUsers : 0;
    const total = gas + electricity + motorShare + bkash;
    const balance = paid - total;

    totalEl.textContent = balance < 0 ? `৳${Math.abs(balance)} due` : `৳${Math.abs(balance)} return`;
  });

  const sharedMotorHint = document.getElementById('sharedMotorSplitHint');
  if(sharedMotorHint){
    sharedMotorHint.textContent = `Split between ${motorUsers} motor users → ${fmt(sharedMotorTotal / motorUsers)} each`;
  }
}

function applyCalculatorToEntries(){
  const monthKey = document.getElementById('entryMonth').value;
  if(!monthKey){ alert('Please choose a billing month first.'); return; }

  const sharedMotorInput = document.getElementById('sharedMotorTotalInput');
  const totalMotorBill = Number(sharedMotorInput?.value || 0);

  if(!STORE.records[monthKey]) STORE.records[monthKey] = { motorTotal: 0, entries: {} };
  const monthRecord = STORE.records[monthKey];
  monthRecord.motorTotal = totalMotorBill;
  const existingEntries = monthRecord.entries || {};

  const motorInput = document.getElementById('motorTotalInput');
  if(motorInput) motorInput.value = totalMotorBill;
  if(sharedMotorInput) sharedMotorInput.value = totalMotorBill;

  document.querySelectorAll('#entryTable tbody tr').forEach(tr=>{
    const uid = tr.dataset.user;
    const user = getUser(uid);
    const gasInput = document.querySelector(`.calc-user-gas[data-user="${uid}"]`);
    const electricityInput = document.querySelector(`.calc-user-electricity[data-user="${uid}"]`);
    const bkashInput = document.querySelector(`.calc-user-bkash[data-user="${uid}"]`);
    const paidInput = document.querySelector(`.calc-user-paid[data-user="${uid}"]`);

    const gasValue = Number(gasInput?.value || user.gasFixed || 0);
    const electricityValue = user.hasElectric ? Number(electricityInput?.value || 0) : 0;
    const bkashValue = Number(bkashInput?.value || 0);
    const paidValue = Number(paidInput?.value || 0);
    const preserved = existingEntries[uid] || {};

    monthRecord.entries[uid] = {
      ...preserved,
      gas: gasValue,
      electricity: electricityValue,
      bkash: bkashValue,
      paid: paidValue,
      paidDate: tr.querySelector('.f-paiddate')?.value || preserved.paidDate || '',
      gasTxnId: tr.querySelector('.f-gas-txn')?.value || preserved.gasTxnId || '',
      electricityTxnId: tr.querySelector('.f-electricity-txn')?.value || preserved.electricityTxnId || '',
      motorTxnId: tr.querySelector('.f-motor-txn')?.value || preserved.motorTxnId || '',
      txnId: tr.querySelector('.f-gas-txn')?.value || preserved.txnId || preserved.gasTxnId || ''
    };

    const elecField = tr.querySelector('.f-electricity');
    if(elecField) elecField.value = electricityValue;

    const bkashField = tr.querySelector('.f-bkash');
    if(bkashField) bkashField.value = bkashValue;

    const paidField = tr.querySelector('.f-paid');
    if(paidField) paidField.value = paidValue;
  });

  saveStore();
  renderEntryBody();
}

function renderEntry(){
  const input = document.getElementById('entryMonth');
  if(!input.value){
    const months = allSavedMonths();
    input.value = months.length ? nextMonthKey(months[months.length-1]) : currentMonthKey();
  }
  input.onchange = renderEntryBody;
  document.getElementById('motorTotalInput').oninput = renderEntryBody;
  generateUserBillCalculator();
  document.getElementById('applyCalculatorBtn').onclick = applyCalculatorToEntries;
  renderEntryBody();

  document.getElementById('entrySaveBtn').onclick = saveEntry;
}

function nextMonthKey(key){
  let [y,m] = key.split('-').map(Number);
  m += 1; if(m>12){m=1;y+=1;}
  return `${y}-${String(m).padStart(2,'0')}`;
}

function renderEntryBody(){
  const monthKey = document.getElementById('entryMonth').value;
  if(!monthKey) return;
  const record = STORE.records[monthKey] || {motorTotal:0, entries:{}};
  const motorInput = document.getElementById('motorTotalInput');
  const sharedMotorInput = document.getElementById('sharedMotorTotalInput');
  const isEditingMotorField = document.activeElement === motorInput || document.activeElement === sharedMotorInput;

  if(sharedMotorInput && !isEditingMotorField && String(sharedMotorInput.value || '').trim() === ''){
    sharedMotorInput.value = record.motorTotal ?? '';
  }

  if(motorInput && !isEditingMotorField && String(motorInput.value || '').trim() === ''){
    motorInput.value = record.motorTotal ?? '';
  }

  const motorTotal = Number(motorInput.value || sharedMotorInput?.value || 0);
  if(sharedMotorInput && !isEditingMotorField) sharedMotorInput.value = motorTotal || '';
  document.getElementById('motorShareHint').textContent =
    `Split between ${motorMemberCount()} member(s) sharing the motor → ${fmt(motorTotal/motorMemberCount())} each`;
  if(document.getElementById('sharedMotorSplitHint')) {
    document.getElementById('sharedMotorSplitHint').textContent =
      `Split between ${motorMemberCount()} member(s) sharing the motor → ${fmt(motorTotal/motorMemberCount())} each`;
  }

  updateCalculatorPreview();

  const table = document.getElementById('entryTable');
  let html = `<thead><tr>
    <th>Member</th><th>Gas (fixed)</th><th>Electricity</th><th>Motor Share</th><th>Bkash Charge</th>
    <th>Total Bill</th><th>Paid Amount</th><th>Paid Date</th>
    <th>Gas Txn ID</th><th>Electricity Txn ID</th><th>Motor Txn ID</th><th>Balance</th>
  </tr></thead><tbody>`;

  getUsers().forEach(u=>{
    const entry = record.entries[u.id] || {};
    const c = computeUserMonth(u.id, monthKey);
    html += `<tr data-user="${u.id}">
      <td>${u.name}</td>
      <td class="num">${fmt(c.gas)}</td>
      <td class="num">${u.hasElectric ? `<input type="number" min="0" class="f-electricity" value="${entry.electricity??''}" placeholder="0">` : '—'}</td>
      <td class="num">${u.hasMotor ? fmt(c.motorShare) : '—'}</td>
      <td class="num"><input type="number" min="0" class="f-bkash" value="${entry.bkash??''}" placeholder="0"></td>
      <td class="num row-total"><b>${fmt(c.total)}</b></td>
      <td class="num"><input type="number" min="0" class="f-paid" value="${entry.paid??''}" placeholder="0"></td>
      <td><input type="date" class="f-paiddate" value="${entry.paidDate||''}"></td>
      <td><input type="text" class="f-gas-txn" value="${entry.gasTxnId || entry.txnId || ''}" placeholder="Gas TR ID" style="width:120px;"></td>
      <td><input type="text" class="f-electricity-txn" value="${entry.electricityTxnId || ''}" placeholder="Elec TR ID" style="width:120px;"></td>
      <td><input type="text" class="f-motor-txn" value="${entry.motorTxnId || ''}" placeholder="Motor TR ID" style="width:120px;"></td>
      <td class="num row-balance">${balancePill(c.balance)}</td>
    </tr>`;
  });
  html += `</tbody>`;
  table.innerHTML = html;

  // live recompute on any input change (uses draft values without saving)
  table.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=> liveRecomputeRow(inp.closest('tr'), monthKey));
  });
  document.getElementById('entrySavedNote').textContent = STORE.records[monthKey] ? 'Loaded previously saved data for this month.' : 'New month — not yet saved.';
  updateCalculatorPreview();
}

function liveRecomputeRow(tr, monthKey){
  const userId = tr.dataset.user;
  const user = getUser(userId);
  const motorTotal = Number(document.getElementById('motorTotalInput').value||0);
  document.getElementById('motorShareHint').textContent =
    `Split between ${motorMemberCount()} member(s) sharing the motor → ${fmt(motorTotal/motorMemberCount())} each`;

  const electricity = user.hasElectric ? Number(tr.querySelector('.f-electricity')?.value||0) : 0;
  const bkash = Number(tr.querySelector('.f-bkash').value||0);
  const paid = Number(tr.querySelector('.f-paid').value||0);
  const motorShare = user.hasMotor ? motorTotal/motorMemberCount() : 0;

  const total = user.gasFixed + electricity + motorShare + bkash;
  const balance = paid - total;

  tr.querySelector('.row-total').innerHTML = `<b>${fmt(total)}</b>`;
  tr.querySelector('.row-balance').innerHTML = balancePill(balance);

  // also refresh every other row's motor share cell if motor total changed
  document.querySelectorAll('#entryTable tbody tr').forEach(row=>{
    const uid = row.dataset.user;
    const u2 = getUser(uid);
    if(u2.hasMotor){
      const cells = row.querySelectorAll('td');
      cells[3].textContent = fmt(motorTotal/motorMemberCount());
    }
  });

  renderCashAccountsBox(getDraftCashSummary(monthKey));
}

function saveEntry(){
  const monthKey = document.getElementById('entryMonth').value;
  if(!monthKey){ alert('Please choose a billing month first.'); return; }
  const motorTotal = Number(document.getElementById('motorTotalInput').value||0);
  const entries = {};
  document.querySelectorAll('#entryTable tbody tr').forEach(tr=>{
    const userId = tr.dataset.user;
    const user = getUser(userId);
    entries[userId] = {
      gas: user.gasFixed, // snapshot the fixed charge in effect this month
      electricity: user.hasElectric ? Number(tr.querySelector('.f-electricity')?.value||0) : 0,
      bkash: Number(tr.querySelector('.f-bkash').value||0),
      paid: Number(tr.querySelector('.f-paid').value||0),
      paidDate: tr.querySelector('.f-paiddate').value || '',
      gasTxnId: tr.querySelector('.f-gas-txn')?.value || '',
      electricityTxnId: tr.querySelector('.f-electricity-txn')?.value || '',
      motorTxnId: tr.querySelector('.f-motor-txn')?.value || '',
      txnId: tr.querySelector('.f-gas-txn')?.value || ''
    };
  });
  STORE.records[monthKey] = { motorTotal, entries };
  saveStore();
  document.getElementById('entrySavedNote').textContent = `Saved ${monthLabel(monthKey)} ✓`;
  renderEntryBody();
}

// =======================================================================
// HISTORY
// =======================================================================
function renderHistory(){
  const filterSel = document.getElementById('historyUserFilter');
  filterSel.innerHTML = `<option value="__all__">All members</option>` +
    getUsers().map(u=>`<option value="${u.id}">${u.name}</option>`).join('');
  filterSel.onchange = renderHistoryBody;

  const monthFilter = document.getElementById('historyMonthFilter');
  const months = allSavedMonths().slice().reverse();
  monthFilter.innerHTML = months.length ? months.map(m=>`<option value="${m}">${monthLabel(m)}</option>`).join('') : '<option value="">No months saved</option>';
  if(months.length && !STORE.records[monthFilter.value]){
    monthFilter.value = months[0];
  }
  monthFilter.onchange = renderHistoryBody;

  const clearBtn = document.getElementById('clearHistoryBtn');
  clearBtn.disabled = !months.length || !monthFilter.value;
  clearBtn.onclick = ()=>{
    const selectedMonth = monthFilter.value;
    if(!selectedMonth){
      alert('Please select a month to clear first.');
      return;
    }
    const confirmed = window.confirm(`Delete all saved data for ${monthLabel(selectedMonth)}? This only affects the selected month.`);
    if(!confirmed) return;
    delete STORE.records[selectedMonth];
    saveStore();
    renderHistory();
  };

  const clearAllBtn = document.getElementById('clearAllHistoryBtn');
  clearAllBtn.disabled = !months.length;
  clearAllBtn.onclick = ()=>{
    if(!months.length){
      alert('There is no saved history to clear.');
      return;
    }
    const confirmed = window.confirm('Delete all saved monthly billing history for every month? This cannot be undone.');
    if(!confirmed) return;
    STORE.records = {};
    saveStore();
    renderHistory();
  };

  renderHistoryBody();
}

function renderHistoryBody(){
  const filter = document.getElementById('historyUserFilter').value;
  const table = document.getElementById('historyTable');
  const months = allSavedMonths().slice().reverse();

  if(!months.length){
    table.innerHTML = `<tr><td class="muted" style="padding:16px;">No history yet.</td></tr>`;
    return;
  }

  const selectedUsers = filter === '__all__' ? getUsers() : getUsers().filter(u => u.id === filter);

  let html = `<thead><tr><th>Month</th><th>Member</th><th>Gas</th><th>Electricity</th><th>Motor</th><th>Bkash</th><th>Total</th><th>Paid</th><th>Balance</th><th>Paid Date</th><th>Gas Txn ID</th><th>Electricity Txn ID</th><th>Motor Txn ID</th></tr></thead><tbody>`;

  months.forEach(monthKey=>{
    if(filter === '__all__'){
      const monthTotals = { gas:0, electricity:0, motor:0, bkash:0, total:0, paid:0, balance:0 };
      getUsers().forEach(u => {
        const c = computeUserMonth(u.id, monthKey);
        monthTotals.gas += c.gas;
        monthTotals.electricity += c.electricity;
        monthTotals.motor += c.motorShare;
        monthTotals.bkash += c.bkash;
        monthTotals.total += c.total;
        monthTotals.paid += c.paid;
        monthTotals.balance += c.balance;
      });

      html += `<tr style="background:#F4F0E4; font-weight:700;">
        <td>${monthLabel(monthKey)}</td>
        <td>All Members</td>
        <td class="num">${fmt(monthTotals.gas)}</td>
        <td class="num">${fmt(monthTotals.electricity)}</td>
        <td class="num">${fmt(monthTotals.motor)}</td>
        <td class="num">${fmt(monthTotals.bkash)}</td>
        <td class="num">${fmt(monthTotals.total)}</td>
        <td class="num">${fmt(monthTotals.paid)}</td>
        <td class="num">${balancePill(monthTotals.balance)}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
      </tr>`;
    }

    selectedUsers.forEach(u => {
      const c = computeUserMonth(u.id, monthKey);
      const entry = (STORE.records[monthKey]?.entries?.[u.id]) || {};
      const paidDate = entry.paidDate || c.paidDate || '—';
      const gasTxn = entry.gasTxnId || entry.txnId || c.gasTxnId || '—';
      const electricityTxn = entry.electricityTxnId || c.electricityTxnId || '—';
      const motorTxn = entry.motorTxnId || c.motorTxnId || '—';

      html += `<tr>
        <td>${filter === '__all__' ? monthLabel(monthKey) : monthLabel(monthKey)}</td>
        <td>${u.name}</td>
        <td class="num">${fmt(c.gas)}</td>
        <td class="num">${fmt(c.electricity)}</td>
        <td class="num">${fmt(c.motorShare)}</td>
        <td class="num">${fmt(c.bkash)}</td>
        <td class="num"><b>${fmt(c.total)}</b></td>
        <td class="num">${fmt(c.paid)}</td>
        <td class="num">${balancePill(c.balance)}</td>
        <td>${paidDate}</td>
        <td>${gasTxn}</td>
        <td>${electricityTxn}</td>
        <td>${motorTxn}</td>
      </tr>`;
    });
  });

  html += `</tbody>`;
  table.innerHTML = html;
}

// =======================================================================
// HOUSEHOLD MEMBERS (users + yearly analysis)
// =======================================================================
function renderUsers(){
  const wrap = document.getElementById('memberCards');
  wrap.innerHTML = getUsers().map(u=>`
    <div class="member-card" data-user="${u.id}">
      <div class="m-name">${u.name}</div>
      <div class="m-meta">Consumer ID: ${u.consumerId} &nbsp;·&nbsp; Meter: ${u.meter}</div>
      <div class="m-fixed">Gas Bill: <b>${fmt(u.gasFixed)}</b></div>
      <div class="m-fixed">${u.hasMotor ? 'Shares motor bill' : 'No motor share'} &nbsp;·&nbsp; ${u.hasElectric?'Has electricity meter':'No electricity meter'}</div>
    </div>
  `).join('');
  wrap.querySelectorAll('.member-card').forEach(card=>{
    card.addEventListener('click', ()=>{ selectedMemberId = card.dataset.user; renderMemberDetail(); });
  });
  if(selectedMemberId){ renderMemberDetail(); } else { document.getElementById('memberDetailPanel').style.display='none'; }
}

function renderMemberDetail(){
  const panel = document.getElementById('memberDetailPanel');
  panel.style.display='block';
  const user = getUser(selectedMemberId);
  document.getElementById('memberDetailName').textContent = `${user.name} — Yearly Analysis`;

  const years = Array.from(new Set(allSavedMonths().map(m=>m.split('-')[0]))).sort().reverse();
  const yearSel = document.getElementById('memberDetailYear');
  const prevYear = yearSel.value;
  yearSel.innerHTML = years.length ? years.map(y=>`<option value="${y}">${y}</option>`).join('') : `<option value="">No data</option>`;
  if(years.includes(prevYear)) yearSel.value = prevYear;
  yearSel.onchange = renderMemberYearBody;
  renderMemberYearBody();
}

function drawMemberLineChart(canvas, labels, billValues){
  if(!canvas){ return; }
  const ctx = canvas.getContext('2d');
  if(!ctx){ return; }

  const w = canvas.clientWidth || 920;
  const h = canvas.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if(!labels.length || !billValues.length){ return; }

  const pad = { top: 28, right: 22, bottom: 56, left: 70 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxValue = Math.max(...billValues, 1);
  const gap = plotW / labels.length;
  const barWidth = Math.min(52, gap * 0.56);

  const bg = '#f7f1ea';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#f0e7dc';
  ctx.fillRect(pad.left, pad.top, w - pad.left - pad.right, plotH);

  ctx.strokeStyle = '#d9d0c2';
  ctx.lineWidth = 1;
  for(let i = 0; i <= 5; i++){
    const value = (maxValue / 5) * i;
    const y = pad.top + plotH - (value / maxValue) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = '#5d6669';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(value), pad.left - 12, y + 4);
  }

  const highestIndex = billValues.indexOf(Math.max(...billValues));
  const lowestIndex = billValues.indexOf(Math.min(...billValues));

  labels.forEach((label, index) => {
    const value = billValues[index];
    const x = pad.left + index * gap + gap / 2 - barWidth / 2;
    const barHeight = (value / maxValue) * plotH;
    const baseY = h - pad.bottom;
    const topY = baseY - barHeight;
    const isHighest = index === highestIndex;
    const isLowest = index === lowestIndex;

    ctx.fillStyle = isHighest ? '#2d6d72' : isLowest ? '#b86a2c' : '#5cb0b2';
    ctx.fillRect(x, topY, barWidth, barHeight);

    ctx.fillStyle = isHighest ? '#234f52' : isLowest ? '#8f5321' : '#3d8c8f';
    ctx.fillRect(x + 4, topY - 9, barWidth - 8, 9);

    if(isHighest || isLowest){
      ctx.fillStyle = '#1f2e35';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isHighest ? 'High' : 'Low', x + barWidth / 2, topY - 16);
    }

    ctx.fillStyle = '#2d3639';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + barWidth / 2, h - 18);
  });

  ctx.strokeStyle = '#2d3639';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(pad.left, h - pad.bottom);
  ctx.lineTo(w - pad.right, h - pad.bottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.stroke();

  ctx.fillStyle = '#1d2c30';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${labels[highestIndex]} – highest`, pad.left + 14, 18);
  ctx.fillText(`${labels[lowestIndex]} – lowest`, pad.left + 14, 34);
}

function renderMemberYearBody(){
  const user = getUser(selectedMemberId);
  const year = document.getElementById('memberDetailYear').value;
  const statGrid = document.getElementById('memberYearStats');
  const table = document.getElementById('memberYearTable');

  if(!year){
    statGrid.innerHTML=''; table.innerHTML=`<tr><td class="muted" style="padding:16px;">No saved months for this member yet.</td></tr>`;
    if(memberChartInstance) memberChartInstance.destroy();
    return;
  }

  const monthsInYear = allSavedMonths().filter(m=>m.startsWith(year));
  let sums = {gas:0,electricity:0,motor:0,bkash:0,total:0,paid:0,balance:0};
  monthsInYear.forEach(m=>{
    const c = computeUserMonth(user.id, m);
    sums.gas+=c.gas; sums.electricity+=c.electricity; sums.motor+=c.motorShare; sums.bkash+=c.bkash;
    sums.total+=c.total; sums.paid+=c.paid; sums.balance+=c.balance;
  });

  statGrid.innerHTML = `
    <div class="stat-card"><div class="stat-label">Year Total Billed</div><div class="stat-value">${fmt(sums.total)}</div></div>
    <div class="stat-card paid"><div class="stat-label">Year Total Paid</div><div class="stat-value">${fmt(sums.paid)}</div></div>
    <div class="stat-card ${sums.balance<0?'due':'paid'}"><div class="stat-label">Net Balance</div><div class="stat-value">${sums.balance<0?'−':''}${fmt(Math.abs(sums.balance))}</div></div>
    <div class="stat-card"><div class="stat-label">Months Billed</div><div class="stat-value">${monthsInYear.length}</div></div>
  `;

  const canvas = document.getElementById('memberChart');
  if(canvas){
    const monthLabels = monthsInYear.map(m=>monthLabel(m).split(' ')[0].slice(0,3));
    const billValues = monthsInYear.map(m=>computeUserMonth(user.id,m).total);
    drawMemberLineChart(canvas, monthLabels, billValues);
  }

  let html = `<thead><tr><th>Month</th><th>Gas</th><th>Electricity</th><th>Motor</th><th>Bkash</th><th>Total</th><th>Paid</th><th>Balance</th></tr></thead><tbody>`;
  monthsInYear.slice().reverse().forEach(m=>{
    const c = computeUserMonth(user.id, m);
    html += `<tr>
      <td>${monthLabel(m)}</td><td class="num">${fmt(c.gas)}</td><td class="num">${user.hasElectric?fmt(c.electricity):'—'}</td>
      <td class="num">${user.hasMotor?fmt(c.motorShare):'—'}</td><td class="num">${fmt(c.bkash)}</td>
      <td class="num"><b>${fmt(c.total)}</b></td><td class="num">${fmt(c.paid)}</td><td class="num">${balancePill(c.balance)}</td>
    </tr>`;
  });
  html += `<tr style="background:#F4F0E4;"><td><b>Year Total</b></td><td class="num"><b>${fmt(sums.gas)}</b></td><td class="num"><b>${fmt(sums.electricity)}</b></td><td class="num"><b>${fmt(sums.motor)}</b></td><td class="num"><b>${fmt(sums.bkash)}</b></td><td class="num"><b>${fmt(sums.total)}</b></td><td class="num"><b>${fmt(sums.paid)}</b></td><td class="num">${balancePill(sums.balance)}</td></tr>`;
  html += `</tbody>`;
  table.innerHTML = html;
}

// =======================================================================
// PRINT INVOICES (A4)
// =======================================================================
function renderPrintView(){
  const monthSel = document.getElementById('printMonthSelect');
  const months = allSavedMonths().slice().reverse();
  monthSel.innerHTML = months.length ? months.map(m=>`<option value="${m}">${monthLabel(m)}</option>`).join('') : `<option value="">No months saved</option>`;

  const userSel = document.getElementById('printUserSelect');
  userSel.innerHTML = `<option value="__household_gas__">Gas Bill Household (all paid gas users)</option>` +
    `<option value="__household_motor__">Motor Bill Household (all motor users)</option>` +
    `<option value="__all__">All members (multi-page)</option>` +
    getUsers().map(u=>`<option value="${u.id}">${u.name}</option>`).join('');

  const getSelectedInvoiceIds = ()=>{
    const monthKey = monthSel.value;
    if(!monthKey){ return null; }
    const userChoice = userSel.value;
    if(userChoice === '__household_gas__'){
      return getUsers().filter(u => {
        const c = computeUserMonth(u.id, monthKey);
        return u.id !== 'angshu' && (c.gas > 0 || c.paid > 0);
      }).map(u => u.id);
    }
    if(userChoice === '__household_motor__'){
      return getUsers().filter(u => u.hasMotor && (computeUserMonth(u.id, monthKey).motorShare > 0 || computeUserMonth(u.id, monthKey).paid > 0)).map(u => u.id);
    }
    if(userChoice === '__all__'){
      const gasUsers = getUsers().filter(u => {
        const c = computeUserMonth(u.id, monthKey);
        return u.id !== 'angshu' && (c.gas > 0 || c.paid > 0);
      });
      const motorUsers = getUsers().filter(u => u.hasMotor && (computeUserMonth(u.id, monthKey).motorShare > 0 || computeUserMonth(u.id, monthKey).paid > 0));
      return ['__household_gas__', '__household_motor__', ...getUsers().map(u => u.id)];
    }
    return [userChoice];
  };

  document.getElementById('printGoBtn').onclick = ()=>{
    const monthKey = monthSel.value;
    if(!monthKey){ alert('No saved months to print yet.'); return; }
    const ids = getSelectedInvoiceIds();
    if(!ids || !ids.length){ alert('No invoice to print.'); return; }
    const wrap = document.getElementById('invoicePreviewWrap');
    wrap.className = 'invoice-container';

    if(userSel.value === '__household_gas__'){
      wrap.innerHTML = gasBillStatementHtml(monthKey, getUsers().filter(u => {
        const c = computeUserMonth(u.id, monthKey);
        return u.id !== 'angshu' && (c.gas > 0 || c.paid > 0);
      }));
    } else if(userSel.value === '__household_motor__'){
      wrap.innerHTML = motorBillStatementHtml(monthKey, getUsers().filter(u => u.hasMotor));
    } else if(userSel.value === '__all__'){
      const gasUsers = getUsers().filter(u => {
        const c = computeUserMonth(u.id, monthKey);
        return u.id !== 'angshu' && (c.gas > 0 || c.paid > 0);
      });
      const motorUsers = getUsers().filter(u => u.hasMotor && (computeUserMonth(u.id, monthKey).motorShare > 0 || computeUserMonth(u.id, monthKey).paid > 0));
      const sections = [];
      if(gasUsers.length) sections.push(gasBillStatementHtml(monthKey, gasUsers));
      if(motorUsers.length) sections.push(motorBillStatementHtml(monthKey, motorUsers));
      sections.push(...getUsers().filter(u => !u.isDeleted).map(u => invoiceHtml(u.id, monthKey)));
      wrap.innerHTML = sections.join('');
    } else {
      buildInvoices(monthKey, ids);
    }
    setTimeout(()=>window.print(), 200);
  };

  document.getElementById('downloadInvoicesBtn').onclick = ()=>{
    const monthKey = monthSel.value;
    if(!monthKey){ alert('No saved months to download yet.'); return; }
    const ids = getSelectedInvoiceIds();
    if(!ids || !ids.length){ alert('No invoice to download.'); return; }

    const selectedId = ids[0];
    const markup = invoiceHtml(selectedId, monthKey);
    const plainText = markup
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/?(div|p|tr|td|th|table|thead|tbody|h1|h2|h3|b|strong|span)\s*>/gi, '\n')
      .replace(/<\/?(div|p|tr|td|th|table|thead|tbody|h1|h2|h3|b|strong|span)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    const lines = plainText.split('\n').filter(line => line && line.trim().length > 0);
    let content = 'BT\n/F1 11 Tf\n50 800 Td\n';
    lines.forEach((line, index) => {
      const safe = line
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\r/g, '');
      const y = 800 - index * 16;
      if(y < 40) return;
      content += `1 0 0 1 50 ${y} Tm\n(${safe}) Tj\n`;
    });
    content += 'ET\n';

    const stream = content;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for(let i=1;i<offsets.length;i++){
      pdf += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    const blob = new Blob([pdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoice-${monthKey}-${selectedId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

function motorBillStatementHtml(monthKey, users){
  const motorUsers = users.filter(u => u.hasMotor);
  const rows = motorUsers.map(u => {
    const c = computeUserMonth(u.id, monthKey);
    const motorBill = c.motorShare;
    const bkashCharge = 0;
    const total = motorBill + bkashCharge;
    const paid = total;
    const balance = paid - total;
    return `<tr>
      <td>${u.name}</td>
      <td class="num">${fmt(motorBill)}</td>
      <td class="num">${fmt(bkashCharge)}</td>
      <td class="num">${fmt(total)}</td>
      <td class="num">${fmt(paid)}</td>
      <td class="num">${gasBalanceDisplay(balance)}</td>
    </tr>`;
  }).join('');

  const totals = motorUsers.reduce((sum, u) => {
    const c = computeUserMonth(u.id, monthKey);
    const motorBill = c.motorShare;
    const bkashCharge = 0;
    const total = motorBill + bkashCharge;
    const paid = total;
    const balance = paid - total;
    sum.motor += motorBill;
    sum.bkash += bkashCharge;
    sum.total += total;
    sum.paid += paid;
    sum.balance += balance;
    return sum;
  }, { motor:0, bkash:0, total:0, paid:0, balance:0 });

  return `
  <div class="invoice-sheet">
    <div class="inv-head">
      <div>
        <h2>Utility Bill Statement of Motor Bill</h2>
        <div class="inv-org">Household Utility Bill Statement</div>
      </div>
      <div class="inv-badge paid">Paid</div>
    </div>
    <div class="inv-meta">
      <div><span>User Names:</span> ${motorUsers.map(u => u.name).join(', ')}</div>
      <div><span>Billing Month:</span> ${monthLabel(monthKey)}</div>
      <div><span>Consumer ID:</span> 41771313</div>
      <div><span>Meter Number:</span> 10501785</div>
    </div>
    <table class="inv-table">
      <thead>
        <tr>
          <th>Users</th>
          <th class="num">Motor Bill</th>
          <th class="num">Bkash Charge</th>
          <th class="num">Total Bill</th>
          <th class="num">Paid</th>
          <th class="num">Balance (Due/Return)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="total">
          <td><b>Total:</b></td>
          <td class="num"><b>${fmt(totals.motor)}</b></td>
          <td class="num"><b>${fmt(totals.bkash)}</b></td>
          <td class="num"><b>${fmt(totals.total)}</b></td>
          <td class="num"><b>${fmt(totals.paid)}</b></td>
          <td class="num"><b>${gasBalanceDisplay(totals.balance)}</b></td>
        </tr>
      </tfoot>
    </table>
    <div class="inv-payment">
      <div><b>Date of Payment:</b> ${motorUsers[0] ? (STORE.records[monthKey]?.entries?.[motorUsers[0].id]?.paidDate || '—') : '—'}</div>
      <div><b>Bkash Transaction ID:</b> ${motorUsers[0] ? (STORE.records[monthKey]?.entries?.[motorUsers[0].id]?.gasTxnId || STORE.records[monthKey]?.entries?.[motorUsers[0].id]?.txnId || '—') : '—'}</div>
      <div><b>Status:</b> Paid</div>
    </div>
    <div class="inv-note">Note: This is a software-generated invoice. It has been prepared and approved by ${getPreparedByText()}. No physical signature is required.</div>
  </div>`;
}

function gasBillStatementHtml(monthKey, users){
  const rows = users.map(u => {
    const c = computeUserMonth(u.id, monthKey);
    const gasBikashCharge = (u.id === 'mamoni' || u.id === 'boumoni') ? 0 : c.bkash;
    const gasOnlyTotal = c.gas + gasBikashCharge;
    const gasOnlyPaid = gasOnlyTotal;
    const gasOnlyBalance = gasOnlyPaid - gasOnlyTotal;
    return `<tr>
      <td>${u.name}</td>
      <td class="num">${fmt(c.gas)}</td>
      <td class="num">${fmt(gasBikashCharge)}</td>
      <td class="num">${fmt(gasOnlyTotal)}</td>
      <td class="num">${fmt(gasOnlyPaid)}</td>
      <td class="num">${gasBalanceDisplay(gasOnlyBalance)}</td>
    </tr>`;
  }).join('');

  const totals = users.reduce((sum, u) => {
    const c = computeUserMonth(u.id, monthKey);
    const gasBikashCharge = (u.id === 'mamoni' || u.id === 'boumoni') ? 0 : c.bkash;
    const gasOnlyTotal = c.gas + gasBikashCharge;
    const gasOnlyPaid = gasOnlyTotal;
    const gasOnlyBalance = gasOnlyPaid - gasOnlyTotal;
    sum.gas += c.gas;
    sum.bkash += gasBikashCharge;
    sum.total += gasOnlyTotal;
    sum.paid += gasOnlyPaid;
    sum.balance += gasOnlyBalance;
    return sum;
  }, { gas:0, bkash:0, total:0, paid:0, balance:0 });

  return `
  <div class="invoice-sheet">
    <div class="inv-head">
      <div>
        <h2>Utility Bill Statement of Gas Bill</h2>
        <div class="inv-org">Household Utility Bill Statement</div>
      </div>
      <div class="inv-badge paid">Paid</div>
    </div>
    <div class="inv-meta">
      <div><span>User Names:</span> ${users.map(u => u.name).join(', ')}</div>
      <div><span>Billing Month:</span> ${monthLabel(monthKey)}</div>
      <div><span>Consumer ID:</span> 240101995</div>
    </div>
    <table class="inv-table">
      <thead>
        <tr>
          <th>Users</th>
          <th class="num">Gas Bill</th>
          <th class="num">Bkash Charge</th>
          <th class="num">Total Bill</th>
          <th class="num">Paid</th>
          <th class="num">Balance (Due/Return)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="total">
          <td><b>Total:</b></td>
          <td class="num"><b>${fmt(totals.gas)}</b></td>
          <td class="num"><b>${fmt(totals.bkash)}</b></td>
          <td class="num"><b>${fmt(totals.total)}</b></td>
          <td class="num"><b>${fmt(totals.paid)}</b></td>
          <td class="num"><b>${gasBalanceDisplay(totals.balance)}</b></td>
        </tr>
      </tfoot>
    </table>
    <div class="inv-payment">
      <div><b>Date of Payment:</b> ${users[0] ? (STORE.records[monthKey]?.entries?.[users[0].id]?.paidDate || '—') : '—'}</div>
      <div><b>Bkash Transaction ID:</b> ${users[0] ? (STORE.records[monthKey]?.entries?.[users[0].id]?.gasTxnId || STORE.records[monthKey]?.entries?.[users[0].id]?.txnId || '—') : '—'}</div>
      <div><b>Status:</b> Paid</div>
    </div>
    <div class="inv-note">Note: This is a software-generated invoice. It has been prepared and approved by ${getPreparedByText()}. No physical signature is required.</div>
  </div>`;
}

function gasInvoiceHtml(userId, monthKey){
  const user = getUser(userId);
  const c = computeUserMonth(userId, monthKey);
  const savedEntry = (STORE.records[monthKey]?.entries?.[userId]) || {};
  const currentRow = document.querySelector(`#entryTable tbody tr[data-user="${userId}"]`);
  const paidDate = (currentRow?.querySelector('.f-paiddate')?.value || savedEntry.paidDate || c.paidDate || '—');
  const gasTxnId = (currentRow?.querySelector('.f-gas-txn')?.value || savedEntry.gasTxnId || c.gasTxnId || '—');
  const gasBikashCharge = (userId === 'mamoni' || userId === 'boumoni') ? 0 : c.bkash;
  const gasOnlyTotal = c.gas + gasBikashCharge;
  const gasOnlyPaid = gasOnlyTotal;
  const gasOnlyBalance = gasOnlyPaid - gasOnlyTotal;
  const status = gasOnlyPaid > 0 ? 'Paid' : 'Unpaid';

  return `
  <div class="invoice-sheet">
    <div class="inv-head">
      <div>
        <h2>Utility Bill Statement of Gas Bill</h2>
        <div class="inv-org">Household Utility Bill Statement</div>
      </div>
      <div class="inv-badge ${Number(c.paid || 0) > 0 ? 'paid' : 'due'}">${status}</div>
    </div>
    <div class="inv-meta">
      <div><span>User Name:</span> ${user.name}</div>
      <div><span>Billing Month:</span> ${monthLabel(monthKey)}</div>
      <div><span>Consumer ID:</span> ${user.consumerId}</div>
      <div><span>Meter Number:</span> ${user.meter}</div>
    </div>
    <table class="inv-table">
      <thead><tr><th>Users</th><th class="num">Gas Bill</th><th class="num">Bkash Charge</th><th class="num">Total Bill</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
      <tbody>
        <tr>
          <td>${user.name}</td>
          <td class="num">${fmt(c.gas)}</td>
          <td class="num">${fmt(gasBikashCharge)}</td>
          <td class="num">${fmt(gasOnlyTotal)}</td>
          <td class="num">${fmt(gasOnlyPaid)}</td>
          <td class="num">${gasBalanceDisplay(gasOnlyBalance)}</td>
        </tr>
      </tbody>
    </table>
    <div class="inv-payment">
      <div><b>Date of Payment:</b> ${paidDate}</div>
      <div><b>Bkash Transaction ID:</b> ${gasTxnId}</div>
      <div><b>Status:</b> ${status}</div>
    </div>
    <div class="inv-note">Note: This is a software-generated invoice. It has been prepared and approved by ${getPreparedByText()}. No physical signature is required.</div>
  </div>`;
}

function invoiceHtml(userId, monthKey){
  const user = getUser(userId);
  const c = computeUserMonth(userId, monthKey);
  const savedEntry = (STORE.records[monthKey]?.entries?.[userId]) || {};
  const currentRow = document.querySelector(`#entryTable tbody tr[data-user="${userId}"]`);
  const paidDate = (currentRow?.querySelector('.f-paiddate')?.value || savedEntry.paidDate || c.paidDate || '—');
  const gasTxnId = (currentRow?.querySelector('.f-gas-txn')?.value || savedEntry.gasTxnId || c.gasTxnId || '—');
  const electricityTxnId = (currentRow?.querySelector('.f-electricity-txn')?.value || savedEntry.electricityTxnId || c.electricityTxnId || '—');
  const motorTxnId = (currentRow?.querySelector('.f-motor-txn')?.value || savedEntry.motorTxnId || c.motorTxnId || '—');
  const status = Number(c.paid || 0) > 0 ? 'Paid' : 'Unpaid';

  return `
  <div class="invoice-sheet">
    <div class="inv-head">
      <div>
        <h2>Utility Bill Statement</h2>
        <div class="inv-org">Monthly Bill Summary</div>
      </div>
      <div class="inv-badge ${Number(c.paid || 0) > 0 ? 'paid' : 'due'}">${status}</div>
    </div>
    <div class="inv-meta">
      <div><span>User Name:</span> ${user.name}</div>
      <div><span>Billing Month:</span> ${monthLabel(monthKey)}</div>
      <div><span>Consumer ID:</span> ${user.consumerId}</div>
      <div><span>Meter Number:</span> ${user.meter}</div>
    </div>
    <table class="inv-table">
      <thead><tr><th>Bill Type</th><th class="num">Amount</th></tr></thead>
      <tbody>
        <tr><td>Gas Bill</td><td class="num">${fmt(c.gas)}</td></tr>
        <tr><td>Electricity Bill</td><td class="num">${user.hasElectric ? fmt(c.electricity) : '—'}</td></tr>
        <tr><td>Motor Bill</td><td class="num">${user.hasMotor ? fmt(c.motorShare) : '—'}</td></tr>
        <tr><td>Bkash Charge</td><td class="num">${fmt(c.bkash)}</td></tr>
        <tr><td>Total Bill</td><td class="num"><b>${fmt(c.total)}</b></td></tr>
        <tr><td>Paid</td><td class="num">${fmt(c.paid)}</td></tr>
        <tr><td>Balance</td><td class="num">${fmt(Math.abs(c.balance))}</td></tr>
      </tbody>
    </table>
    <div class="inv-payment">
      <div><b>Date of Payment:</b> ${paidDate}</div>
      <div><b>Gas Transaction ID:</b> ${gasTxnId}</div>
      <div><b>Electricity Transaction ID:</b> ${electricityTxnId}</div>
      <div><b>Motor Transaction ID:</b> ${motorTxnId}</div>
      <div><b>Status:</b> ${status}</div>
    </div>
    <div class="inv-note">Note: This is a software-generated invoice. It has been prepared and approved by ${getPreparedByText()}. No physical signature is required.</div>
  </div>`;
}

function buildInvoices(monthKey, ids){
  const wrap = document.getElementById('invoicePreviewWrap');
  wrap.className = 'invoice-container';
  wrap.innerHTML = ids.map(id=>invoiceHtml(id, monthKey)).join('');
}

// =======================================================================
// SETTINGS
// =======================================================================
function renderSettings(){
  const table = document.getElementById('settingsGasTable');
  let html = `<thead><tr><th>Member</th><th>Fixed Gas Charge (৳/month)</th></tr></thead><tbody>`;
  getUsers().forEach(u=>{
    html += `<tr data-user="${u.id}"><td>${u.name}</td><td class="num"><input type="number" min="0" class="f-gasfixed" value="${u.gasFixed}"></td></tr>`;
  });
  html += `</tbody>`;
  table.innerHTML = html;

  const memberTable = document.getElementById('settingsMemberTable');
  if(memberTable){
    let memberHtml = `<thead><tr><th>Member</th><th>Name</th></tr></thead><tbody>`;
    getUsers().forEach(u=>{
      memberHtml += `<tr data-user="${u.id}"><td>${u.name}</td><td><input type="text" class="member-name-input" value="${escapeHtml(u.name)}" style="width:100%; min-width:180px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:#fff;"></td></tr>`;
    });
    memberHtml += `</tbody>`;
    memberTable.innerHTML = memberHtml;
  }

  document.getElementById('saveGasFixedBtn').onclick = ()=>{
    document.querySelectorAll('#settingsGasTable tbody tr').forEach(tr=>{
      const uid = tr.dataset.user;
      const val = Number(tr.querySelector('.f-gasfixed').value||0);
      getUser(uid).gasFixed = val;
    });
    saveStore();
    alert('Fixed gas charges updated. This applies from now on — past saved months are unaffected.');
  };

  document.getElementById('saveMemberNamesBtn').onclick = ()=>{
    document.querySelectorAll('#settingsMemberTable tbody tr').forEach(tr=>{
      const uid = tr.dataset.user;
      const input = tr.querySelector('.member-name-input');
      const name = (input ? input.value : '').trim();
      if (name) {
        const user = getUser(uid);
        if (user) user.name = name;
      }
    });
    saveStore();
    renderUsers();
    renderDashboard();
    renderMemberDetail();
    alert('Member names updated.');
  };

  document.getElementById('changePinBtn').onclick = ()=>{
    const val = document.getElementById('newPinInput').value.trim();
    if(!/^\d{4}$/.test(val)){ alert('PIN must be exactly 4 digits.'); return; }
    STORE.pinHash = hashPin(val);
    saveStore();
    document.getElementById('newPinInput').value='';
    alert('PIN updated.');
  };

  const adminInput = document.getElementById('adminNamesInput');
  if(adminInput){
    adminInput.value = (STORE.adminNames || [PREPARED_BY]).join(', ');
  }

  document.getElementById('saveAdminNamesBtn').onclick = ()=>{
    const names = (document.getElementById('adminNamesInput').value || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    STORE.adminNames = names.length ? names : [PREPARED_BY];
    saveStore();
    alert('Admin/accountant names saved.');
  };

  document.getElementById('exportBtn').onclick = ()=>{
    const blob = new Blob([JSON.stringify(STORE, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `deybari-utility-backup-${currentMonthKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('importInput').onchange = (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const data = JSON.parse(reader.result);
        if(!data.users || !data.records){ throw new Error('Invalid backup file'); }
        STORE = data;
        saveStore();
        alert('Backup restored successfully.');
        showView('dashboard');
      }catch(err){
        alert('Could not read this backup file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
}

// ---------------------------------------------------------------------
initLogin();
