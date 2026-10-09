# AI 交易智能体

以「模拟交易优先」为原则的 AI 交易系统：**研究由 AI 提出假设，风控和执行由确定性代码完成，AI 永远不直接下单。**

- 市场：Binance 永续合约（BTC/USDT、ETH/USDT）
- 周期：1h 主周期，4h 确认周期
- 模式：PAPER（模拟），真钱模式需全部验收通过后才开放

设计文档见 [`docs/design-doc.md`](docs/design-doc.md)，建设计划见 [`docs/plan.md`](docs/plan.md)。

## 交付进度

| # | 交付 | 状态 |
|---|---|---|
| 1 | 行情 & 市场状态看板（含 1 年历史 K 线仓库） | ✅ 已完成 |
| 2 | 回测实验室（成本模型、滚动验证、参数敏感性） | ⏳ |
| 3 | 风控大脑 + 模拟自动交易 + 紧急停止 | ⏳ |
| 4 | 交易驾驶舱（净值、持仓、订单、告警、设置） | ⏳ |
| 5 | AI 研究员 & 每日复盘 | ⏳ |
| 6 | 验收清单页 | ⏳ |

## 目录结构

```
backend/
  server.js            入口（Surf SDK createServer：自动挂载路由、定时任务、数据库同步）
  cron.json            定时任务：每小时第 2 分钟同步行情 + 判定市场状态
  db/schema.js         数据表：candles, regime_snapshots, events, sync_state
  lib/config.js        全部参数（标的、周期、市场状态阈值、风控、成本）
  lib/indicators.js    确定性指标：EMA / ATR / ADX / RSI / 布林带
  lib/regime.js        市场状态判定（趋势 / 震荡 / 高波动 / 低流动性 / 不明确）
  lib/feed.js          行情拉取（重试 + 指数退避）、只存已收盘 K 线、数据质量检查
  lib/jobs.js          每小时任务
  routes/market.js     /api/market/*  看板接口
frontend/
  src/App.tsx          主界面
  src/components/      图表与面板
docs/                  设计文档与计划
```

## 市场状态规则（确定性）

| 状态 | 规则 | 允许策略 |
|---|---|---|
| 上涨/下跌趋势 | ADX(14) > 25 且 1h、4h EMA20 斜率同向 | 趋势跟随 |
| 震荡 | ADX(14) < 20 | 均值回归 |
| 高波动 | ATR(14)/价格 ≥ 过去 90 天 80 分位 | 不开新仓 |
| 低流动性 | 24h 成交量 < 30 日均值 50%，或价差 > 0.05% | 不开新仓 |
| 不明确 | 其余情况 | 不开新仓 |

判断顺序：低流动性 → 高波动 → 趋势 → 震荡 → 不明确。

## 自行部署

本项目基于 Surf SDK（Node.js + Express 后端，Vite + React 前端，Postgres 数据库）。

1. 安装 [Bun](https://bun.sh) 或 Node.js 20+
2. `cd backend && bun install`，`cd frontend && bun install`
3. 环境变量：
   - `SURF_API_KEY`：Surf 数据接口密钥（行情来源）
   - 数据库连接由 Surf SDK 管理（见 `@surf-ai/sdk/db`）
4. 启动后端：`cd backend && node server.js`；构建前端：`cd frontend && bun run build`
5. 定时任务由后端进程内置调度，进程需 7×24 在线（建议用 systemd / Docker / pm2 守护）

> 密钥只通过环境变量提供，切勿提交 `.env` 文件。
