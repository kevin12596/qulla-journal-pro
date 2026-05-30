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

// ===== Storage (LocalStorage + D1 cloud sync) =====
const CLOUD = {
  base: '/api/journal',
  user: 'kc',
  // 從 localStorage 讀，使用者第一次用：在 console 跑 localStorage.setItem('qjp_auth','xxxx')
  authKey: () => localStorage.getItem('qjp_auth') || '',
  enabled: true, // 設 false 可暫時退回純本地模式
};

async function cloudFetch(path, opts = {}) {
  if (!CLOUD.enabled) throw new Error('cloud disabled');
  const url = `${CLOUD.base}${path}${path.includes('?') ? '&' : '?'}user=${CLOUD.user}`;
  const headers = { 'Content-Type': 'application/json', 'X-Auth-Key': CLOUD.authKey(), ...(opts.headers||{}) };
  const r = await fetch(url, { ...opts, headers });
  if (!r.ok) throw new Error(`cloud ${r.status}`);
  return r.json();
}

function loadLocal() {
  try {
    state.trades = JSON.parse(localStorage.getItem(LS.TRADES) || '[]');
    state.settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.SETTINGS) || '{}') };
  } catch (e) { console.error(e); }
}

function loadAll() { loadLocal(); }

// 啟動後在背景做雲端拉取（覆蓋本地，以雲端為準）
async function cloudPull() {
  try {
    const data = await cloudFetch('/all');
    if (data && Array.isArray(data.trades)) {
      state.trades = data.trades;
      localStorage.setItem(LS.TRADES, JSON.stringify(state.trades));
    }
    if (data && data.settings) {
      state.settings = { ...DEFAULTS, ...data.settings };
      localStorage.setItem(LS.SETTINGS, JSON.stringify(state.settings));
    }
    if (typeof renderJournalList === 'function') renderJournalList();
    if (typeof updateHeader === 'function') updateHeader();
    toast('☁️ 已從雲端同步');
  } catch (e) {
    console.warn('cloudPull failed:', e.message);
    toast('雲端同步失敗，使用本地資料', 'warn');
  }
}

function saveTrades() {
  localStorage.setItem(LS.TRADES, JSON.stringify(state.trades));
  // 雲端：以 bulk replace 簡化（資料量小，每次幾百筆內 OK）
  if (CLOUD.enabled) {
    cloudFetch('/trades-bulk', { method: 'POST', body: JSON.stringify(state.trades) })
      .catch(e => console.warn('cloud saveTrades:', e.message));
  }
}
function saveSettings() {
  localStorage.setItem(LS.SETTINGS, JSON.stringify(state.settings));
  if (CLOUD.enabled) {
    cloudFetch('/settings', { method: 'PUT', body: JSON.stringify(state.settings) })
      .catch(e => console.warn('cloud saveSettings:', e.message));
  }
}

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
// 計算分批出場的加權平均 R 倍數與已出場股數
function calcExitsStats(trade) {
  const exits = Array.isArray(trade.exits) ? trade.exits : [];
  const r = calcR(trade.entry_price, trade.stop, trade.side);
  let totalShares = 0, weighted = 0, hasR = false;
  for (const e of exits) {
    const s = parseInt(e.shares) || 0;
    if (s <= 0) continue;
    totalShares += s;
    if (r && r > 0 && e.price) {
      const move = trade.side === 'SHORT' ? trade.entry_price - e.price : e.price - trade.entry_price;
      weighted += s * (move / r);
      hasR = true;
    }
  }
  return {
    count: exits.length,
    exitedShares: totalShares,
    avgR: (hasR && totalShares > 0) ? (weighted / totalShares) : null,
    remaining: (trade.shares || 0) - totalShares,
  };
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
  renderExitsTable([]);
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
    exits: collectExits(),
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
  renderExitsTable(Array.isArray(t.exits) ? t.exits : []);
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== 分批出場 UI =====
const EXIT_REASONS = [
  ['', '—'], ['STOP', '觸發止損'], ['2R', '達 2R 減倉'], ['3R', '達 3R 減倉'],
  ['EMA10', '跌破 EMA10'], ['EMA20', '跌破 EMA20'],
  ['FAILED_BREAKOUT', '假突破當日出'], ['DISCRETION', '主觀判斷'], ['OTHER', '其他'],
];

function renderExitsTable(exits) {
  const body = $('j_exits_body');
  if (!body) return;
  body.innerHTML = '';
  (exits || []).forEach(e => addExitRow(e));
  toggleExitsEmpty();
}

function addExitRow(data = {}) {
  const body = $('j_exits_body');
  if (!body) return;
  const tr = document.createElement('tr');
  const reasonOptions = EXIT_REASONS.map(([v, t]) =>
    `<option value="${v}"${(data.reason || '') === v ? ' selected' : ''}>${t}</option>`).join('');
  tr.innerHTML = `
    <td><input type="date" class="x-date" value="${data.date || today()}"></td>
    <td><input type="number" step="1" class="x-shares" value="${data.shares ?? ''}"></td>
    <td><input type="number" step="0.01" class="x-price" value="${data.price ?? ''}"></td>
    <td><select class="x-reason">${reasonOptions}</select></td>
    <td class="rmult-cell" data-rmult>—</td>
    <td><button type="button" class="btn-x" title="刪除">×</button></td>
  `;
  tr.querySelector('.btn-x').addEventListener('click', () => {
    tr.remove();
    toggleExitsEmpty();
    updatePreview();
  });
  tr.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', updatePreview);
    el.addEventListener('change', updatePreview);
  });
  body.appendChild(tr);
  toggleExitsEmpty();
}

