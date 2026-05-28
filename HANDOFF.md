# Qulla Journal Pro - 2026/05/27 Handoff

> 給 K哥的接續文件。新 session 把這份整份貼給希夏，直接接著做。

---

## ✅ 今日已完成（部署完）

### 1. D1 雲端同步完成上線
- **網站：** https://qulla-journal.pages.dev
- **D1 DB：** `qulla-db` (UUID: `11863931-af89-4797-9830-4a5c9407ee9d`)
- **Tables 已建：** `trades`, `settings`（與 momentum-db 共用 DB 但不同表，無衝突）
- **Worker 已部署：** Cloudflare Pages Worker 內建 D1 binding (`DB`)
- **Auth Key：** `<YOUR_AUTH_KEY>`（已設在 Pages 環境變數 `QJP_AUTH_KEY`，前端用 `X-Auth-Key` header 帶）

### 2. API 端點（D1）
所有端點都需要帶 `X-Auth-Key: <YOUR_AUTH_KEY>`

| Method | Path | 用途 |
|--------|------|------|
| GET    | `/api/journal/all?user=kc` | 拉全部 trades + settings |
| PUT    | `/api/journal/trade?user=kc` | 單筆 upsert（body: trade JSON）|
| POST   | `/api/journal/trades-bulk?user=kc` | 整批替換（body: array）|
| DELETE | `/api/journal/trade/<id>?user=kc` | 刪一筆 |
| PUT    | `/api/journal/settings?user=kc` | 存 settings |

舊的 `/api/quote`、`/api/adr`、`/api/analyze` 保留 → proxy 到 EC2:18792。

### 3. 端對端測試 ✅ 全綠
PUT/GET/DELETE/auth 驗證都通過，D1 真的有寫入並讀回。

---

## 🔑 K哥要做的：在瀏覽器 Console 設定 auth key（一次就好）

打開 https://qulla-journal.pages.dev → F12 → Console → 貼這行：

```js
localStorage.setItem('qjp_auth', '<YOUR_AUTH_KEY>'); location.reload();
```

之後每台裝置只要做這一次。手機 Safari 沒 Console 的話，下面有替代方案 ↓

### 手機沒 Console 怎麼辦？
跟新 session 的希夏說「**幫我加一個首次設定 auth 的 UI**」，我會在網站加一個彈窗（首次開啟時請你輸入 auth key），免去 Console 步驟。今天時間關係先用 Console 法，最快。

---

## 🌐 跨平台同步邏輯（重要）

- **啟動：** 先讀 LocalStorage（即時顯示）→ 200ms 後背景拉 D1（覆蓋成最新）
- **寫入：** 雙寫（LocalStorage + D1），D1 失敗會 console.warn 但不阻塞 UI
- **衝突策略：** 雲端為準（last write wins，以 `updated_at` 排序）
- **離線：** 仍可用，純 LocalStorage 模式；下次連線時 D1 拉取會覆蓋本地

---

## 📁 程式碼位置

```
/home/ubuntu/.openclaw/workspace/projects/qulla-journal-pro/
├── public/
│   ├── _worker.js     ← Pages Worker（D1 CRUD + EC2 proxy）
│   ├── app.js         ← 前端（已加雲端同步層）
│   ├── index.html
│   └── style.css
└── HANDOFF.md         ← 本檔
```

**重新部署指令：**
```bash
cd /home/ubuntu/.openclaw/workspace/projects/qulla-journal-pro
source /home/ubuntu/.openclaw/workspace/secrets/qulla.env
wrangler pages deploy public --project-name qulla-journal --branch main --commit-dirty=true
```

---

## 📖 Qulla Journal Pro 使用手冊

### 操作流程（每個交易日）

#### 1. 設定（首次或要調整）
進入「設定」分頁：
- **帳戶大小**：3,000,000（你目前設的）
- **每筆風險 %**：1.0（Qulla 標準，新手 0.25-0.5 起步）
- **單一部位上限 %**：40
- **R/ADR 上限**：1.5（風險不能大於日均波動 1.5 倍）

