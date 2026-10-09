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