function toggleExitsEmpty() {
  const body = $('j_exits_body');
  const empty = $('j_exits_empty');
  if (!body || !empty) return;
  empty.style.display = body.children.length === 0 ? 'block' : 'none';
}

function collectExits() {
  const rows = document.querySelectorAll('#j_exits_body tr');
  const out = [];
  rows.forEach(tr => {
    const date = tr.querySelector('.x-date')?.value || '';
    const shares = parseInt(tr.querySelector('.x-shares')?.value) || 0;
    const price = parseFloat(tr.querySelector('.x-price')?.value) || 0;
    const reason = tr.querySelector('.x-reason')?.value || '';
    if (shares > 0 && price > 0) out.push({ date, shares, price, reason });
  });
  return out;
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
  // 分批出場 — 同步表格個別 R 倍數 + 總計
  let totalShares = 0, weighted = 0, hasR = false;
  document.querySelectorAll('#j_exits_body tr').forEach(tr => {
    const s = parseInt(tr.querySelector('.x-shares')?.value) || 0;
    const p = parseFloat(tr.querySelector('.x-price')?.value) || 0;
    const cell = tr.querySelector('[data-rmult]');
    if (cell) {
      cell.textContent = '—';
      cell.classList.remove('pos','neg');
    }
    if (s > 0) totalShares += s;
    if (s > 0 && p > 0 && r && r > 0 && entry > 0) {
      const move = side === 'SHORT' ? entry - p : p - entry;
      const rm = move / r;
      weighted += s * rm;
      hasR = true;
      if (cell) {
        cell.textContent = fmtR(rm);
        cell.classList.add(rm >= 0 ? 'pos' : 'neg');
      }
    }
  });
  const rEl = $('j_realized_r');
  const remEl = $('j_exited_remaining');
  if (rEl) {
    if (hasR && totalShares > 0) {
      const avg = weighted / totalShares;
      rEl.textContent = fmtR(avg);
      rEl.className = 'mono big ' + (avg >= 0 ? 'pos' : 'neg');
    } else {
      rEl.textContent = '—';
      rEl.className = 'mono big';
    }
  }
  if (remEl) {
    if (totalShares > 0 || shares > 0) {
      const remain = (shares || 0) - totalShares;
      remEl.textContent = `${fmt(totalShares)} / ${fmt(remain)}`;
    } else {
      remEl.textContent = '—';
    }
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
    const ex = calcExitsStats(t);
    const exitBadge = ex.count > 0
      ? `· ⚡ 已分批 ${ex.count} 筆${ex.avgR != null ? ` / 平均 ${fmtR(ex.avgR)}` : ''}${ex.remaining > 0 ? ` / 剩 ${fmt(ex.remaining)}股` : ''}`
      : '';
    return `<div class="trade" data-id="${t.id}">
      <div>
        <div class="sym">${t.symbol}</div>
        <div class="name">${t.name||''}</div>
      </div>
      <div>
        <div>${t.entry_date||''} ${t.side==='SHORT'?'🔻':'🔺'} @${fmt(t.entry_price,2)} × ${fmt(t.shares)}</div>
        <div class="meta">止損 ${fmt(t.stop,2)}｜R=${r?r.toFixed(2):'—'}｜${t.setup||'—'}${t.exit_reason?' · '+t.exit_reason:''}${exitBadge}</div>
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
  const rawShares = riskBudget / r;  // 未整張化股數
  let shares = Math.floor(rawShares / 1000) * 1000;  // 整張化
  let lots = shares / 1000;
  let useFractional = false;
  // 不足一張 → fallback 零股（台股1股為單位）
  if (shares === 0 && rawShares >= 1) {
    shares = Math.floor(rawShares);
    useFractional = true;
  }
  let invest = shares * entry;
  // 部位上限約束
  if (invest > account * maxPosPct) {
    if (useFractional) {
      shares = Math.floor(account * maxPosPct / entry);
    } else {
      shares = Math.floor(account * maxPosPct / entry / 1000) * 1000;
    }
    invest = shares * entry;
  }
  const accountPct = invest/account*100;

  $('c_r').textContent = r.toFixed(2);
  $('c_rpct').textContent = rpct.toFixed(2)+'%';
  $('c_radr').textContent = radr ? radr.toFixed(2)+'×' : '—';
  $('c_shares').textContent = fmt(shares) + (useFractional ? ' 股（零股）' : ' 股');
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

// ===== Auth Setup (首次使用要設 auth key) =====
function ensureAuthKey() {
  if (!CLOUD.enabled) return;
  if (CLOUD.authKey()) return;
  // 用 prompt 讓使用者輸入 auth key（手機 Safari 也有）
  const k = window.prompt('🔑 首次設定：請輸入 Auth Key 以啟用雲端同步\n（K哥用：kc-2026-qulla）');
  if (k && k.trim()) {
    localStorage.setItem('qjp_auth', k.trim());
    toast('✅ Auth Key 已設定，正在同步…');
  } else {
    toast('⚠️ 未設定 Auth Key，僅本地模式', 'warn');
  }
}

// ===== Init =====
function init() {
  loadAll();
  setupTabs();
  loadSettingsToForm();
  clearForm();
  renderJournalList();
  updateHeader();

  // 首次使用要設 auth key（沒設就跳 prompt）
  ensureAuthKey();

  // 背景拉雲端最新資料（不阻塞 UI）
  if (CLOUD.enabled) setTimeout(cloudPull, 200);

  // Form events
  ['j_entry_price','j_stop','j_shares','j_adr','j_exit_price','j_side'].forEach(id =>
    $(id).addEventListener('input', updatePreview));

  $('j_save').addEventListener('click', () => {
    const t = readForm();
    if (!t.symbol || !t.entry_price || !t.shares || !t.stop) {
      toast('請填股票代碼、進場價、股數、止損', 'err'); return;
    }
    // 名稱一致性檢查：如果代碼查得到中文名，且與表單不同 → 提示確認
    const proceed = async () => {
      try {
        const d = await apiAnalyze(t.symbol);
        if (d && d.name && t.name && d.name !== t.name) {
          const ok = confirm(`⚠️ 代碼 ${t.symbol} 官方名稱為「${d.name}」，\n但你填的是「${t.name}」。\n\n要自動改為「${d.name}」嗎？\n\n按「確定」套用官方名稱；「取消」保留你填的。`);
          if (ok) t.name = d.name;
        } else if (d && d.name && !t.name) {
          t.name = d.name;
        }
      } catch {}
      doSave(t);
    };
    proceed();
  });

  function doSave(t) {
    const idx = state.trades.findIndex(x => x.id === t.id);
    const isNew = idx < 0;
    if (idx >= 0) state.trades[idx] = { ...state.trades[idx], ...t };
    else state.trades.push(t);
    saveTrades();
    toast(idx >= 0 ? '已更新' : '已新增');
    if (isNew && t.status === 'OPEN' && t.side === 'LONG') {
      showOrderReminder(t);
    }
    clearForm();
    renderJournalList();
    updateHeader();
  }

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
  const resetAuthBtn = $('s_reset_auth');
  if (resetAuthBtn) {
    resetAuthBtn.addEventListener('click', () => {
      const cur = localStorage.getItem('qjp_auth') || '';
      const k = window.prompt('重設 Auth Key（留空 = 清除）', cur);
      if (k === null) return;
      if (k.trim()) {
        localStorage.setItem('qjp_auth', k.trim());
        toast('✅ Auth Key 已更新，重新同步中…');
        setTimeout(cloudPull, 200);
      } else {
        localStorage.removeItem('qjp_auth');
        toast('⚖️ Auth Key 已清除', 'warn');
      }
    });
  }

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
  : '/api';  // 同源 Pages Function proxy → EC2:18792

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
    if (d.name && !$('j_name').value) $('j_name').value = d.name;
    if (d.exchange) {
      const sel = $('j_market');
      if (sel && !sel.dataset.userSet) {
        // 將後端回傳的 exchange 對映到 select option (NASDAQ/NYSE → US, TPEX → TPEX, 其他保留)
        const map = { NASDAQ: 'US', NYSE: 'US', AMEX: 'US', ARCA: 'US', BATS: 'US' };
        sel.value = map[d.exchange] || d.exchange;
      }
    }
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
    const exitAddBtn = $('j_exit_add');
    if (exitAddBtn) exitAddBtn.addEventListener('click', () => { addExitRow({}); updatePreview(); });
    // 代碼欄輸入完點離（blur）自動抓資料
    const jSym = $('j_symbol');
    if (jSym) {
      jSym.addEventListener('blur', () => {
        const v = jSym.value.trim();
        if (v && v.length >= 4 && !$('j_entry_price').value) fetchJournalData();
      });
      jSym.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); fetchJournalData(); }
      });
    }
    const cSym = $('c_symbol');
    if (cSym) {
      cSym.addEventListener('blur', () => {
        const v = cSym.value.trim();
        if (v && v.length >= 4 && !$('c_entry').value) fetchCalcData();
      });
      cSym.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); fetchCalcData(); }
      });
    }
    const oi = $('ocr_import'); if (oi) oi.addEventListener('click', importFromOCR);
    const oc = $('ocr_clear'); if (oc) oc.addEventListener('click', () => $('ocr_input').value = '');
    const co = $('copy_orders'); if (co) co.addEventListener('click', copyTomorrowOrders);
    const ra = $('refresh_active'); if (ra) ra.addEventListener('click', refreshActivePrices);
    const ctj = $('c_to_journal'); if (ctj) ctj.addEventListener('click', calcToJournal);

    // 持倉 sub-tabs、IBKR 抓取
    document.querySelectorAll('#v_active .sub-tab').forEach(b => {
      b.addEventListener('click', () => switchActiveMarket(b.dataset.mkt));
    });
    const ib = $('ibkr_fetch'); if (ib) ib.addEventListener('click', fetchIbkrPositions);
  }, 200);
});

// ===== 持倉 sub-tab 切換 (台股 / 美股) =====
function switchActiveMarket(mkt) {
  document.querySelectorAll('#v_active .sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mkt === mkt);
  });
  $('active_pane_tw').style.display = (mkt === 'TW') ? '' : 'none';
  $('active_pane_us').style.display = (mkt === 'US') ? '' : 'none';
}

// ===== IBKR 美股持倉 =====
let _ibkrLoading = false;
async function fetchIbkrPositions() {
  if (_ibkrLoading) return;
  _ibkrLoading = true;
  const btn = $('ibkr_fetch');
  const stat = $('ibkr_status');
  const list = $('ibkr_list');
  const sumBox = $('ibkr_summary');
  btn.disabled = true;
  btn.textContent = '⏳ 拉取中 (10–30秒)...';
  stat.textContent = '啟動 ibeam container 並等待認證中...';
  list.innerHTML = '<div class="hint">拉取中, 請稍候...</div>';
  sumBox.style.display = 'none';
  try {
    const r = await fetch('/api/ibkr/positions');
    const data = await r.json();
    if (!r.ok || data.error) {
      const msg = data.error || `HTTP ${r.status}`;
      list.innerHTML = `<div class="hint" style="color:var(--neg)">❌ ${escapeHtml(msg)}</div>`;
      stat.textContent = '';
      toast('IBKR 拉取失敗：' + msg, 'err');
      return;
    }
    renderIbkrPositions(data);
    stat.textContent = `✅ ${data.count} 檔｜${new Date(data.fetched_at).toLocaleString('zh-TW',{hour12:false})}`;
    toast(`✅ IBKR 拉取完成 (${data.count} 檔)`);
  } catch (e) {
    list.innerHTML = `<div class="hint" style="color:var(--neg)">❌ 網路錯誤：${escapeHtml(String(e))}</div>`;
    toast('網路錯誤', 'err');
  } finally {
    _ibkrLoading = false;
    btn.disabled = false;
    btn.textContent = '🔄 重新抓取';
  }
}

function renderIbkrPositions(data) {
  const list = $('ibkr_list');
  const sumBox = $('ibkr_summary');
  const positions = data.positions || [];
  if (!positions.length) {
    list.innerHTML = '<div class="hint">目前 IBKR 帳戶無持倉。</div>';
    sumBox.style.display = 'none';
    return;
  }
  // 汇總
  let totalMV = 0, totalPnL = 0, totalCost = 0;
  positions.forEach(p => {
    totalMV += p.market_value || 0;
    totalPnL += p.unrealized_pnl || 0;
    totalCost += (p.qty * p.avg_cost) || 0;
  });
  const totalPct = totalCost ? (totalPnL / totalCost * 100) : 0;
  const pnlCls = totalPnL >= 0 ? 'pos' : 'neg';
  const sign = totalPnL >= 0 ? '+' : '';
  sumBox.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
      <div><div class="hint">總市值</div><div class="mono" style="font-size:18px;font-weight:600">$${fmt(totalMV,2)}</div></div>
      <div><div class="hint">未實現損益</div><div class="mono ${pnlCls}" style="font-size:18px;font-weight:600">${sign}$${fmt(totalPnL,2)}</div></div>
      <div><div class="hint">報酬率</div><div class="mono ${pnlCls}" style="font-size:18px;font-weight:600">${sign}${totalPct.toFixed(2)}%</div></div>
    </div>`;
  sumBox.style.display = '';
  // 個股列
  list.innerHTML = positions.map(p => {
    const cls = (p.unrealized_pnl >= 0) ? 'pos' : 'neg';
    const sg = (p.unrealized_pnl >= 0) ? '+' : '';
    return `<div class="ibkr-row">
      <div>
        <div class="sym">${escapeHtml(p.symbol)}</div>
        <div class="meta">${escapeHtml(p.name||'')}</div>
      </div>
      <div>
        <div>${fmt(p.qty)} 股 × 成本 $${fmt(p.avg_cost,2)}</div>
        <div class="meta">現價 $${fmt(p.market_price,2)}｜市值 $${fmt(p.market_value,2)}｜${p.currency}</div>
      </div>
      <div class="pnl">
        <div class="big ${cls}">${sg}$${fmt(p.unrealized_pnl,2)}</div>
        <div class="pct ${cls}">${sg}${p.pnl_pct.toFixed(2)}%</div>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===== 計算頁一鍵帶入日誌 =====
function calcToJournal() {
  const entry = parseFloat($('c_entry').value) || 0;
  const stop = parseFloat($('c_stop').value) || 0;
  const adr = parseFloat($('c_adr').value) || 0;
  const sym = ($('c_symbol').value || '').trim();
  // 建議股數從顯示區讀（純數字）
  const sharesText = ($('c_shares').textContent || '').replace(/[^0-9]/g, '');
  const shares = parseInt(sharesText) || 0;
  if (!entry || !stop || !shares) {
    toast('請先填進場/止損並估出建議股數', 'err'); return;
  }
  // 切 tab 到日誌
  document.querySelector('.tab[data-v="journal"]').click();
  // 清空表單（避免覇變編輯中的）
  clearForm();
  // 填值
  if (sym) $('j_symbol').value = sym;
  $('j_entry_price').value = entry;
  $('j_stop').value = stop;
  $('j_shares').value = shares;
  if (adr) $('j_adr').value = adr;
  $('j_entry_date').value = today();
  $('j_status').value = 'OPEN';
  // 如果有代碼 → 自動拓名稱
  if (sym && sym.length >= 4) {
    fetchJournalData();
  } else {
    updatePreview();
    toast('✅ 已帶入日誌，記得填代碼/名稱後儲存');
  }
}

// ===== 進場後掛單提醒 Modal =====
function showOrderReminder(t) {
  const r = calcR(t.entry_price, t.stop, t.side);
  if (!r || r <= 0) return;
  const r2 = (t.entry_price + 2*r).toFixed(2);
  const r3 = (t.entry_price + 3*r).toFixed(2);
  const third = Math.floor(t.shares / 3);
  const orderText = `【${t.symbol} ${t.name||''}】進場 ${t.entry_price} × ${t.shares} 股\n\n⚠️ 三張掛單請立即到券商 APP 設定：\n\n🔴 止損單（必設！）\n  跨破 ${t.stop} 市價賣出 ${t.shares} 股\n\n🟡 2R 減倉單\n  限價 ${r2} 賣出 ${third} 股（1/3）\n\n🟢 3R 減倉單\n  限價 ${r3} 賣出 ${third} 股（1/3）\n\n剩餘 ${t.shares - third*2} 股跟 10/20 EMA 動態出場`;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#1a1d24;border:2px solid #4f8cff;border-radius:12px;padding:24px;max-width:420px;width:100%;color:#e8eaed;">
      <h2 style="margin:0 0 12px;color:#ffb84f;">🔔 記得到券商 APP 設掛單！</h2>
      <pre style="white-space:pre-wrap;font-family:monospace;font-size:14px;line-height:1.6;background:#0d0f14;padding:12px;border-radius:8px;margin:0 0 16px;">${orderText}</pre>
      <div style="display:flex;gap:8px;">
        <button id="reminder_copy" style="flex:1;padding:10px;background:#4f8cff;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">📋 複製掛單清單</button>
        <button id="reminder_close" style="flex:1;padding:10px;background:#3a3f4b;color:#e8eaed;border:none;border-radius:6px;font-size:14px;cursor:pointer;">關閉</button>
      </div>
      <p style="margin:12px 0 0;font-size:12px;color:#8b8f99;">💡 跨破止損 → Stop Market；減倉 → Limit Sell。台股條件單多爲當日有效，明日記得重掛。</p>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#reminder_copy').onclick = () => {
    navigator.clipboard.writeText(orderText).then(() => toast('✅ 已複製'));
  };
  modal.querySelector('#reminder_close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

// ===== 複製明日掛單清單 =====
function copyTomorrowOrders() {
  const open = state.trades.filter(t => t.status === 'OPEN');
  if (!open.length) { toast('沒有持倉中的部位', 'warn'); return; }
  const lines = ['📋 明日掛單清單（貌到券商 APP 條件單）', ''];
  open.forEach(t => {
    const r = calcR(t.entry_price, t.stop, t.side);
    if (!r || r <= 0) return;
    const r2 = (t.entry_price + 2*r).toFixed(2);
    const r3 = (t.entry_price + 3*r).toFixed(2);
    const third = Math.floor(t.shares / 3);
    lines.push(`【${t.symbol} ${t.name||''}】`);
    lines.push(`  跨破止損單：${t.stop} 市價賣出 ${t.shares} 股`);
    lines.push(`  2R 減倉單：${r2} 限價賣出 ${third} 股`);
    lines.push(`  3R 減倉單：${r3} 限價賣出 ${third} 股`);
    lines.push('');
  });
  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    toast('✅ 已複製到剪貼簿，可貼到券商 APP', 'ok');
  }).catch(() => {
    // fallback：顯示在 prompt 讓他手動複製
    window.prompt('手動複製：', text);
  });
}

// ===== 重新抓持倉即時價 =====
async function refreshActivePrices() {
  const open = state.trades.filter(t => t.status === 'OPEN');
  if (!open.length) { toast('沒有持倉', 'warn'); return; }
  toast(`🔄 抓取 ${open.length} 檔中...`);
  let done = 0, fail = 0;
  for (const t of open) {
    try {
      const d = await apiAnalyze(t.symbol);
      t.current_price = d.close;
      t.current_ema10 = d.ema10;
      t.current_ema20 = d.ema20;
      done++;
    } catch { fail++; }
  }
  saveTrades();
  renderActive();
  renderJournalList();
  toast(`✅ 完成 ${done} 筆，失敗 ${fail} 筆`);
}

// ===== Watchlist =====
const LS_WATCH = 'qjp_watchlist';
function loadWatch() { try { return JSON.parse(localStorage.getItem(LS_WATCH) || '[]'); } catch { return []; } }
function saveWatch(w) { localStorage.setItem(LS_WATCH, JSON.stringify(w)); }

function renderWatch() {
  const list = $('watch_list');
  const items = loadWatch();
  if (items.length === 0) {
    list.innerHTML = '<div class="hint" style="text-align:center;padding:30px">尚無觀察標的</div>';
    return;
  }
  list.innerHTML = items.map((w, i) => `<div class="trade" data-i="${i}" style="grid-template-columns:80px 1fr auto">
    <div><div class="sym">${w.symbol}</div><div class="name">${w.name||''}</div></div>
    <div>
      <div>${w.reason} ${w.trigger?'｜觸發 '+w.trigger:''}</div>
      <div class="meta">${w.note||''}</div>
    </div>
    <button class="btn sm danger" data-del="${i}">刪</button>
  </div>`).join('');
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const items = loadWatch();
    items.splice(+b.dataset.del, 1);
    saveWatch(items);
    renderWatch();
    toast('已刪除');
  }));
}

function setupWatch() {
  $('watch_add').addEventListener('click', () => {
    $('watch_form').style.display = 'block';
    ['w_symbol','w_name','w_trigger','w_note'].forEach(id => $(id).value = '');
  });
  $('watch_cancel').addEventListener('click', () => $('watch_form').style.display = 'none');
  $('watch_save').addEventListener('click', () => {
    const sym = $('w_symbol').value.trim();
    if (!sym) { toast('請填代碼','err'); return; }
    const items = loadWatch();
    items.push({
      symbol: sym, name: $('w_name').value.trim(),
      reason: $('w_reason').value, trigger: parseFloat($('w_trigger').value)||null,
      note: $('w_note').value.trim(), added_at: today()
    });
    saveWatch(items);
    $('watch_form').style.display = 'none';
    renderWatch();
    toast('已加入觀察');
  });
}

// ===== Weekend Review =====
function renderReview() {
  const days7 = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const recent = state.trades.filter(t => (t.entry_date >= days7) || (t.exit_date >= days7));
  const closed7 = recent.filter(t => t.status === 'CLOSED');

  let html = '';
  if (closed7.length === 0) {
    $('review_summary').innerHTML = '<div class="hint">本週尚無平倉交易</div>';
  } else {
    const rms = closed7.map(calcRMultiple).filter(x => x != null);
    const wins = rms.filter(x => x > 0);
    const totalR = rms.reduce((a,b)=>a+b,0);
    $('review_summary').innerHTML = `<div class="r-row">
      <div><span class="lbl">本週交易</span><span class="mono big">${closed7.length}</span></div>
      <div><span class="lbl">勝率</span><span class="mono big">${(wins.length/rms.length*100).toFixed(0)}%</span></div>
      <div><span class="lbl">累計R</span><span class="mono big ${totalR>=0?'pos':'neg'}">${fmtR(totalR)}</span></div>
      <div><span class="lbl">最大贏</span><span class="mono pos">${rms.length?fmtR(Math.max(...rms)):'—'}</span></div>
      <div><span class="lbl">最大輸</span><span class="mono neg">${rms.length?fmtR(Math.min(...rms)):'—'}</span></div>
    </div>`;
  }

  // Trade-by-trade reflection
  if (recent.length === 0) {
    $('review_trades').innerHTML = '<div class="hint">本週無交易紀錄</div>';
  } else {
    $('review_trades').innerHTML = recent.map(t => {
      const rm = calcRMultiple(t);
      const r = calcR(t.entry_price, t.stop, t.side);
      const checks = [];
      if (rm != null) {
        if (rm <= -1) checks.push('🔴 虧損超過 1R（檢查：止損是否執行慢了？）');
        else if (rm < 0) checks.push('🟡 小虧出場（聰明，但確認是否有更早訊號）');
        else if (rm >= 2) checks.push('✅ 達到 2R+（這是 winner，分析突破特徵）');
      }
      if (r && r/t.entry_price*100 > 8) checks.push('⚠️ R 值偏大 (>8%)，下次可考慮更緊止損');
      if (t.note && t.note.match(/#\S+/g)) checks.push('🏷 標籤：' + t.note.match(/#\S+/g).join(' '));
      return `<div class="trade" style="grid-template-columns:80px 1fr auto">
        <div><div class="sym">${t.symbol}</div><div class="name">${t.name||''}</div></div>
        <div>
          <div>${t.entry_date} → ${t.exit_date||'持有中'}｜${rm!=null?fmtR(rm):'—'}</div>
          <div class="meta">${checks.join(' · ')||'—'}</div>
        </div>
        <div class="rmult ${rm>=0?'pos':'neg'}">${rm!=null?fmtR(rm):'—'}</div>
      </div>`;
    }).join('');
  }

  // Tag stats
  const tags = {};
  state.trades.forEach(t => {
    const m = (t.note||'').match(/#\S+/g);
    if (m) m.forEach(tag => {
      if (!tags[tag]) tags[tag] = { count: 0, totalR: 0 };
      tags[tag].count++;
      const rm = calcRMultiple(t);
      if (rm != null) tags[tag].totalR += rm;
    });
  });
  if (Object.keys(tags).length === 0) {
    $('review_tags').innerHTML = '<div class="hint">尚未使用標籤</div>';
  } else {
    $('review_tags').innerHTML = Object.entries(tags).sort((a,b)=>b[1].count-a[1].count).map(([t,v]) =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>${t}</span><span>${v.count} 次｜累計 ${fmtR(v.totalR)}</span></div>`
    ).join('');
  }
}

// hook into tab switch
const _origSetupTabs = setupTabs;
setupTabs = function() {
  _origSetupTabs();
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.v === 'watch') renderWatch();
      if (btn.dataset.v === 'review') renderReview();
    });
  });
  setupWatch();
};

