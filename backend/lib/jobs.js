// 每小时任务：同步行情 → 计算市场状态 → 记录状态变化
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const feed = require('./feed')
const { computeRegime, LABELS } = require('./regime')

const BARS_1H = cfg.regime.volLookbackDays * 24 + 200
const BARS_4H = 300

async function regimeFor(symbol, opts = {}) {
  const [b1, b4] = await Promise.all([feed.loadBars(symbol, '1h', BARS_1H), feed.loadBars(symbol, '4h', BARS_4H)])
  return computeRegime(b1, b4, opts)
}

async function snapshotRegimes(spreads = {}) {
  const out = []
  for (const s of cfg.symbols) {
    const r = await regimeFor(s, { spreadPct: spreads[s] })
    const barTs = r.metrics?.barTs
    if (!barTs) continue
    const prev = await dbQuery('SELECT regime, bar_ts::float8 AS bar_ts FROM regime_snapshots WHERE symbol=$1 ORDER BY bar_ts DESC LIMIT 1', [s])
    const p = prev.rows[0]
    if (!p || Number(p.bar_ts) !== barTs) {
      await dbQuery('INSERT INTO regime_snapshots (symbol, bar_ts, regime, metrics) VALUES ($1,$2,$3,$4)', [
        s,
        barTs,
        r.regime,
        JSON.stringify({ ...r.metrics, reasons: r.reasons }),
      ])
      if (p && p.regime !== r.regime) {
        await feed.logEvent('info', 'regime_change', `${s} 市场状态：${LABELS[p.regime] ?? p.regime} → ${r.label}`, { reasons: r.reasons })
      }
    }
    out.push({ symbol: s, ...r })
  }
  return out
}

async function runHourly() {
  const sync = await feed.syncAll()
  const regimes = await snapshotRegimes()
  return { sync, regimes: regimes.map((r) => ({ symbol: r.symbol, regime: r.regime })) }
}

module.exports = { runHourly, regimeFor, snapshotRegimes }
