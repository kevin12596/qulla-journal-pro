// Cloudflare Pages Worker
// 路由：
//   /api/journal/*  → D1 (qulla-db) CRUD（雲端同步）
//   /api/*          → proxy to EC2:18792（即時報價/ADR）

const BACKEND_HOST = "43-207-213-168.nip.io";
const BACKEND_PORT = 18792;

// 簡易共用密鑰（前端帶 X-Auth-Key），透過 Cloudflare Pages 環境變數注入
function authOk(request, env) {
  const want = env.QJP_AUTH_KEY;
  if (!want) return true; // 未設定就放行（dev）
  const got = request.headers.get("x-auth-key");
  return got && got === want;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ===== D1 Journal API =====
async function handleJournal(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (!env.DB) {
    return json({ error: "D1 binding 'DB' missing" }, 500);
  }
  if (!authOk(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const path = url.pathname.replace(/^\/api\/journal\/?/, "");
  const userId = url.searchParams.get("user") || "kc";

  try {
    // GET /api/journal/all → { trades, settings }
    if (request.method === "GET" && (path === "" || path === "all")) {
      const trades = await env.DB.prepare(
        "SELECT * FROM trades WHERE user_id = ? ORDER BY entry_date DESC, updated_at DESC"
      ).bind(userId).all();
      const settings = await env.DB.prepare(
        "SELECT * FROM settings WHERE user_id = ?"
      ).bind(userId).first();
      return json({
        trades: (trades.results || []).map(rowToTrade),
        settings: settings ? rowToSettings(settings) : null,
      });
    }

    // PUT /api/journal/trade  body: trade obj  (upsert)
    if (request.method === "PUT" && path === "trade") {
      const t = await request.json();
      await upsertTrade(env.DB, userId, t);
      return json({ ok: true, id: t.id });
    }

    // POST /api/journal/trades-bulk  body: [trade,...]  (replace-all for user)
    if (request.method === "POST" && path === "trades-bulk") {
      const arr = await request.json();
      if (!Array.isArray(arr)) return json({ error: "expect array" }, 400);
      await env.DB.prepare("DELETE FROM trades WHERE user_id = ?").bind(userId).run();
      for (const t of arr) await upsertTrade(env.DB, userId, t);
      return json({ ok: true, count: arr.length });
    }

    // DELETE /api/journal/trade/:id
    if (request.method === "DELETE" && path.startsWith("trade/")) {
      const id = path.slice("trade/".length);
      await env.DB.prepare("DELETE FROM trades WHERE user_id = ? AND id = ?")
        .bind(userId, id).run();
      return json({ ok: true });
    }

    // PUT /api/journal/settings  body: settings obj
    if (request.method === "PUT" && path === "settings") {
      const s = await request.json();
      await env.DB.prepare(
        `INSERT INTO settings (user_id, account_size, risk_pct, position_max_pct, r_adr_max, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           account_size=excluded.account_size,
           risk_pct=excluded.risk_pct,
           position_max_pct=excluded.position_max_pct,
           r_adr_max=excluded.r_adr_max,
           updated_at=excluded.updated_at`
      ).bind(
        userId,
        s.account ?? null,
        s.risk_pct ?? null,
        s.max_pos_pct ?? null,
        s.max_radr ?? null,
        Date.now()
      ).run();
      return json({ ok: true });
    }

    return json({ error: "not found", path, method: request.method }, 404);
  } catch (err) {
    return json({ error: "d1_error", detail: String(err) }, 500);
  }
}

async function upsertTrade(DB, userId, t) {
  await DB.prepare(
    `INSERT INTO trades
       (id, user_id, symbol, name, market, direction, entry_date, entry_avg, shares,
        stop, high_day, low_day, adr_pct, status, exit_date, exit_avg, exit_reason,
        breakout, setup, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       symbol=excluded.symbol, name=excluded.name, market=excluded.market,
       direction=excluded.direction, entry_date=excluded.entry_date,
       entry_avg=excluded.entry_avg, shares=excluded.shares, stop=excluded.stop,
       high_day=excluded.high_day, low_day=excluded.low_day, adr_pct=excluded.adr_pct,
       status=excluded.status, exit_date=excluded.exit_date, exit_avg=excluded.exit_avg,
       exit_reason=excluded.exit_reason, breakout=excluded.breakout,
       setup=excluded.setup, notes=excluded.notes, updated_at=excluded.updated_at`
  ).bind(
    t.id, userId,
    t.symbol ?? null, t.name ?? null, t.market ?? null, t.side ?? null,
    t.entry_date ?? null, t.entry_price ?? null, t.shares ?? null,
    t.stop ?? null, t.day_high ?? null, t.day_low ?? null, t.adr ?? null,
    t.status ?? null, t.exit_date ?? null, t.exit_price ?? null, t.exit_reason ?? null,
    t.breakout ?? null, t.setup ?? null, t.note ?? null,
    Date.now()
  ).run();
}

function rowToTrade(r) {
  return {
    id: r.id,
    symbol: r.symbol, name: r.name, market: r.market, side: r.direction,
    entry_date: r.entry_date, entry_price: r.entry_avg, shares: r.shares,
    stop: r.stop, day_high: r.high_day, day_low: r.low_day, adr: r.adr_pct,
    status: r.status, exit_date: r.exit_date, exit_price: r.exit_avg,
    exit_reason: r.exit_reason, breakout: r.breakout, setup: r.setup,
    note: r.notes, updated_at: r.updated_at,
  };
}
function rowToSettings(r) {
  return {
    account: r.account_size, risk_pct: r.risk_pct,
    max_pos_pct: r.position_max_pct, max_radr: r.r_adr_max,
  };
}

// ===== Backend Proxy (報價/分析) =====
async function proxyBackend(request, url) {
  const target = `http://${BACKEND_HOST}:${BACKEND_PORT}${url.pathname}${url.search}`;
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk.startsWith("cf-") || lk === "x-forwarded-host" || lk === "x-real-ip") continue;
    headers.set(k, v);
  }
  headers.set("Host", `${BACKEND_HOST}:${BACKEND_PORT}`);
  headers.set("X-Forwarded-Proto", "https");
  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "follow",
  };
  try {
    const resp = await fetch(target, init);
    const respHeaders = new Headers(resp.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => respHeaders.set(k, v));
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: respHeaders });
  } catch (err) {
    return json({ error: "Backend unreachable", detail: String(err) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/journal")) {
      return handleJournal(request, env, url);
    }
    if (url.pathname.startsWith("/api/")) {
      return proxyBackend(request, url);
    }
    return env.ASSETS.fetch(request);
  },
};