// ===== Qullamaggie 選股檢查 =====
async function runQullaScreen() {
  const sym = ($('qs_symbol').value || '').trim();
  if (!sym) { toast('請輸入股票代碼', 'err'); return; }
  const box = $('qs_result');
  box.innerHTML = '<div class="hint">🔄 抓取資料並分析中（約 3-8 秒）...</div>';
  try {
    const r = await fetch(`${API_BASE}/qulla-screen/${encodeURIComponent(sym)}`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      box.innerHTML = `<div class="verdict bad">❌ ${e.error || '查詢失敗'}</div>`;
      return;
    }
    const d = await r.json();
    box.innerHTML = renderQullaScreenResult(d);
    // 點「帶入部位計算」按鈕
    const btn = document.getElementById('qs_use');
    if (btn) btn.addEventListener('click', () => {
      $('c_symbol').value = d.symbol;
      $('c_entry').value = d.close;
      $('c_stop').value = d.consol_low || (d.ema10 * 0.99).toFixed(2);
      $('c_adr').value = d.adr_pct;
      if (typeof updateCalc === 'function') updateCalc();
      toast('✅ 已帶入部位計算（進場=收盤、止損=整理低點、ADR）');
      window.scrollTo({top: 0, behavior: 'smooth'});
    });
  } catch (e) {
    box.innerHTML = `<div class="verdict bad">❌ ${e.message}</div>`;
  }
}

