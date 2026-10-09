// 数据库表定义（Drizzle ORM）—— 后端启动时自动同步
const { pgTable, serial, text, bigint, doublePrecision, timestamp, jsonb, integer } = require('drizzle-orm/pg-core')

// 历史 K 线（只存已收盘的 K 线，防止未来数据泄露）
// id = `${symbol}:${interval}:${ts}`，保证同一根 K 线只存一次
exports.candles = pgTable('candles', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(), // 例如 BTC/USDT
  interval: text('interval').notNull(), // 1h / 4h
  ts: bigint('ts', { mode: 'number' }).notNull(), // K 线开盘时间，UTC 毫秒
  open: doublePrecision('open').notNull(),
  high: doublePrecision('high').notNull(),
  low: doublePrecision('low').notNull(),
  close: doublePrecision('close').notNull(),
  volume: doublePrecision('volume').notNull(),
})

// 市场状态快照（每次同步后计算一次，留存历史供回测/复盘对照）
exports.regime_snapshots = pgTable('regime_snapshots', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  bar_ts: bigint('bar_ts', { mode: 'number' }).notNull(), // 基于哪根已收盘 1h K 线
  regime: text('regime').notNull(), // trend_up / trend_down / range / high_vol / low_liquidity / unclear
  metrics: jsonb('metrics'),
  created_at: timestamp('created_at').defaultNow(),
})

// 系统事件 / 告警流水（后续交付中风控、下单、暂停事件也写在这里）
exports.events = pgTable('events', {
  id: serial('id').primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  level: text('level').notNull(), // info / warn / error
  type: text('type').notNull(), // data_sync / data_quality / regime_change / ...
  message: text('message').notNull(),
  detail: jsonb('detail'),
})

// 数据同步状态（每个标的+周期一行）
exports.sync_state = pgTable('sync_state', {
  id: text('id').primaryKey(), // `${symbol}:${interval}`
  last_ts: bigint('last_ts', { mode: 'number' }),
  last_run_at: bigint('last_run_at', { mode: 'number' }),
  candle_count: integer('candle_count'),
  gaps: integer('gaps'),
  status: text('status'),
  message: text('message'),
})

// 资金费率历史（OKX 公共接口，每小时累积）
exports.funding_rates = pgTable('funding_rates', {
  id: text('id').primaryKey(), // `${symbol}:${ts}`
  symbol: text('symbol').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  rate: doublePrecision('rate').notNull(),
})

// 回测记录
exports.backtest_runs = pgTable('backtest_runs', {
  id: serial('id').primaryKey(),
  created_at: timestamp('created_at').defaultNow(),
  status: text('status').notNull(), // running / done / error
  request: jsonb('request'),
  summary: jsonb('summary'),
  result: jsonb('result'),
  error: text('error'),
  duration_ms: integer('duration_ms'),
})

// ===== 第 3 次交付：模拟交易 =====
const { boolean } = require('drizzle-orm/pg-core')

// 模拟账户（单行 id='main'）：资金、峰值、日内基准、运行状态
exports.paper_account = pgTable('paper_account', {
  id: text('id').primaryKey(),
  status: text('status').notNull(), // running / stopped（紧急停止）/ locked（回撤锁定）
  status_reason: text('status_reason'),
  pause_keys: jsonb('pause_keys'), // 当前生效的自动暂停条件
  cash: doublePrecision('cash').notNull(),
  peak_equity: doublePrecision('peak_equity').notNull(),
  day_key: integer('day_key'),
  day_start_equity: doublePrecision('day_start_equity'),
  day_blocked: boolean('day_blocked'),
  enabled_strategies: jsonb('enabled_strategies'),
  disabled_strategies: jsonb('disabled_strategies'), // 因失效条件自动下线 { name: reason }
  last_bar_ts: bigint('last_bar_ts', { mode: 'number' }), // 已处理到哪根 K 线（防重复执行）
  last_heartbeat: bigint('last_heartbeat', { mode: 'number' }),
  last_cycle_at: bigint('last_cycle_at', { mode: 'number' }),
  started_at: bigint('started_at', { mode: 'number' }),
  updated_at: bigint('updated_at', { mode: 'number' }),
})

// 当前持仓
exports.paper_positions = pgTable('paper_positions', {
  symbol: text('symbol').primaryKey(),
  side: integer('side').notNull(), // 1 多 / -1 空
  qty: doublePrecision('qty').notNull(),
  entry_px: doublePrecision('entry_px').notNull(),
  entry_ts: bigint('entry_ts', { mode: 'number' }).notNull(),
  stop: doublePrecision('stop').notNull(),
  strategy: text('strategy').notNull(),
  params: jsonb('params'),
  regime: text('regime'),
  fees: doublePrecision('fees').notNull(),
  slippage: doublePrecision('slippage').notNull(),
  funding: doublePrecision('funding').notNull(),
  risk_amt: doublePrecision('risk_amt').notNull(),
  last_funding_ts: bigint('last_funding_ts', { mode: 'number' }),
})

// 订单（状态机：PENDING → SUBMITTED → FILLED / CANCELED / REJECTED / UNKNOWN）
exports.paper_orders = pgTable('paper_orders', {
  id: serial('id').primaryKey(),
  client_order_id: text('client_order_id').notNull().unique(), // 幂等键：重复提交不会下两次
  symbol: text('symbol').notNull(),
  side: integer('side').notNull(), // 1 买 / -1 卖
  intent: text('intent').notNull(), // open / close
  qty: doublePrecision('qty').notNull(),
  ref_px: doublePrecision('ref_px'),
  fill_px: doublePrecision('fill_px'),
  fee: doublePrecision('fee'),
  slippage: doublePrecision('slippage'),
  status: text('status').notNull(),
  reason: text('reason'),
  strategy: text('strategy'),
  signal_ts: bigint('signal_ts', { mode: 'number' }),
  history: jsonb('history'), // 状态变化记录
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  updated_at: bigint('updated_at', { mode: 'number' }),
})

// 已平仓交易
exports.paper_trades = pgTable('paper_trades', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  strategy: text('strategy').notNull(),
  side: text('side').notNull(),
  entry_ts: bigint('entry_ts', { mode: 'number' }).notNull(),
  entry_px: doublePrecision('entry_px').notNull(),
  exit_ts: bigint('exit_ts', { mode: 'number' }).notNull(),
  exit_px: doublePrecision('exit_px').notNull(),
  qty: doublePrecision('qty').notNull(),
  regime: text('regime'),
  reason: text('reason'),
  fees: doublePrecision('fees'),
  slippage: doublePrecision('slippage'),
  funding: doublePrecision('funding'),
  pnl: doublePrecision('pnl').notNull(),
  risk_amt: doublePrecision('risk_amt'),
})

// 每小时净值快照
exports.paper_equity = pgTable('paper_equity', {
  ts: bigint('ts', { mode: 'number' }).primaryKey(),
  equity: doublePrecision('equity').notNull(),
  cash: doublePrecision('cash').notNull(),
  unrealized: doublePrecision('unrealized'),
  exposure: doublePrecision('exposure'),
  drawdown_pct: doublePrecision('drawdown_pct'),
  positions: integer('positions'),
})

// 每小时决策记录：系统看到了什么、风控怎么判、做了什么
exports.paper_cycles = pgTable('paper_cycles', {
  id: serial('id').primaryKey(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  bar_ts: bigint('bar_ts', { mode: 'number' }),
  summary: jsonb('summary'),
})
