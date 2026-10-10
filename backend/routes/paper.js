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
       FROM paper_orders WHERE ($2::text IS NULL OR status=$2) ORDER BY id DESC LIMIT $1`,
      [limit, req.query.status ? String(req.query.status) : null],
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

// 驾驶舱统计：收益、回撤、胜率、盈亏比、成本，按策略 / 币种拆分
const H1 = 3600_000
router.get(
  '/stats',
  wrap(async () => {
    await paper.load()
    const snap = paper.snapshot()
    const tr = (
      await dbQuery(`SELECT symbol, strategy, side, entry_ts::float8 AS entry_ts, exit_ts::float8 AS exit_ts, fees, slippage, funding, pnl, risk_amt FROM paper_trades ORDER BY exit_ts`)
    ).rows.map((r) => ({ ...r, entry_ts: Number(r.entry_ts), exit_ts: Number(r.exit_ts), fees: Number(r.fees || 0), slippage: Number(r.slippage || 0), funding: Number(r.funding || 0), pnl: Number(r.pnl), risk_amt: Number(r.risk_amt || 0) }))
    const eqRows = (await dbQuery(`SELECT ts::float8 AS ts, equity FROM paper_equity ORDER BY ts`)).rows.map((r) => ({ ts: Number(r.ts), equity: Number(r.equity) }))
    const start = snap.startingEquity
    const curve = [...eqRows]
    const t = Date.now()
    if (!curve.length || curve[curve.length - 1].ts < t - 60_000) curve.push({ ts: t, equity: snap.equity })
    let peak = start
    let mdd = 0
    const dd = curve.map((p) => {
      peak = Math.max(peak, p.equity)
      const v = ((peak - p.equity) / peak) * 100
      mdd = Math.max(mdd, v)
      return { ts: p.ts, dd: -v }
    })
    const group = (rows) => {
      const wins = rows.filter((x) => x.pnl > 0)
      const gw = wins.reduce((a, b) => a + b.pnl, 0)
      const gl = -rows.filter((x) => x.pnl <= 0).reduce((a, b) => a + b.pnl, 0)
      return {
        trades: rows.length,
        pnl: rows.reduce((a, b) => a + b.pnl, 0),
        winRatePct: rows.length ? (wins.length / rows.length) * 100 : null,
        profitFactor: gl ? gw / gl : gw ? null : null,
        avgR: rows.length ? rows.reduce((a, b) => a + (b.risk_amt ? b.pnl / b.risk_amt : 0), 0) / rows.length : null,
        avgHoldHours: rows.length ? rows.reduce((a, b) => a + (b.exit_ts - b.entry_ts), 0) / rows.length / H1 : null,
      }
    }
    const by = (key, labels = {}) => {
      const m = {}
      for (const r of tr) (m[r[key]] ||= []).push(r)
      return Object.entries(m).map(([k, rows]) => ({ key: k, label: labels[k] ?? k, ...group(rows) }))
    }
    const running = snap.startedAt ? (t - snap.startedAt) / 86400_000 : 0
    return {
      startedAt: snap.startedAt,
      runningDays: running,
      startingEquity: start,
      equity: snap.equity,
      totalReturnPct: (snap.equity / start - 1) * 100,
      maxDrawdownPct: mdd,
      overall: group(tr),
      costs: {
        fees: tr.reduce((a, b) => a + b.fees, 0) + snap.positions.reduce((a, p) => a + p.fees, 0),
        slippage: tr.reduce((a, b) => a + b.slippage, 0),
        funding: tr.reduce((a, b) => a + b.funding, 0) + snap.positions.reduce((a, p) => a + p.funding, 0),
      },
      byStrategy: by('strategy', Object.fromEntries(Object.values(STRATEGIES).map((x) => [x.name, x.label]))),
      bySymbol: by('symbol'),
      bySide: by('side', { long: '做多', short: '做空' }),
      curve,
      drawdown: dd,
    }
  }),
)

router.get(
  '/orders/:id',
  wrap(async (req, res) => {
    const { rows } = await dbQuery(`SELECT * FROM paper_orders WHERE id=$1`, [Number(req.params.id)])
    if (!rows.length) {
      res.status(404)
      return { error: '订单不存在' }
    }
    return { ...rows[0], statusLabel: orders.STATUS_LABEL[rows[0].status] }
  }),
)

// ===== 操作 =====
// 单实例运行：备用实例（另一个实例正在跑模拟盘）不接受操作，避免用过期的内存状态覆盖账户
router.use((req, res, next) => {
  if (req.method !== 'POST') return next()
  const runner = require('../lib/runner')
  if (runner.isLeader()) return next()
  const i = runner.info()
  if (!i.leaseHolder || i.leaseHolder === i.id) return next() // 还没有任何实例拿到租约（刚启动）：允许
  res.status(409).json({ ok: false, error: i.leaseSandbox === false ? '模拟盘正由线上实例运行，请到已发布的网站上操作（这里是开发预览，只读）' : '模拟盘正由另一个实例运行，这里只读' })
})
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