function renderQullaScreenResult(d) {
  const verdictClass = d.verdict === '買' ? 'good' : (d.verdict === '等' ? 'warn' : 'bad');
  const verdictIcon  = d.verdict === '買' ? '🚀' : (d.verdict === '等' ? '🟡' : '🔴');

  const checksHtml = d.checks.map(c => {
    const icon = c.pass ? '✅' : (c.note && c.note.startsWith('🟡') ? '🟡' : '❌');
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 8px;border-bottom:1px solid var(--border);font-size:13px">
      <span style="flex:0 0 auto">${icon} <b>${c.item}</b></span>
      <span class="mono" style="color:var(--muted);text-align:right">${c.value}${c.note ? `<br><span style="font-size:11px">${c.note.replace(/^[✅❌🟡🚀⚠️]\s*/, '')}</span>` : ''}</span>
    </div>`;
  }).join('');

  const nameStr = d.name ? ` ${d.name}` : '';
  const tickerStr = d.ticker ? ` <span class="hint">(${d.ticker})</span>` : '';

  return `
    <div class="card" style="margin:0;padding:14px;background:var(--bg-2);border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">${d.symbol}${nameStr}${tickerStr}</h3>
        <div class="verdict ${verdictClass}" style="font-size:18px;font-weight:700">${verdictIcon} ${d.verdict}</div>
      </div>
      <div style="margin:8px 0 12px">
        <div style="font-size:13px;color:var(--muted)">${d.reason}</div>
        <div class="mono" style="margin-top:6px">收 <b>${d.close}</b>｜52週高 ${d.high_52w} (距 ${d.pct_from_52w_high}%)｜52週低 ${d.low_52w}｜52週位置 ${d.pct_in_52w_range}%</div>
        <div class="mono">1M ${d.chg_1m != null ? d.chg_1m + '%' : '—'}｜3M ${d.chg_3m != null ? d.chg_3m + '%' : '—'}｜6M ${d.chg_6m != null ? d.chg_6m + '%' : '—'}</div>
        <div class="mono">EMA10/20/50 = ${d.ema10} / ${d.ema20} / ${d.ema50}｜ADR ${d.adr_pct}%</div>
        <div class="mono">整理區間（近 ${d.consol_window_days}日）${d.consol_low} ~ ${d.consol_high}｜回撤 ${d.drawdown_pct}%${d.breakout_today ? '｜<b style="color:var(--good)">今日突破</b>' : (d.near_breakout ? '｜接近突破' : '')}</div>
      </div>
      <div style="background:var(--bg);border-radius:6px;padding:4px 10px;margin-bottom:12px">
        ${checksHtml}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
        <span>分數：<b>${d.score}/${d.max_score}</b>（${d.score_pct}%）</span>
        <button class="btn sm primary" id="qs_use" type="button">📥 帶入上方部位計算</button>
      </div>
    </div>`;
}

// 綁定
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('qs_run');
  const inp = document.getElementById('qs_symbol');
  if (btn) btn.addEventListener('click', runQullaScreen);
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') runQullaScreen(); });
});