#### 2. 進場前算部位（「部位計算」分頁）
輸入：進場價、止損價、ADR%
→ 自動算出：1R/股、R%、R/ADR、建議股數、2R/3R 目標、占帳戶 %
→ R/ADR > 1.5 會警告「太貼，止損太緊」

#### 3. 進場後建單（「日誌」分頁）
必填：股票代碼、名稱、市場、進場日期、進場均價、股數、止損
進階：當日高/低、ADR%、突破點、形態（HTF/EP/Pullback/...）、備註
狀態 = OPEN

#### 4. 平倉時更新
回到該筆 → 狀態改 CLOSED → 填出場日期、出場均價、出場原因
→ 自動算 R-multiple、PnL、勝率、累計 R

#### 5. OCR 自動建單（最爽）
把券商成交對帳單截圖丟給希夏 → 希夏 OCR 出 JSON → 貼到「貼上成交對帳單」區塊 → 一鍵建單。

#### 6. 週末 Review（每週日下午）
進「Dashboard」分頁：
- 看勝率、平均賺R、平均賠R、累計R
- **期望值 = 勝率 × 平均賺R − 敗率 × 平均賠R，目標 > +0.5R**
- 在每筆備註加標籤：`#追高 #拗單 #提前出 #過度交易`
- 統計頁會自動聚合錯誤類型 → 找出你最常犯的錯

### Qulla 系統的核心數字

| 指標 | 標準 | 意義 |
|------|------|------|
| 勝率 | 25-35% | 不需要高勝率，靠 R 倍數獲利 |
| 平均賺R | > 2R | 對的時候要讓利潤跑 |
| 平均賠R | < 1R | 錯的時候極速止損 |
| 期望值 | > +0.5R | < 0 代表系統對你無效，停止交易 |
| 樣本數 | ≥ 30 筆 | 之前的數字都是雜訊 |

### 重要原則
1. **進場前先算 R**，沒算過不准下單
2. **止損價設好 = 止損單一定要掛**（OCO/Bracket Order）
3. **R/ADR 過大就放棄**這筆，不是放寬風險
4. **錯誤標籤要老實寫**，騙自己沒用
5. **30 筆前的勝率/期望值都是雜訊**，別急著下結論

---

## 📝 今日操作評語（Qulla 老師會說什麼）

K哥今天出清：京元電子（235）、旺矽（8）、德律 3030（177）；保留：創鉅、優群、東捷。

### Qulla 大概會這樣評：

**好的部分：**
- ✅ **京元電子認錯**：你自己說「沒按突破買入又跌破」→ 這就是 Qulla 講的「規則錯了就立刻砍」，不拗不硬凹，正確。
- ✅ **3030 跌破突破日低點出清**：教科書式止損。突破日低點 = 你進場的承諾線，破了就走，沒有「再等等看」。
- ✅ **意識到「最近不順 → 全部清空 → 重新學習」**：這是 Qulla 講的 "step away when you're not in sync"。不在狀態時，最好的交易就是不交易。

**要注意的部分：**
- ⚠️ **旺矽出清要想清楚理由**：6223 現價 6390，EMA 多頭排列、站穩所有均線、TV 顯示 STRONG_BUY，乖離 13.2%（偏高但還沒過熱）。如果出清理由是「想找更好點重進場」，要問自己：你有明確的回踩買點嗎？還是只是「最近不順想離開」？
  - **如果是後者** → OK，承認自己情緒不對，全清是對的
  - **如果是前者** → 寫下重進場的條件（例如：回踩 10 EMA 5970 縮量 + 隔日反彈過前日高），不然永遠等不到
- ⚠️ **「最近不順」要量化**：別憑感覺說不順。打開 Qulla Journal 看最近 10 筆的 R-multiple 累計，是真的不順還是只是兩三筆心理放大？

