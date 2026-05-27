# Qulla Journal Pro - 部署指南

## 📦 檔案結構

```
qulla-journal-pro/
├── public/              # 靜態網站（部署到 Cloudflare Pages）
│   ├── index.html
│   ├── style.css
│   └── app.js
└── api/                 # 後端 API（已部署在 EC2:18792）
    └── server.py
```

## 🚀 部署步驟

### 步驟 1：部署網站到 Cloudflare Pages

```bash
# 1. 建立新 repo
cd /home/ubuntu/.openclaw/workspace/projects/qulla-journal-pro
cd public
git init
git add .
git commit -m "Initial: Qulla Journal Pro v0.1"
git remote add origin https://github.com/kevin12596/qulla-journal-pro.git
git push -u origin main

# 2. Cloudflare Pages
#    - Connect to GitHub
#    - 選 qulla-journal-pro repo
#    - Build command: (空)
#    - Build output: /
#    - 部署後給你 qulla-journal.pages.dev
```

### 步驟 2：API 已部署在 EC2

API URL: `http://YOUR_EC2_IP:18792/api/`
端點：
- `GET /api/health` - 健康檢查
- `GET /api/quote/<symbol>` - 即時報價
- `GET /api/adr/<symbol>` - 近 20 日 ADR
- `GET /api/analyze/<symbol>` - 全套分析（網站用這個）

### 步驟 3：CORS 設定

API 端已開 CORS（允許所有來源），網站直接呼叫即可。

如果要綁域名 + HTTPS：
```bash
# 在 Cloudflare 加一個 subdomain 指到 EC2
# 例：qjp-api.kcliang.com → EC2:18792
# 配 SSL 後改 app.js 的 API_BASE
```

## 🧪 本地測試

```bash
# 1. 啟動 API
cd api && python3 server.py 18792

# 2. 啟動網站
cd public && python3 -m http.server 8000

# 3. 開瀏覽器
open http://localhost:8000
```

## 📋 功能清單（v0.1）

- ✅ 交易日誌（CRUD）
- ✅ R-multiple 自動計算
- ✅ 部位計算機 + R/ADR 評估
- ✅ 期望值儀表板（勝率、平均 R、累計、月度）
- ✅ R-multiple 分布圖
- ✅ 持倉中總覽
- ✅ 一鍵自動抓股價/EMA/ADR
- ✅ OCR 對帳單 JSON 匯入（合併同代碼）
- ✅ CSV / JSON 匯出匯入
- ✅ LocalStorage 儲存

## 🛣 Roadmap

- [ ] D1 雲端同步（多裝置）
- [ ] 希夏自動寫入（API token + webhook）
- [ ] 每日 Watchlist 自動掃描
- [ ] 圖片 OCR 自動解析（不用手 key JSON）
- [ ] 週末 Review 模板
- [ ] 錯誤標籤系統
- [ ] K 線截圖自動歸檔

## 🦐 希夏整合

未來計劃：
1. 希夏在 Telegram/LINE 收到「我買了 XXX 1000 股 @ 211」 → 直接寫入網站 DB
2. 每日盤後 → 希夏自動更新所有 OPEN 部位的 current_price
3. 達 2R/3R → 希夏推 Telegram + 網站閃紅
