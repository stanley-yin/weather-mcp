# weather

練習架設 MCP（Model Context Protocol）server 的小專案。

## 開發

```bash
npm install
npm run build
```

編譯後的執行檔位於 `build/index.js`。

## 提供的工具

- `get-alerts` / `get-forecast`：美國 NWS API，僅支援美國地區
- `get-tw-forecast` / `get-tw-alerts`：中央氣象署 (CWA) 開放資料，台灣 22 縣市天氣預報與特報

台灣工具需要設定環境變數 `CWA_API_KEY`，可至 [中央氣象署開放資料平臺](https://opendata.cwa.gov.tw/) 免費申請。

`get-tw-forecast` 支援 **Elicitation**：不帶 `county` 時，若 client 支援表單會跳出來問要查哪個縣市；client 不支援時直接回傳清楚的錯誤訊息，不會卡住。

## 參考資料

- [Build an MCP Server](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server)
