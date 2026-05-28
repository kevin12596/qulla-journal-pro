# Cloudflare Pages 連 GitHub 自動部署設定步驟

## 目標
讓 `git push` 到 `kevin12596/qulla-journal-pro` 自動觸發 Cloudflare Pages 重新部署，不用手動 wrangler。

## 為什麼不能用 API 自動設定
Cloudflare Pages 的 "Connect to Git" 必須走 OAuth 在 dashboard 完成（API 無法綁 GitHub source），所以這一步要手動。

## 步驟（5 分鐘）

1. 開 https://dash.cloudflare.com/1cfa1fa649f1c943d3cdf07098664682/pages/view/qulla-journal/settings/builds-deployments
2. 找「Source」區塊 → 點 **"Connect to Git"**
3. 授權 GitHub（選 `kevin12596` 帳號）
4. 選 repo：**`kevin12596/qulla-journal-pro`**
5. 設定：
   - Production branch: `main`
   - Build command: 留空（不需要 build）
   - Build output directory: `public`
   - Root directory: 留空（repo 根目錄）
6. 儲存

## 驗證
完成後做一個小修改 push：
```bash
cd ~/.openclaw/workspace/projects/qulla-journal-pro
echo "" >> README.md
git add README.md && git commit -m "test: trigger Pages auto-deploy" && git push
```
1 分鐘後 https://qulla-journal.pages.dev 應該自動更新。

## 重要：環境變數與 D1 不會變
- `QJP_AUTH_KEY` 環境變數 → 保留
- `DB` D1 binding (qulla-db) → 保留
- 改 Git 連動只影響「程式碼從哪來」，不動其他設定

## 之後流程
| 動作 | 指令 |
|------|------|
| 改前端 | 改 `public/*.html` `public/*.js` 等 → `git push` → 自動部署 |
| 改後端 | 改 `api/server.py` → 在 EC2 重啟 server.py（Pages 不管後端） |
| 改 Worker（D1 同步） | 改 `public/_worker.js` → `git push` → 自動部署 |

## 要不要砍掉 wrangler 部署
不用。Connect to Git 後 wrangler 還是能用，等於有兩個部署管道：
- Git push → 給日常開發
- wrangler → 給緊急熱修（不想等 build）
