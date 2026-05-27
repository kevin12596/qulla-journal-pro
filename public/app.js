// ===== Qulla Journal Pro · app.js =====
// LocalStorage-backed trade journal with R-multiple analytics

const LS = {
  TRADES: 'qjp_trades',
  SETTINGS: 'qjp_settings',
};

const DEFAULTS = {
  account: 3000000,
  risk_pct: 1.0,
  max_pos_pct: 40,
  max_radr: 1.5,
};

let state = {
  trades: [],
  settings: { ...DEFAULTS },
  editingId: null,
};

// ===== Utils =====
const $ = (id) => document.getElementById(id);
const fmt = (n, d=0) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtR = (r) => r == null ? '—' : (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
const uuid = () => 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 2500);
}

// ===== Storage =====
function loadAll() {
  try {
    state.trades = JSON.parse(localStorage.getItem(LS.TRADES) || '[]');
    state.settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.SETTINGS) || '{}') };
  } catch (e) { console.error(e); }
}
function saveTrades() { localStorage.setItem(LS.TRADES, JSON.stringify(state.trades)); }
function saveSettings() { localStorage.setItem(LS.SETTINGS, JSON.stringify(state.settings)); }

// ===== Calculations =====
function calcR(entry, stop, side = 'LONG') {
  if (!entry || !stop) return null;
  return side === 'LONG' ? entry - stop : stop - entry;
}
function calcRMultiple(trade, currentPrice = null) {
  const r = calcR(trade.entry_price, trade.stop, trade.side);
  if (!r || r <= 0) return null;
  const exit = trade.status === 'CLOSED' ? trade.exit_price : currentPrice;
  if (!exit) return null;
  const move = trade.side === 'LONG' ? exit - trade.entry_price : trade.entry_price - exit;
  return move / r;
}
function calcPnL(trade) {
  if (trade.status !== 'CLOSED' || !trade.exit_price) return null;
  const dir = trade.side === 'LONG' ? 1 : -1;
  return (trade.exit_price - trade.entry_price) * trade.shares * dir;
}

// ===== Tab Navigation =====
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
      document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'v_' + v));
      if (v === 'dash') renderDashboard();
      if (v === 'active') renderActive();
      if (v === 'journal') renderJournalList();
    });
  });
}

// ===== Journal Form =====
function clearForm() {
  state.editingId = null;
  ['j_id','j_symbol','j_name','j_entry_price','j_shares','j_stop','j_day_high','j_day_low',
   'j_adr','j_exit_price','j_breakout','j_note'].forEach(id => $(id).value = '');
  $('j_market').value = 'TWSE';
  $('j_side').value = 'LONG';
  $('j_status').value = 'OPEN';
  $('j_exit_reason').value = '';
  $('j_setup').value = '';
  $('j_entry_date').value = today();
  $('j_exit_date').value = '';
  $('j_delete').style.display = 'none';
  updatePreview();
}

