// 行情数据层：拉取 K 线、存储、数据质量检查
const okx = require('./okx') // 免费公开数据源，不消耗 Surf 点数
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')

const INTERVAL_MS = { '1h': 3600_000, '4h': 4 * 3600_000 }

let running = null // 同步锁，防止重复执行

async function logEvent(level, type, message, detail = null) {
  try {
    await dbQuery('INSERT INTO events (ts, level, type, message, detail) VALUES ($1,$2,$3,$4,$5)', [
      Date.now(),
      level,
      type,
      message,
      detail ? JSON.stringify(detail) : null,
    ])
  } catch (e) {
    console.error('logEvent failed', e.message)
  }
}

async function upsertCandles(symbol, interval, rows) {
  if (!rows.length) return
  const vals = []
  const params = []
  rows.forEach((c, k) => {
    const b = k * 9
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`)
    params.push(`${symbol}:${interval}:${c.ts}`, symbol, interval, c.ts, c.open, c.high, c.low, c.close, c.volume)
  })
  await dbQuery(
    `INSERT INTO candles (id, symbol, interval, ts, open, high, low, close, volume) VALUES ${vals.join(',')}
     ON CONFLICT (id) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume`,
    params,
  )
}

// 数据质量检查：缺口（时间不连续）、重复、乱序
async function qualityCheck(symbol, interval) {
  const step = INTERVAL_MS[interval]
  const { rows } = await dbQuery(
    `SELECT COUNT(*)::int AS n,
            MIN(ts)::float8 AS first_ts, MAX(ts)::float8 AS last_ts,
            SUM(CASE WHEN gap > $3 THEN 1 ELSE 0 END)::int AS gaps,
            SUM(CASE WHEN gap <= 0 THEN 1 ELSE 0 END)::int AS bad_order
     FROM (SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS gap FROM candles WHERE symbol=$1 AND interval=$2) t`,
    [symbol, interval, step],
  )
  const r = rows[0] || {}
  const invalid = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM candles WHERE symbol=$1 AND interval=$2
     AND (high < low OR close > high OR close < low OR open > high OR open < low OR volume < 0)`,
    [symbol, interval],
  )
  return {
    count: r.n ?? 0,
    firstTs: r.first_ts ?? null,
    lastTs: r.last_ts ?? null,
    gaps: r.gaps ?? 0,
    badOrder: r.bad_order ?? 0,
    invalidBars: invalid.rows[0]?.n ?? 0,
  }
}

async function syncOne(symbol, interval) {
  const step = INTERVAL_MS[interval]
  const now = Date.now()
  const { rows } = await dbQuery('SELECT MAX(ts)::float8 AS last FROM candles WHERE symbol=$1 AND interval=$2', [symbol, interval])
  const since = rows[0]?.last ? rows[0].last + step : now - cfg.historyDays * 86400_000
  const closed = (await okx.candlesSince(symbol, interval, since)).filter((c) => c.ts + step <= now)
  for (let k = 0; k < closed.length; k += 500) await upsertCandles(symbol, interval, closed.slice(k, k + 500))
  let added = closed.length
  // 向前回补：历史不足 historyDays 时补齐更早的数据
  const target = now - cfg.historyDays * 86400_000
  const first = await dbQuery('SELECT MIN(ts)::float8 AS first FROM candles WHERE symbol=$1 AND interval=$2', [symbol, interval])
  const firstTs = first.rows[0]?.first
  if (firstTs && firstTs - target > step * 2) {
    const older = await okx.candlesSince(symbol, interval, target, firstTs)
    for (let k = 0; k < older.length; k += 500) await upsertCandles(symbol, interval, older.slice(k, k + 500))
    added += older.length
  }
  const q = await qualityCheck(symbol, interval)
  const status = q.gaps || q.badOrder || q.invalidBars ? 'warn' : 'ok'
  const message =
    status === 'ok' ? '数据完整' : `发现 ${q.gaps} 处缺口、${q.badOrder} 处乱序/重复、${q.invalidBars} 根异常 K 线`
  await dbQuery(
    `INSERT INTO sync_state (id, last_ts, last_run_at, candle_count, gaps, status, message) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET last_ts=EXCLUDED.last_ts, last_run_at=EXCLUDED.last_run_at, candle_count=EXCLUDED.candle_count,
     gaps=EXCLUDED.gaps, status=EXCLUDED.status, message=EXCLUDED.message`,
    [`${symbol}:${interval}`, q.lastTs, Date.now(), q.count, q.gaps, status, message],
  )
  if (status !== 'ok') await logEvent('warn', 'data_quality', `${symbol} ${interval}：${message}`, q)
  return { symbol, interval, added, ...q, status }
}

async function syncFunding(symbol) {
  const { rows } = await dbQuery('SELECT MAX(ts)::float8 AS last FROM funding_rates WHERE symbol=$1', [symbol])
  const since = rows[0]?.last ? rows[0].last + 1 : 0
  const list = await okx.fundingHistory(symbol, since)
  for (let k = 0; k < list.length; k += 500) {
    const part = list.slice(k, k + 500)
    const vals = part.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`).join(',')
    const params = part.flatMap((f) => [`${symbol}:${f.ts}`, symbol, f.ts, f.rate])
    await dbQuery(`INSERT INTO funding_rates (id, symbol, ts, rate) VALUES ${vals} ON CONFLICT (id) DO NOTHING`, params)
  }
  return list.length
}

async function loadFunding(symbol) {
  const rows = []
  let after = -1
  for (;;) {
    const r = await dbQuery('SELECT ts::float8 AS ts, rate FROM funding_rates WHERE symbol=$1 AND ts > $2 ORDER BY ts LIMIT 5000', [symbol, after])
    rows.push(...r.rows)
    if (r.rows.length < 5000) break
    after = Number(r.rows[r.rows.length - 1].ts)
  }
  return rows.map((r) => ({ ts: Number(r.ts), rate: Number(r.rate) }))
}

async function syncAll() {
  if (running) return running
  running = (async () => {
    const results = []
    for (const s of cfg.symbols) {
      for (const iv of [cfg.mainInterval, cfg.confirmInterval]) {
        try {
          results.push(await syncOne(s, iv))
        } catch (e) {
          results.push({ symbol: s, interval: iv, error: e.message })
          await logEvent('error', 'data_sync', `${s} ${iv} 行情同步失败：${e.message}`)
        }
      }
    }
    for (const s of cfg.symbols) {
      try {
        await syncFunding(s)
      } catch (e) {
        await logEvent('warn', 'data_sync', `${s} 资金费率同步失败：${e.message}`)
      }
    }
    const added = results.reduce((a, r) => a + (r.added || 0), 0)
    if (added > 0) await logEvent('info', 'data_sync', `行情同步完成，新增 ${added} 根 K 线`, results)
    return results
  })()
  try {
    return await running
  } finally {
    running = null
  }
}

// 数据库单次最多返回 5000 行，按时间分页读取
async function loadBars(symbol, interval, limit) {
  const out = []
  let before = Number.MAX_SAFE_INTEGER
  while (out.length < limit) {
    const n = Math.min(5000, limit - out.length)
    const { rows } = await dbQuery(
      `SELECT ts::float8 AS ts, open, high, low, close, volume FROM candles WHERE symbol=$1 AND interval=$2 AND ts < $3 ORDER BY ts DESC LIMIT $4`,
      [symbol, interval, before, n],
    )
    for (const r of rows) out.push(r)
    if (rows.length < n) break
    before = Number(rows[rows.length - 1].ts)
  }
  return out.reverse().map((r) => ({
    ts: Number(r.ts),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }))
}

// 按时间区间读取（锚定历史用）：ts ∈ [fromTs, toTs)，升序
async function loadBarsRange(symbol, interval, fromTs, toTs = Number.MAX_SAFE_INTEGER) {
  const out = []
  let after = fromTs - 1
  for (;;) {
    const { rows } = await dbQuery(
      `SELECT ts::float8 AS ts, open, high, low, close, volume FROM candles WHERE symbol=$1 AND interval=$2 AND ts > $3 AND ts < $4 ORDER BY ts LIMIT 5000`,
      [symbol, interval, after, toTs],
    )
    for (const r of rows) out.push({ ts: Number(r.ts), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) })
    if (rows.length < 5000) break
    after = out[out.length - 1].ts
  }
  return out
}

async function loadFundingRange(symbol, fromTs, toTs = Number.MAX_SAFE_INTEGER) {
  const r = await dbQuery('SELECT ts::float8 AS ts, rate FROM funding_rates WHERE symbol=$1 AND ts >= $2 AND ts < $3 ORDER BY ts LIMIT 5000', [symbol, fromTs, toTs])
  return r.rows.map((x) => ({ ts: Number(x.ts), rate: Number(x.rate) }))
}

module.exports = { loadBarsRange, loadFundingRange, syncAll, syncOne, loadBars, loadFunding, logEvent, isSyncing: () => !!running, INTERVAL_MS }
