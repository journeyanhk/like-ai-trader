// /api/paper —— 模拟交易：状态、持仓、订单、决策记录、紧急停止
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const paper = require('../lib/paper')
const orders = require('../lib/orders')
const { STRATEGIES } = require('../lib/strategies')

const router = Router()

// 启动即对账（等数据库表同步完成后执行）
let booted = false
async function boot(tries = 0) {
  try {
    await paper.startup()
    booted = true
  } catch (e) {
    console.error('paper startup failed:', e.message)
    if (tries < 10) setTimeout(() => boot(tries + 1), 5000)
  }
}
setTimeout(() => boot(), 4000)

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
}

// 自动暂停条件触发统计（给验收用），缓存 60 秒
let pauseStats = { at: 0, value: {} }
async function getPauseStats() {
  if (Date.now() - pauseStats.at < 60_000) return pauseStats.value
  const { rows } = await dbQuery(
    `SELECT detail->>'key' AS key, COUNT(*)::int AS count, MAX(ts)::float8 AS last_ts FROM events WHERE type='auto_pause' GROUP BY 1`,
  )
  pauseStats = { at: Date.now(), value: Object.fromEntries(rows.map((r) => [r.key, { count: r.count, lastTs: Number(r.last_ts) }])) }
  return pauseStats.value
}

router.get(
  '/status',
  wrap(async () => {
    await paper.load()
    const snap = paper.snapshot()
    return { ...snap, booted, pauseStats: await getPauseStats() }
  }),
)

router.get(
  '/orders',
  wrap(async (req) => {
    const limit = Math.min(200, Number(req.query.limit) || 30)
    const { rows } = await dbQuery(
      `SELECT id, client_order_id, symbol, side, intent, qty, ref_px, fill_px, fee, slippage, status, reason, strategy,
              signal_ts::float8 AS signal_ts, history, created_at::float8 AS created_at, updated_at::float8 AS updated_at
       FROM paper_orders ORDER BY id DESC LIMIT $1`,
      [limit],
    )
    return rows.map((r) => ({ ...r, statusLabel: orders.STATUS_LABEL[r.status] ?? r.status, strategyLabel: STRATEGIES[r.strategy]?.label ?? r.strategy }))
  }),
)

router.get(
  '/trades',
  wrap(async (req) => {
    const limit = Math.min(500, Number(req.query.limit) || 50)
    const { rows } = await dbQuery(
      `SELECT id, symbol, strategy, side, entry_ts::float8 AS entry_ts, entry_px, exit_ts::float8 AS exit_ts, exit_px, qty, regime, reason, fees, slippage, funding, pnl, risk_amt
       FROM paper_trades ORDER BY exit_ts DESC LIMIT $1`,
      [limit],
    )
    return rows.map((r) => ({ ...r, strategyLabel: STRATEGIES[r.strategy]?.label ?? r.strategy }))
  }),
)

router.get(
  '/cycles',
  wrap(async (req) => {
    const limit = Math.min(100, Number(req.query.limit) || 12)
    const { rows } = await dbQuery(`SELECT id, ts::float8 AS ts, bar_ts::float8 AS bar_ts, summary FROM paper_cycles ORDER BY id DESC LIMIT $1`, [limit])
    return rows
  }),
)

router.get(
  '/equity',
  wrap(async () => {
    const { rows } = await dbQuery(
      `SELECT ts::float8 AS ts, equity, cash, unrealized, exposure, drawdown_pct, positions FROM paper_equity ORDER BY ts DESC LIMIT 5000`,
    )
    return rows.reverse()
  }),
)

// ===== 操作 =====
router.post(
  '/emergency-stop',
  wrap(async (req) => paper.emergencyStop(String(req.body?.note || '').slice(0, 200))),
)

router.post(
  '/resume',
  wrap(async (_req, res) => {
    const r = await paper.resume()
    if (!r.ok) res.status(409)
    return r
  }),
)

router.post(
  '/unlock',
  wrap(async (_req, res) => {
    const r = await paper.unlock()
    if (!r.ok) res.status(409)
    return r
  }),
)

router.post(
  '/strategy',
  wrap(async (req, res) => {
    const r = await paper.setStrategy(String(req.body?.name || ''), !!req.body?.enabled)
    if (!r.ok) res.status(400)
    return r
  }),
)

// 立即执行一次检查：风控巡检 + 每小时循环（同一根 K 线已处理过则只巡检，不会重复下单）
router.post(
  '/check-now',
  wrap(async () => {
    const checks = await paper.monitor()
    let cycle = null
    if (paper.needsCycle()) {
      const jobs = require('../lib/jobs')
      const r = await jobs.runHourly()
      cycle = await paper.runCycle(r.regimes)
    } else {
      cycle = await paper.runCycle(null)
    }
    return { checks, cycle }
  }),
)

module.exports = router