function readForm() {
  const t = {
    id: $('j_id').value || uuid(),
    symbol: $('j_symbol').value.trim(),
    name: $('j_name').value.trim(),
    market: $('j_market').value,
    side: $('j_side').value,
    entry_date: $('j_entry_date').value,
    entry_price: parseFloat($('j_entry_price').value) || null,
    shares: parseInt($('j_shares').value) || null,
    stop: parseFloat($('j_stop').value) || null,
    day_high: parseFloat($('j_day_high').value) || null,
    day_low: parseFloat($('j_day_low').value) || null,
    adr: parseFloat($('j_adr').value) || null,
    breakout: parseFloat($('j_breakout').value) || null,
    setup: $('j_setup').value,
    status: $('j_status').value,
    exit_date: $('j_exit_date').value || null,
    exit_price: parseFloat($('j_exit_price').value) || null,
    exit_reason: $('j_exit_reason').value || null,
    note: $('j_note').value.trim(),
    created_at: state.editingId ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return t;
}

function fillForm(t) {
  state.editingId = t.id;
  $('j_id').value = t.id;
  $('j_symbol').value = t.symbol || '';
  $('j_name').value = t.name || '';
  $('j_market').value = t.market || 'TWSE';
  $('j_side').value = t.side || 'LONG';
  $('j_entry_date').value = t.entry_date || '';
  $('j_entry_price').value = t.entry_price ?? '';
  $('j_shares').value = t.shares ?? '';
  $('j_stop').value = t.stop ?? '';
  $('j_day_high').value = t.day_high ?? '';
  $('j_day_low').value = t.day_low ?? '';
  $('j_adr').value = t.adr ?? '';
  $('j_breakout').value = t.breakout ?? '';
  $('j_setup').value = t.setup || '';
  $('j_status').value = t.status || 'OPEN';
  $('j_exit_date').value = t.exit_date || '';
  $('j_exit_price').value = t.exit_price ?? '';
  $('j_exit_reason').value = t.exit_reason || '';
  $('j_note').value = t.note || '';
  $('j_delete').style.display = 'inline-block';
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updatePreview() {
  const entry = parseFloat($('j_entry_price').value) || 0;
  const stop = parseFloat($('j_stop').value) || 0;
  const shares = parseInt($('j_shares').value) || 0;
  const adr = parseFloat($('j_adr').value) || 0;
  const exit = parseFloat($('j_exit_price').value) || 0;
  const side = $('j_side').value;
  const r = calcR(entry, stop, side);
  if (r && r > 0) {
    $('j_r').textContent = r.toFixed(2);
    $('j_rpct').textContent = (r/entry*100).toFixed(1) + '%';
    $('j_radr').textContent = adr ? (r/entry*100/adr).toFixed(2) + '×' : '—';
    $('j_invest').textContent = fmt(entry * shares);
    $('j_risk').textContent = fmt(r * shares);
    $('j_2r').textContent = (entry + 2*r * (side==='LONG'?1:-1)).toFixed(2);
    $('j_3r').textContent = (entry + 3*r * (side==='LONG'?1:-1)).toFixed(2);
    if (exit) {
      const move = side==='LONG' ? exit - entry : entry - exit;
      const rm = move / r;
      $('j_rmult').textContent = fmtR(rm);
      $('j_rmult').className = 'mono big ' + (rm >= 0 ? 'pos' : 'neg');
    } else {
      $('j_rmult').textContent = '—';
      $('j_rmult').className = 'mono big';
    }
  } else {
    ['j_r','j_rpct','j_radr','j_invest','j_risk','j_2r','j_3r','j_rmult'].forEach(id => $(id).textContent = '—');
  }
}

// ===== Journal List =====
function renderJournalList() {
  const list = $('j_list');
  const fStatus = $('f_status').value;
  const fSearch = ($('f_search').value || '').toLowerCase();

  let trades = [...state.trades]
    .filter(t => !fStatus || t.status === fStatus)
    .filter(t => !fSearch || (t.symbol+t.name).toLowerCase().includes(fSearch))
    .sort((a,b) => (b.entry_date || '').localeCompare(a.entry_date || ''));

  if (trades.length === 0) {
    list.innerHTML = '<div class="hint" style="text-align:center;padding:40px">沒有交易紀錄。從上方表單新增第一筆。</div>';
    return;
  }

  list.innerHTML = trades.map(t => {
    const rm = calcRMultiple(t);
    const pnl = calcPnL(t);
    const r = calcR(t.entry_price, t.stop, t.side);
    return `<div class="trade" data-id="${t.id}">
      <div>
        <div class="sym">${t.symbol}</div>
        <div class="name">${t.name||''}</div>
      </div>
      <div>
        <div>${t.entry_date||''} ${t.side==='SHORT'?'🔻':'🔺'} @${fmt(t.entry_price,2)} × ${fmt(t.shares)}</div>
        <div class="meta">止損 ${fmt(t.stop,2)}｜R=${r?r.toFixed(2):'—'}｜${t.setup||'—'}${t.exit_reason?' · '+t.exit_reason:''}</div>
      </div>
      <div class="status-tag ${t.status}">${t.status==='OPEN'?'持有':'平倉'}</div>
      <div class="pnl ${pnl>=0?'pos':'neg'}">${pnl!=null?(pnl>=0?'+':'')+fmt(pnl,0):''}</div>
      <div class="rmult ${rm>=0?'pos':'neg'}">${rm!=null?fmtR(rm):'—'}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.trade').forEach(el => {
    el.addEventListener('click', () => {
      const t = state.trades.find(x => x.id === el.dataset.id);
      if (t) fillForm(t);
    });
  });
}

// ===== Calc Tab =====
function updateCalc() {
  const entry = parseFloat($('c_entry').value) || 0;
  const stop = parseFloat($('c_stop').value) || 0;
  const adr = parseFloat($('c_adr').value) || 0;
  const r = entry - stop;
  const account = state.settings.account;
  const riskPct = state.settings.risk_pct / 100;
  const maxPosPct = state.settings.max_pos_pct / 100;
  const maxRadr = state.settings.max_radr;

  if (!entry || !stop || r <= 0) {
    ['c_r','c_rpct','c_radr','c_shares','c_invest','c_account_pct','c_2r','c_3r'].forEach(id => $(id).textContent = '—');
    $('c_verdict').textContent = '輸入進場與止損價';
    $('c_verdict').className = 'verdict';
    return;
  }

  const rpct = r/entry*100;
  const radr = adr ? rpct/adr : null;
  const riskBudget = account * riskPct;
  let shares = Math.floor(riskBudget / r / 1000) * 1000;  // 整張化
  let invest = shares * entry;
  // 部位上限約束
  if (invest > account * maxPosPct) {
    shares = Math.floor(account * maxPosPct / entry / 1000) * 1000;
    invest = shares * entry;
  }
  const accountPct = invest/account*100;

  $('c_r').textContent = r.toFixed(2);
  $('c_rpct').textContent = rpct.toFixed(2)+'%';
  $('c_radr').textContent = radr ? radr.toFixed(2)+'×' : '—';
  $('c_shares').textContent = fmt(shares);
  $('c_invest').textContent = fmt(invest);
  $('c_account_pct').textContent = accountPct.toFixed(1)+'%';
  $('c_2r').textContent = (entry + 2*r).toFixed(2);
  $('c_3r').textContent = (entry + 3*r).toFixed(2);

  // Verdict
  let verdict = '', cls = 'ok';
  if (radr && radr > maxRadr) {
    verdict = `⚠️ R/ADR=${radr.toFixed(2)}× 超過 ${maxRadr}×，這檔波動太大不適合，跳過`;
    cls = 'bad';
  } else if (radr && radr < 0.5) {
    verdict = `🟡 R/ADR=${radr.toFixed(2)}× 偏緊，容易被洗盤打到`;
    cls = 'warn';
  } else if (radr && radr >= 0.7 && radr <= 1.0) {
    verdict = `✅ R/ADR=${radr.toFixed(2)}× 黃金比例！可以打`;
    cls = 'ok';
  } else {
    verdict = `可進場：投入 ${fmt(invest)} TWD（占帳戶 ${accountPct.toFixed(1)}%），風險 ${fmt(r*shares)} TWD`;
    cls = 'ok';
  }
  $('c_verdict').textContent = verdict;
  $('c_verdict').className = 'verdict ' + cls;
}

// ===== Dashboard =====
function renderDashboard() {
  const closed = state.trades.filter(t => t.status === 'CLOSED');
  const $ndN = (id, v) => $(id).textContent = v;

  if (closed.length === 0) {
    ['d_exp','d_winrate','d_avg_win','d_avg_loss','d_total_r','d_total_pnl','d_max_win','d_max_loss','d_best','d_worst'].forEach(id => $ndN(id,'—'));
    $ndN('d_total', 0);
    $('d_histogram').innerHTML = '<div class="hint">尚無平倉資料</div>';
    $('d_exit_stats').innerHTML = '';
    $('d_monthly').innerHTML = '';
    return;
  }

  const rms = closed.map(t => calcRMultiple(t)).filter(x => x != null);
  const wins = rms.filter(x => x > 0);
  const losses = rms.filter(x => x <= 0);
  const winrate = wins.length / rms.length * 100;
  const avgWin = wins.length ? wins.reduce((a,b)=>a+b,0)/wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,b)=>a+b,0)/losses.length : 0;
  const totalR = rms.reduce((a,b)=>a+b,0);
  const totalPnl = closed.map(calcPnL).filter(x=>x!=null).reduce((a,b)=>a+b,0);
  const expectancy = (winrate/100)*avgWin + (1-winrate/100)*avgLoss;
  const best = Math.max(...rms);
  const worst = Math.min(...rms);

  // 連勝/連敗
  let cw=0, cl=0, mw=0, ml=0;
  rms.forEach(r => {
    if (r > 0) { cw++; cl=0; mw = Math.max(mw, cw); }
    else { cl++; cw=0; ml = Math.max(ml, cl); }
  });

  $ndN('d_exp', fmtR(expectancy));
  $ndN('d_total', closed.length);
  $ndN('d_winrate', winrate.toFixed(1)+'%');
  $ndN('d_avg_win', fmtR(avgWin));
  $ndN('d_avg_loss', fmtR(avgLoss));
  $ndN('d_total_r', fmtR(totalR));
  $ndN('d_total_pnl', (totalPnl>=0?'+':'')+fmt(totalPnl));
  $ndN('d_max_win', mw);
  $ndN('d_max_loss', ml);
  $ndN('d_best', fmtR(best));
  $ndN('d_worst', fmtR(worst));

  // Histogram (R buckets)
  const buckets = { '<-2R':0, '-2~-1R':0, '-1~0R':0, '0~+1R':0, '+1~+2R':0, '+2~+3R':0, '+3~+5R':0, '>+5R':0 };
  rms.forEach(r => {
    if (r < -2) buckets['<-2R']++;
    else if (r < -1) buckets['-2~-1R']++;
    else if (r < 0) buckets['-1~0R']++;
    else if (r < 1) buckets['0~+1R']++;
    else if (r < 2) buckets['+1~+2R']++;
    else if (r < 3) buckets['+2~+3R']++;
    else if (r < 5) buckets['+3~+5R']++;
    else buckets['>+5R']++;
  });
  const max = Math.max(...Object.values(buckets), 1);
  $('d_histogram').innerHTML = Object.entries(buckets).map(([k,v]) => {
    const h = v/max*100;
    const cls = k.startsWith('-') || k.startsWith('<') ? 'neg' : 'pos';
    return `<div class="hist-bar ${cls}" style="height:${h}%"><span class="count">${v}</span><span class="label">${k}</span></div>`;
  }).join('');

  // Exit reason stats
  const reasons = {};
  closed.forEach(t => {
    const r = t.exit_reason || 'OTHER';
    if (!reasons[r]) reasons[r] = { count: 0, totalR: 0 };
    reasons[r].count++;
    const rm = calcRMultiple(t);
    if (rm != null) reasons[r].totalR += rm;
  });
  $('d_exit_stats').innerHTML = Object.entries(reasons).map(([k,v]) => {
    const avg = v.totalR / v.count;
    return `<div style="display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid var(--border)">
      <span>${k}</span><span>${v.count} 筆｜平均 ${fmtR(avg)}</span></div>`;
  }).join('');

  // Monthly
  const months = {};
  closed.forEach(t => {
    if (!t.exit_date) return;
    const m = t.exit_date.slice(0,7);
    if (!months[m]) months[m] = { count: 0, totalR: 0, pnl: 0 };
    months[m].count++;
    const rm = calcRMultiple(t);
    if (rm != null) months[m].totalR += rm;
    const p = calcPnL(t);
    if (p != null) months[m].pnl += p;
  });
  $('d_monthly').innerHTML = Object.entries(months).sort().reverse().map(([m,v]) =>
    `<div style="display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid var(--border)">
      <span>${m}</span><span>${v.count}筆｜${fmtR(v.totalR)}｜${(v.pnl>=0?'+':'')+fmt(v.pnl)} TWD</span></div>`
  ).join('');
}

// ===== Active =====
function renderActive() {
  const open = state.trades.filter(t => t.status === 'OPEN');
  if (open.length === 0) {
    $('active_list').innerHTML = '<div class="hint">沒有持有中的部位。</div>';
    return;
  }
  $('active_list').innerHTML = open.map(t => {
    const r = calcR(t.entry_price, t.stop, t.side);
    const r2 = t.entry_price + 2*r;
    const r3 = t.entry_price + 3*r;
    return `<div class="trade" style="grid-template-columns:80px 1fr;padding:14px">
      <div><div class="sym">${t.symbol}</div><div class="name">${t.name||''}</div></div>
      <div>
        <div>進場 ${fmt(t.entry_price,2)} × ${fmt(t.shares)} 股｜止損 ${fmt(t.stop,2)}（R=${r?r.toFixed(2):'—'}）</div>
        <div class="meta">2R 目標 ${r2.toFixed(2)}｜3R 目標 ${r3.toFixed(2)}｜${t.setup||''}</div>
      </div>
    </div>`;
  }).join('');
}

// ===== Settings =====
function loadSettingsToForm() {
  $('s_account').value = state.settings.account;
  $('s_risk_pct').value = state.settings.risk_pct;
  $('s_max_pos_pct').value = state.settings.max_pos_pct;
  $('s_max_radr').value = state.settings.max_radr;
}
function saveSettingsFromForm() {
  state.settings = {
    account: parseFloat($('s_account').value) || DEFAULTS.account,
    risk_pct: parseFloat($('s_risk_pct').value) || DEFAULTS.risk_pct,
    max_pos_pct: parseFloat($('s_max_pos_pct').value) || DEFAULTS.max_pos_pct,
    max_radr: parseFloat($('s_max_radr').value) || DEFAULTS.max_radr,
  };
  saveSettings();
  toast('設定已儲存');
  updateHeader();
}

// ===== Header =====
function updateHeader() {
  $('hdr_account').textContent = fmt(state.settings.account);
  const closed = state.trades.filter(t => t.status === 'CLOSED');
  if (closed.length === 0) {
    $('hdr_total_r').textContent = '—';
    $('hdr_winrate').textContent = '—';
    return;
  }
  const rms = closed.map(t => calcRMultiple(t)).filter(x => x != null);
  const totalR = rms.reduce((a,b)=>a+b,0);
  const winrate = rms.filter(x => x > 0).length / rms.length * 100;
  $('hdr_total_r').textContent = fmtR(totalR);
  $('hdr_total_r').className = 'mono ' + (totalR >= 0 ? 'pos' : 'neg');
  $('hdr_winrate').textContent = winrate.toFixed(0) + '%';
}

// ===== Init =====
function init() {
  loadAll();
  setupTabs();
  loadSettingsToForm();
  clearForm();
  renderJournalList();
  updateHeader();

  // Form events
  ['j_entry_price','j_stop','j_shares','j_adr','j_exit_price','j_side'].forEach(id =>
    $(id).addEventListener('input', updatePreview));

  $('j_save').addEventListener('click', () => {
    const t = readForm();
    if (!t.symbol || !t.entry_price || !t.shares || !t.stop) {
      toast('請填股票代碼、進場價、股數、止損', 'err'); return;
    }
    const idx = state.trades.findIndex(x => x.id === t.id);
    if (idx >= 0) state.trades[idx] = { ...state.trades[idx], ...t };
    else state.trades.push(t);
    saveTrades();
    toast(idx >= 0 ? '已更新' : '已新增');
    clearForm();
    renderJournalList();
    updateHeader();
  });

  $('j_delete').addEventListener('click', () => {
    if (!state.editingId) return;
    if (!confirm('刪除這筆交易？')) return;
    state.trades = state.trades.filter(t => t.id !== state.editingId);
    saveTrades();
    clearForm();
    renderJournalList();
    updateHeader();
    toast('已刪除');
  });

  $('j_clear').addEventListener('click', clearForm);
  $('f_status').addEventListener('change', renderJournalList);
  $('f_search').addEventListener('input', renderJournalList);

  // Calc tab events
  ['c_entry','c_stop','c_adr'].forEach(id => $(id).addEventListener('input', updateCalc));

  // Settings
  $('s_save').addEventListener('click', saveSettingsFromForm);

  // Export/Import
  $('export_csv').addEventListener('click', exportCSV);
  $('export_json').addEventListener('click', exportJSON);
  $('import_json').addEventListener('click', () => $('import_file').click());
  $('import_file').addEventListener('change', importJSON);
  $('reset_all').addEventListener('click', () => {
    if (!confirm('真的要清空所有交易和設定？無法復原！')) return;
    localStorage.removeItem(LS.TRADES);
    localStorage.removeItem(LS.SETTINGS);
    location.reload();
  });
}

function exportCSV() {
  const headers = ['symbol','name','market','side','entry_date','entry_price','shares','stop','exit_date','exit_price','exit_reason','setup','status','r_per_share','r_multiple','pnl','note'];
  const rows = [headers.join(',')];
  state.trades.forEach(t => {
    const r = calcR(t.entry_price, t.stop, t.side);
    const rm = calcRMultiple(t);
    const pnl = calcPnL(t);
    rows.push([t.symbol, t.name, t.market, t.side, t.entry_date, t.entry_price, t.shares, t.stop, t.exit_date||'', t.exit_price||'', t.exit_reason||'', t.setup||'', t.status, r?.toFixed(2)||'', rm?.toFixed(2)||'', pnl||'', '"'+(t.note||'').replace(/"/g,'""')+'"'].join(','));
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `qjp-trades-${today()}.csv`;
  a.click();
}

function exportJSON() {
  const data = { trades: state.trades, settings: state.settings, exported_at: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `qjp-backup-${today()}.json`;
  a.click();
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.trades) state.trades = data.trades;
      if (data.settings) state.settings = { ...DEFAULTS, ...data.settings };
      saveTrades();
      saveSettings();
      loadSettingsToForm();
      renderJournalList();
      updateHeader();
      toast(`匯入 ${data.trades?.length || 0} 筆交易`);
    } catch (err) { toast('匯入失敗：' + err.message, 'err'); }
  };
  reader.readAsText(file);
}

document.addEventListener('DOMContentLoaded', init);

// ===== API Integration =====
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:18792/api'
  : '/qjp-api';  // Apache proxy 路徑

async function apiAnalyze(symbol) {
  const r = await fetch(`${API_BASE}/analyze/${symbol}`);
  if (!r.ok) throw new Error('API 錯誤');
  return r.json();
}

async function fetchJournalData() {
  const sym = $('j_symbol').value.trim();
  if (!sym) { toast('請先填股票代碼', 'err'); return; }
  toast('🔄 抓取中...', 'ok');
  try {
    const d = await apiAnalyze(sym);
    if (!$('j_entry_price').value) $('j_entry_price').value = d.close;
    $('j_day_high').value = d.high;
    $('j_day_low').value = d.low;
    $('j_adr').value = d.adr_pct || '';
    if (!$('j_stop').value && d.low) $('j_stop').value = d.low;
    if (!$('j_entry_date').value) $('j_entry_date').value = today();
    updatePreview();
    let msg = `✅ ${sym} ${d.close} | ADR ${d.adr_pct}% | EMA10=${d.ema10}`;
    if (d.warnings.length) msg += ' ⚠️ ' + d.warnings[0];
    toast(msg);
  } catch (e) { toast('抓取失敗：' + e.message, 'err'); }
}

async function fetchCalcData() {
  const sym = $('c_symbol').value.trim();
  if (!sym) { toast('請先填股票代碼', 'err'); return; }
  toast('🔄 抓取中...', 'ok');
  try {
    const d = await apiAnalyze(sym);
    $('c_entry').value = d.close;
    $('c_stop').value = d.low || (d.ema10 * 0.99).toFixed(2);
    $('c_adr').value = d.adr_pct || '';
    updateCalc();
    toast(`✅ ${sym} 收盤 ${d.close} | ADR ${d.adr_pct}%`);
  } catch (e) { toast('抓取失敗：' + e.message, 'err'); }
}

// ===== OCR 對帳單匯入 =====
function importFromOCR() {
  const txt = $('ocr_input').value.trim();
  if (!txt) { toast('請先貼上資料', 'err'); return; }
  let data;
  try {
    data = JSON.parse(txt);
    if (!Array.isArray(data)) data = [data];
  } catch (e) { toast('JSON 格式錯誤', 'err'); return; }

  // 按 symbol 合併
  const groups = {};
  data.forEach(row => {
    const key = row.symbol;
    if (!groups[key]) groups[key] = { rows: [], name: row.name, market: row.market || 'TWSE', side: row.side || 'LONG', entry_date: row.entry_date };
    groups[key].rows.push(row);
  });

  let added = 0;
  Object.entries(groups).forEach(([sym, g]) => {
    const totalShares = g.rows.reduce((a,r) => a + (r.shares || 0), 0);
    const totalCost = g.rows.reduce((a,r) => a + (r.entry_price * r.shares || 0), 0);
    const avgPrice = totalCost / totalShares;
    const t = {
      id: uuid(),
      symbol: sym,
      name: g.name || '',
      market: g.market,
      side: g.side,
      entry_date: g.entry_date || today(),
      entry_price: parseFloat(avgPrice.toFixed(2)),
      shares: totalShares,
      stop: null,
      status: 'OPEN',
      setup: 'BREAKOUT',
      note: `OCR 匯入：${g.rows.length} 筆合併｜原始 ${g.rows.map(r=>`${r.entry_price}×${r.shares}`).join(' + ')}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    state.trades.push(t);
    added++;
  });

  saveTrades();
  $('ocr_input').value = '';
  renderJournalList();
  updateHeader();
  toast(`✅ 匯入 ${added} 檔，請補上止損價`);
}

// ===== 補綁定（init 後執行）=====
window.addEventListener('load', () => {
  setTimeout(() => {
    const fb = $('j_fetch'); if (fb) fb.addEventListener('click', fetchJournalData);
    const cb = $('c_fetch'); if (cb) cb.addEventListener('click', fetchCalcData);
    const oi = $('ocr_import'); if (oi) oi.addEventListener('click', importFromOCR);
    const oc = $('ocr_clear'); if (oc) oc.addEventListener('click', () => $('ocr_input').value = '');
  }, 200);
});
