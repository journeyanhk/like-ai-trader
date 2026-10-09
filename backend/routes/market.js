// /api/market —— 行情看板数据
const { Router } = require('express')
const okx = require('../lib/okx') // 免费公开数据源，不消耗 Surf 点数
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('../lib/config')
const feed = require('../lib/feed')
const ind = require('../lib/indicators')
const jobs = require('../lib/jobs')

const router = Router()

// 简单内存缓存，避免每次刷新都重复请求
const cache = new Map()
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

// 数据健康检查（对应设计文档里的自动暂停条件，此阶段只显示不拦截）
function healthChecks(live, lastBarTs) {
  const now = Date.now()
  const checks = []
  const age = live.tickerTs ? (now - live.tickerTs) / 1000 : null
  checks.push({
    key: 'stale',
    label: '实时行情新鲜度',
    ok: age != null && age <= cfg.staleDataSeconds,
    detail: age == null ? '未取到行情' : `${Math.round(age)} 秒前更新（阈值 ${cfg.staleDataSeconds} 秒）`,
  })
  const dev = live.price && live.indexPrice ? (Math.abs(live.price - live.indexPrice) / live.indexPrice) * 100 : null
  checks.push({
    key: 'deviation',
    label: '两个价格源偏差',
    ok: dev != null && dev <= cfg.priceSourceMaxDeviationPct,
    detail: dev == null ? '无法比较' : `合约成交价 vs 多交易所指数价 相差 ${dev.toFixed(3)}%（阈值 ${cfg.priceSourceMaxDeviationPct}%）`,
  })
  const barAge = lastBarTs ? (now - (lastBarTs + 3600_000)) / 60000 : null
  checks.push({
    key: 'bars',
    label: 'K 线是否最新',
    ok: barAge != null && barAge < 75,
    detail: barAge == null ? '尚无 K 线数据' : `最新已收盘 K 线是 ${Math.max(0, Math.round(barAge))} 分钟前`,
  })
  checks.push({
    key: 'api',
    label: '数据接口',
    ok: live.errors.length === 0,
    detail: live.errors.length ? live.errors.join('；') : '正常',
  })
  return checks
}

let backfillStarted = false
function ensureFresh(lastBarTs) {
  const stale = !lastBarTs || Date.now() - (lastBarTs + 3600_000) > 75 * 60_000
  if (stale && !feed.isSyncing()) {
    backfillStarted = true
    jobs.runHourly().catch((e) => console.error('background sync failed', e.message))
  }
  return stale
}

router.get('/overview', async (_req, res) => {
  try {
    const fearGreed = await cached('fg', 10 * 60_000, async () => {
      return okx.fearGreed(31).catch(() => [])
    })

    const symbols = await Promise.all(
      cfg.symbols.map(async (symbol) => {
        const live = await cached(`live:${symbol}`, 15_000, () => okx.snapshot(symbol))
        const regime = await jobs.regimeFor(symbol, { spreadPct: live.spreadPct })
        const lastBarTs = regime.metrics?.barTs ?? null
        return { symbol, live, regime, checks: healthChecks(live, lastBarTs), lastBarTs }
      }),
    )
    const syncing = ensureFresh(Math.min(...symbols.map((s) => s.lastBarTs ?? 0)) || null) || feed.isSyncing()

    res.json({ mode: cfg.mode, exchange: cfg.exchange, updatedAt: Date.now(), syncing, fearGreed, symbols })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// K 线 + 均线，用于图表
router.get('/candles', async (req, res) => {
  try {
    const symbol = cfg.symbols.includes(req.query.symbol) ? req.query.symbol : cfg.symbols[0]
    const interval = req.query.interval === '4h' ? '4h' : '1h'
    const limit = Math.min(Math.max(Number(req.query.limit) || 240, 30), 1500)
    const bars = await feed.loadBars(symbol, interval, limit + 60)
    const closes = bars.map((b) => b.close)
    const ema20 = ind.ema(closes, 20)
    const { adx } = ind.adx(bars, 14)
    const start = Math.max(0, bars.length - limit)
    res.json({
      symbol,
      interval,
      bars: bars.slice(start).map((b, k) => ({ ...b, ema20: ema20[start + k], adx: adx[start + k] })),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 市场状态历史
router.get('/regime-history', async (req, res) => {
  try {
    const symbol = cfg.symbols.includes(req.query.symbol) ? req.query.symbol : cfg.symbols[0]
    const { rows } = await dbQuery(
      `SELECT bar_ts::float8 AS ts, regime FROM regime_snapshots WHERE symbol=$1 ORDER BY bar_ts DESC LIMIT 200`,
      [symbol],
    )
    res.json(rows.map((r) => ({ ts: Number(r.ts), regime: r.regime })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 数据仓库状态
router.get('/data-status', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT id, last_ts::float8 AS last_ts, last_run_at::float8 AS last_run_at, candle_count, gaps, status, message FROM sync_state ORDER BY id`,
    )
    const first = await dbQuery(`SELECT symbol, interval, MIN(ts)::float8 AS first_ts FROM candles GROUP BY symbol, interval`)
    const firstMap = Object.fromEntries(first.rows.map((r) => [`${r.symbol}:${r.interval}`, Number(r.first_ts)]))
    res.json({
      syncing: feed.isSyncing() || backfillStarted && rows.length < cfg.symbols.length * 2,
      items: rows.map((r) => ({
        id: r.id,
        firstTs: firstMap[r.id] ?? null,
        lastTs: r.last_ts != null ? Number(r.last_ts) : null,
        lastRunAt: r.last_run_at != null ? Number(r.last_run_at) : null,
        count: r.candle_count,
        gaps: r.gaps,
        status: r.status,
        message: r.message,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 事件流水：?types=a,b&levels=warn,error&before=<ts>&limit=50
router.get('/events', async (req, res) => {
  try {
    const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean)
    const types = list(req.query.types)
    const levels = list(req.query.levels)
    const before = Number(req.query.before) || null
    const limit = Math.min(200, Number(req.query.limit) || 50)
    const { rows } = await dbQuery(
      `SELECT id, ts::float8 AS ts, level, type, message FROM events
       WHERE ($1::text[] IS NULL OR type = ANY($1)) AND ($2::text[] IS NULL OR level = ANY($2)) AND ($3::bigint IS NULL OR ts < $3)
       ORDER BY ts DESC, id DESC LIMIT $4`,
      [types.length ? types : null, levels.length ? levels : null, before, limit],
    )
    res.json(rows.map((r) => ({ ...r, ts: Number(r.ts) })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 事件统计（驾驶舱告警角标）：最近 24 小时各级别数量
router.get('/events/summary', async (_req, res) => {
  try {
    const { rows } = await dbQuery(`SELECT level, COUNT(*)::int AS c FROM events WHERE ts > $1 GROUP BY level`, [Date.now() - 86400_000])
    const { rows: types } = await dbQuery(`SELECT type, COUNT(*)::int AS c FROM events GROUP BY type ORDER BY c DESC`)
    res.json({ last24h: Object.fromEntries(rows.map((r) => [r.level, r.c])), types })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 手动触发同步
router.post('/sync', async (_req, res) => {
  if (feed.isSyncing()) return res.json({ started: false, message: '正在同步中' })
  jobs.runHourly().catch((e) => console.error('manual sync failed', e.message))
  res.json({ started: true })
})

module.exports = router
