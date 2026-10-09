// 事件驱动回测（P0-1 起只是驱动器：开仓、止损、资金费、仓位计算全部调用 simulate.js，与模拟盘同一份实现）
// 防未来数据：信号只在 K 线收盘后产生，下一根 K 线开盘价成交；止损按之后 K 线的最高/最低价触发。
const cfg = require('./config')
const sim = require('./simulate')
const { H1, DAY } = sim

/**
 * data: { [symbol]: { bars, regimes, funding: Map<ts, rate> } }  —— bars/regimes 必须来自锚定历史（见 simulate.buildSeries）
 * opts: {
 *   strategies, paramsAt(name, ts), from, to,
 *   regimeFilter (默认 true), ddLock (默认 false), invalidation (默认 false：研究时不自动下线策略),
 *   closeAtEnd (默认 true：结束时按最后收盘价平仓), until ('close' | 'open'：最后一个时间戳只执行开盘阶段),
 *   cache (指标缓存)
 * }
 */
function runBacktest(data, opts) {
  const conf = opts.conf || cfg
  const symbols = Object.keys(data)
  const series = {}
  for (const s of symbols) series[s] = data[s].idx ? data[s] : { ...data[s], idx: new Map(data[s].bars.map((b, i) => [b.ts, i])) }
  const indicators = sim.indicatorCache(series, opts.cache || new Map())

  const tsSet = new Set()
  for (const s of symbols) for (const b of data[s].bars) if (b.ts >= opts.from && b.ts < opts.to) tsSet.add(b.ts)
  const timeline = [...tsSet].sort((a, b) => a - b)

  const st = sim.newState({ startEquity: opts.startEquity ?? conf.paperStartingEquity, startTs: timeline[0], enabled: opts.strategies, invalidation: !!opts.invalidation })
  const o = { symbols, paramsAt: opts.paramsAt, regimeFilter: opts.regimeFilter !== false, ddLock: !!opts.ddLock, conf }
  const openMkt = { open: {}, fundingRate: (s, ts) => data[s].funding.get(ts) ?? null }
  const closeMkt = { series, indicators }
  const hourly = []

  for (let k = 0; k < timeline.length; k++) {
    const ts = timeline[k]
    for (const s of symbols) openMkt.open[s] = series[s].bars[series[s].idx.get(ts)]?.open
    sim.barOpen(st, ts, openMkt, o)
    if (opts.until === 'open' && k === timeline.length - 1) break
    sim.barClose(st, ts, closeMkt, o)
    hourly.push({ ts, equity: sim.equity(st) })
  }

  if (opts.closeAtEnd !== false && timeline.length) {
    const endTs = timeline[timeline.length - 1]
    for (const s of Object.keys(st.positions)) sim.closeAtMarket(st, s, st.lastClose[s], endTs, '回测结束', 'end', conf)
    if (hourly.length) hourly[hourly.length - 1].equity = st.cash
  }

  const trades = st.trades.map((t) => ({
    symbol: t.symbol,
    strategy: t.strategy,
    side: t.side,
    entryTs: t.entry_ts,
    entryPx: t.entry_px,
    exitTs: t.exit_ts,
    exitPx: t.exit_px,
    qty: t.qty,
    regime: t.regime,
    reason: t.reason,
    fees: t.fees,
    slippage: t.slippage,
    funding: t.funding,
    pnl: t.pnl,
    riskAmt: t.risk_amt,
  }))
  const { fees, slippage, funding, fundingAssumed } = st.totals
  return { trades, hourly, totals: { fees, slippage, funding, fundingAssumed }, locked: st.locked, dailyLossDays: st.blockedDays, startEquity: st.startEquity, state: st }
}

// ===== 指标 =====
function dailyCurve(hourly) {
  const out = []
  let lastDay = null
  for (const h of hourly) {
    const d = Math.floor(h.ts / DAY)
    if (d !== lastDay) out.push({ ts: d * DAY, equity: h.equity })
    else out[out.length - 1].equity = h.equity
    lastDay = d
  }
  return out
}

function metrics(res) {
  const daily = dailyCurve(res.hourly)
  const start = res.startEquity
  const end = daily.length ? daily[daily.length - 1].equity : start
  const rets = []
  let prev = start
  for (const d of daily) {
    rets.push(d.equity / prev - 1)
    prev = d.equity
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1)
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1))
  const downside = Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / Math.max(1, rets.length - 1))
  let peak = start
  let mdd = 0
  for (const h of res.hourly) {
    peak = Math.max(peak, h.equity)
    mdd = Math.max(mdd, (peak - h.equity) / peak)
  }
  const days = Math.max(1, daily.length)
  const t = res.trades
  const wins = t.filter((x) => x.pnl > 0)
  const grossWin = wins.reduce((a, b) => a + b.pnl, 0)
  const grossLoss = -t.filter((x) => x.pnl <= 0).reduce((a, b) => a + b.pnl, 0)
  const avgHoldH = t.length ? t.reduce((a, b) => a + (b.exitTs - b.entryTs), 0) / t.length / H1 : 0
  return {
    totalReturnPct: (end / start - 1) * 100,
    annualReturnPct: ((end / start) ** (365 / days) - 1) * 100,
    sharpe: sd ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: downside ? (mean / downside) * Math.sqrt(365) : 0,
    maxDrawdownPct: mdd * 100,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? 99 : 0,
    winRatePct: t.length ? (wins.length / t.length) * 100 : 0,
    trades: t.length,
    avgHoldHours: avgHoldH,
    endEquity: end,
    days,
  }
}

module.exports = { runBacktest, metrics, dailyCurve }
