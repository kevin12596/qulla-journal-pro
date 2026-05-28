# Qulla Journal Pro Roadmap

> 單一真相來源。新 session 直接讀這份即可接手。

---

## ✅ v0.2（2026-05-27 完成上線）

### 線上服務
- 網站：https://qulla-journal.pages.dev
- API（同源 HTTPS）：https://qulla-journal.pages.dev/api/*
  - `/api/health`
  - `/api/quote/<symbol>`
  - `/api/adr/<symbol>`
  - `/api/analyze/<symbol>`

### 架構
```
你的瀏覽器 (HTTPS)
  ↓
Cloudflare Pages (qulla-journal.pages.dev)
  ├─ 靜態檔案：index.html / app.js / style.css
  └─ _worker.js：把 /api/* proxy 到後端
       ↓ (走 nip.io 解 Cloudflare 直連 IP 限制)
       http://43-207-213-168.nip.io:18792
            ↓
       你的 Lightsail EC2 (43.207.213.168:18792)
         └─ qulla-api.service (systemd, auto-restart)
            └─ Flask + tradingview_ta
```

### 程式碼位置
```
~/.openclaw/workspace/projects/qulla-journal-pro/
├── public/                  # Cloudflare Pages 部署目錄
│   ├── _worker.js           # Pages Worker（API proxy）
│   ├── index.html
│   ├── app.js               # API_BASE = '/api'（同源）
│   └── style.css
├── api/
│   └── server.py            # Flask API（systemd 管理）
├── docs/
│   └── roadmap.md           # ← 這份
└── README.md
```

### 關鍵 ID（憑證請看 ~/.openclaw/workspace/secrets/qulla.env）
- Cloudflare Account ID：`1cfa1fa649f1c943d3cdf07098664682`
- Pages 專案名：`qulla-journal`
- Named Tunnel：`qulla-api`（id `2cef623b-ae92-4f88-b1f1-bdb680fb2bbf`，目前未使用，但 cloudflared.service 仍在跑備援）
- systemd：`qulla-api`（API）、`cloudflared`（tunnel）
- API log：`/var/log/qulla-api.log`

### 部署指令
```bash
source ~/.openclaw/workspace/secrets/qulla.env   # 載入 CF token
cd ~/.openclaw/workspace/projects/qulla-journal-pro
wrangler pages deploy public --project-name=qulla-journal --branch=main --commit-dirty=true

# 改 API 後重啟：
sudo systemctl restart qulla-api
```

### 部署過程踩過的坑（避免重蹈）
1. ❌ Cloudflare Worker 不能直接 fetch 純 IP（error 1003）→ ✅ 用 nip.io 包一層
2. ❌ `functions/api/[[path]].js` 在某些情況不被識別 → ✅ 改用 `_worker.js`
3. ✅ Mixed Content 由 Worker server-side 化解
4. ✅ Lightsail port 18792 必須對外開放（Worker 從邊緣節點打進來）

---

## 🎯 v0.3 待辦：Watchlist 自動評分器（Qulla Score）

**輸入**：股票代號 → **輸出**：Qullamaggie 6 條件評分 + 結論

### 新 API：`GET /api/qulla-score/<symbol>`

| 條件 | 門檻 | 資料來源 |
|------|------|---------|
| 3 個月漲幅 | > 30% | 90 日 K 線 |
| 均線多頭排列 | 10>20>50 EMA | 已有（analyze API） |
| 整理區間天數 | 2-8 週（10-40 交易日） | 從歷史 K 線偵測 |
| 整理區回撤 | < 25% | 整理區 high/low |
| 整理期成交量 | 縮量（vs 前波） | 量能比較 |
| 放量突破 | 成交量 > 整理期均量 1.5x + 收盤過區間高 | 當日 vs 整理期均量 |

### 回傳格式
```json
{
  "symbol": "9939",
  "name": "宏全",
  "checks": {
    "gain_3m":           {"ok": false, "value": 18.4, "threshold": 30},
    "bull_align":        {"ok": true},
    "consolidation_days":{"ok": true,  "value": 22},
    "drawdown_pct":      {"ok": true,  "value": 15.6, "threshold": 25},
    "volume_dry_up":     {"ok": true},
    "volume_breakout":   {"ok": false}
  },
  "score": 4,
  "verdict": "🟡 接近條件，等更明確突破",
  "action": "watch"
}
```

### verdict 對照
- 5-6 分 → 🟢 買（符合條件）
- 3-4 分 → 🟡 等（接近，加入觀察）
- 0-2 分 → 🔴 不碰

### UI
「🔭 觀察清單」分頁加：
- 搜尋框 + 一鍵分析按鈕
- 評分卡（紅黃綠燈 + 6 條件清單）
- 「加入觀察清單」按鈕

### 技術細節
- `server.py` 目前用 `tradingview_ta`
- ADR endpoint 已用 `yfinance`，沿用它抓 90 日歷史 K 線即可
- 整理區間偵測：用 rolling window 找最近 N 天的 high/low 區間，判斷波動 < drawdown 門檻