**Qulla 會給你的功課（這週做完）：**
1. 把今天平倉的 4 筆（京元電 ×1、旺矽 ×1、3030 ×1）全部建檔到 Qulla Journal，填出場原因
2. 每筆加錯誤標籤（京元電 = #追高？#沒按規則？；旺矽 = #情緒出場？）
3. 算出最近一個月真實期望值
4. 期望值 < 0 → 找出主要錯誤類型 → 針對那個錯誤寫一條規則

> 「The market doesn't owe you anything. The only thing you owe yourself is to follow your rules.」— Kullamägi 風格的話

---

## 🔌 Crypto Miner → AI Factory 題目（剛好你問了）

### 國際公司（純 crypto 轉型成 AI infra）

| 公司 | Ticker | 進度 | 受惠程度 |
|------|--------|------|----------|
| **IREN** (前 Iris Energy) | IREN | $3B 可轉債融資 AI infra；90% 估值已來自 AI/HPC | ⭐⭐⭐⭐⭐ 已驗證 |
| **Hut 8** | HUT | 路州 $7B + 德州 $9.8B 15年租約（客戶含 Google） | ⭐⭐⭐⭐⭐ 大單已簽 |
| **Core Scientific** | CORZ | 與 CoreWeave 12年合約 | ⭐⭐⭐⭐ 已執行 |
| **TeraWulf** | WULF | 紐約 Lake Mariner 廠區轉 HPC | ⭐⭐⭐⭐ |
| **Applied Digital** | APLD | 北達科他州 HPC 廠 + CoreWeave 客戶 | ⭐⭐⭐⭐ |

> **為什麼能轉型？** 礦工本來就有兩個 AI 缺的東西：
> 1. **電力**（已申請大量 MW 容量，AI Factory 最缺）
> 2. **冷卻設施**（液冷工廠，剛好 AI GPU 也要液冷）
>
> 缺的是 GPU 和客戶關係 → 簽長租給超大規模客戶（Hyperscaler）反而最快。

### 台股相關受惠（光電、土電題材）
這篇黃仁勳新聞 + crypto 轉型 AI 是同一個底層趨勢 = **電力與資料中心基建短缺**

**短期受惠（土電廠、變電所、配電盤）：**
| 代碼 | 名稱 | 邏輯 |
|------|------|------|
| 1513 | 中興電 | 變電所、超高壓設備龍頭，台電擴容直接受惠 |
| 1514 | 亞力 | 配電盤、變壓器，DC 案場標配 |
| 1503 | 士電 | 重電（變壓器、開關設備）|
| 1604 | 聲寶 | 商用空調 DC 散熱（次受惠）|

**液冷/伺服器（已熱）：**
- 3017 奇鋐、3324 雙鴻、6669 緯穎、3661 世芯-KY

**新廠土建（北士科 NVIDIA 總部、變電所）：**
- 2515 中工、2548 華固（高雄）、5511 德昌、2545 皇翔（北市區建商）

**值得追蹤的小型題材股：**
- 6147 頎邦（先進封裝）— AI factory 高效能晶片下游
- 6669 緯穎、6789 采鈺（CoWoS 光路）

> **K哥你目前持倉裡的旺矽 6223** 也是這個鏈，探針卡在 AI 晶片測試直接受惠。如果你出清是因為情緒，這個基本面其實沒變。

### 風險提醒
- 礦工轉型股已漲一波（HUT、IREN 都翻倍以上），追高風險高，等回踩
- 台股土電題材（1513、1514）也都在歷史相對高位，找拉回 10/20 EMA 的機會
- 新聞題材股都吃「想像力」，**沒突破型態前不入場**（Qulla 鐵律）

---

## 🎯 新 session 第一句話建議

> 「希夏，我接著昨天 Qulla Journal Pro 的 D1 同步繼續做。我已經在 Console 設好 auth key 了/還沒設好，請幫我[繼續開發某功能 / 處理某問題]。Handoff 文件在 `/home/ubuntu/.openclaw/workspace/projects/qulla-journal-pro/HANDOFF.md`。」

這樣希夏會直接讀 HANDOFF.md 上下文無縫接續。

---
更新時間：2026-05-27 UTC+8 20:30 左右
