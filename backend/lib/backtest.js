// 事件驱动回测引擎
// 关键约束（防未来数据）：信号只在 K 线收盘后产生，下一根 K 线开盘价成交；
// 止损在之后的 K 线内按最高/最低价触发；全部计入手续费、滑点、资金费率。
// 风控与第 3 次交付的模拟盘使用同一组参数：单笔风险 0.5%、日亏 2% 停开新仓、敞口上限、可选 10% 回撤锁定。
const cfg = require('./config')
const { STRATEGIES } = require('./strategies')

const H1 = 3600_000
const H8 = 8 * H1
const DAY = 86400_000

/**
 * data: { [symbol]: { bars, regimes, funding: Map<ts, rate> } }
 * opts: {
 *   strategies: ['trend_following', ...],
 *   paramsAt: (name, ts) => params,   // 滚动验证时按时间切换参数
 *   from, to,                          // 回测区间（ms）
 *   regimeFilter: true,                // 是否按市场状态过滤
 *   ddLock: false,                     // 是否模拟 10% 回撤锁定
 *   keepTrades / keepCurve
 * }
 */
function runBacktest(data, opts) {
  const risk = cfg.risk
  const costs = cfg.costs
  const fee = costs.takerPct / 100
  const slip = costs.slippageBps / 10000
  const assumedFunding = costs.assumedFundingPct8h / 100
  const startEquity = cfg.paperStartingEquity
  const symbols = Object.keys(data)

  // 指标缓存：同一组参数只算一次
  const xCache = opts.cache || new Map()
  const indicatorsFor = (sym, name, p) => {
    const key = `${sym}|${name}|${JSON.stringify(p)}`
    let x = xCache.get(key)
    if (!x) {
      x = STRATEGIES[name].prepare(data[sym].bars, p)
      xCache.set(key, x)
    }
    return x
  }

  // 统一时间轴
  const idx = {}
  const tsSet = new Set()
  for (const s of symbols) {
    idx[s] = new Map(data[s].bars.map((b, i) => [b.ts, i]))
    for (const b of data[s].bars) if (b.ts >= opts.from && b.ts < opts.to) tsSet.add(b.ts)
  }
  const timeline = [...tsSet].sort((a, b) => a - b)

  let cash = startEquity
  const pos = {} // symbol -> position
  const pending = {} // symbol -> { type: 'entry'|'exit', ... }
  const trades = []
  const hourly = []
  const totals = { fees: 0, slippage: 0, funding: 0, fundingAssumed: 0 }
  let peak = startEquity
  let dayKey = null
  let dayStartEq = startEquity
  let locked = null
  const blockedDays = new Set()
  let lastBar = {}

  const unreal = () => symbols.reduce((u, s) => (pos[s] ? u + pos[s].side * pos[s].qty * (lastBar[s].close - pos[s].entryPx) : u), 0)
  const notionalOpen = (except) =>
    symbols.reduce((n, s) => (pos[s] && s !== except ? n + pos[s].qty * lastBar[s].close : n), 0)

  const closePos = (s, px, ts, reason, refPx) => {
    const p = pos[s]
    const f = p.qty * px * fee
    const gross = p.side * p.qty * (px - p.entryPx)
    cash += gross - f
    totals.fees += f
    totals.slippage += p.qty * Math.abs(px - refPx)
    p.fees += f
    p.slip += p.qty * Math.abs(px - refPx)
    trades.push({
      symbol: s,
      strategy: p.strategy,
      side: p.side > 0 ? 'long' : 'short',
      entryTs: p.entryTs,
      entryPx: p.entryPx,
      exitTs: ts,
      exitPx: px,
      qty: p.qty,
      regime: p.regime,
      reason,
      fees: p.fees,
      slippage: p.slip,
      funding: p.funding,
      pnl: gross - p.fees - p.funding, // 净盈亏（开仓手续费已在开仓时从现金扣除，这里汇总展示）
      riskAmt: p.riskAmt,
    })
    delete pos[s]
  }

  for (const ts of timeline) {
    // 新的一天：重置日亏统计
    const dk = Math.floor(ts / DAY)
    if (dk !== dayKey) {
      dayKey = dk
      dayStartEq = cash + (Object.keys(lastBar).length ? unreal() : 0)
    }

    for (const s of symbols) {
      const i = idx[s].get(ts)
      if (i == null) continue
      const b = data[s].bars[i]

      // 1) 执行上一根 K 线收盘时挂出的指令（本根开盘价成交）
      const pd = pending[s]
      if (pd) {
        delete pending[s]
        if (pd.type === 'exit' && pos[s]) {
          const px = b.open * (1 - pos[s].side * slip)
          closePos(s, px, ts, pd.reason, b.open)
        } else if (pd.type === 'entry' && !pos[s] && !locked) {
          const px = b.open * (1 + pd.side * slip)
          const dist = Math.abs(px - pd.stop)
          const wrongSide = pd.side > 0 ? px <= pd.stop : px >= pd.stop
          if (!wrongSide && dist > 0) {
            const equity = cash + unreal()
            const riskAmt = equity * (risk.riskPerTradePct / 100)
            let qty = riskAmt / dist
            // 敞口上限：单标的 50%，总敞口 100%（BTC/ETH 视为同一组合并计算）
            const capSym = equity * (risk.maxSymbolExposurePct / 100)
            const capTotal = equity * (risk.maxGrossExposurePct / 100) - notionalOpen(s)
            const maxNotional = Math.max(0, Math.min(capSym, capTotal, equity * risk.maxLeverage))
            qty = Math.min(qty, maxNotional / px)
            if (qty * px > equity * 0.01) {
              const f = qty * px * fee
              cash -= f
              totals.fees += f
              totals.slippage += qty * Math.abs(px - b.open)
              pos[s] = {
                side: pd.side,
                qty,
                entryPx: px,
                entryTs: ts,
                entryIdx: i,
                stop: pd.stop,
                strategy: pd.strategy,
                params: pd.params,
                regime: pd.regime,
                fees: f,
                slip: qty * Math.abs(px - b.open),
                funding: 0,
                riskAmt: qty * dist,
              }
            }
          }
        }
      }

      // 2) 资金费率：在结算时刻持有仓位则支付/收取
      if (pos[s] && ts % H8 === 0) {
        const p = pos[s]
        const rate = data[s].funding.get(ts)
        let cost
        if (rate != null) {
          cost = p.side * p.qty * b.open * rate // 正费率：多头付钱
        } else {
          cost = Math.abs(p.qty * b.open * assumedFunding) // 无历史：保守按成本计
          totals.fundingAssumed += cost
        }
        cash -= cost
        totals.funding += cost
        p.funding += cost
      }

      // 3) 盘中止损
      if (pos[s]) {
        const p = pos[s]
        const hit = p.side > 0 ? b.low <= p.stop : b.high >= p.stop
        if (hit) {
          const ref = p.side > 0 ? Math.min(b.open, p.stop) : Math.max(b.open, p.stop) // 跳空时按开盘价
          closePos(s, ref * (1 - p.side * slip), ts, '止损', ref)
          delete pending[s]
        }
      }
      lastBar[s] = b
    }

    // 4) 收盘：记录权益、风控检查
    const equity = cash + unreal()
    peak = Math.max(peak, equity)
    hourly.push({ ts, equity })
    const dayLossHit = (equity - dayStartEq) / dayStartEq <= -risk.dailyLossLimitPct / 100
    if (opts.ddLock && !locked && equity <= peak * (1 - risk.maxDrawdownPct / 100)) {
      locked = { ts, equity }
      for (const s of symbols) if (pos[s]) pending[s] = { type: 'exit', reason: '回撤 10% 风控锁定' }
    }

    // 5) 收盘后生成信号（下一根开盘执行）
    for (const s of symbols) {
      const i = idx[s].get(ts)
      if (i == null || pending[s]) continue
      const bars = data[s].bars
      const regime = data[s].regimes[i]
      if (pos[s]) {
        const p = pos[s]
        const st = STRATEGIES[p.strategy]
        const ctx = { bars, x: indicatorsFor(s, p.strategy, p.params), p: p.params, regime, filter: opts.regimeFilter }
        const ex = st.exit(i, p, ctx)
        if (ex) pending[s] = { type: 'exit', reason: ex.reason }
        continue
      }
      if (locked) continue
      if (dayLossHit) {
        blockedDays.add(dayKey)
        continue
      }
      for (const name of opts.strategies) {
        const allowed = cfg.allowedStrategies[regime] || []
        if (opts.regimeFilter && !allowed.includes(name)) continue
        const p = opts.paramsAt(name, ts)
        const sig = STRATEGIES[name].entry(i, { bars, x: indicatorsFor(s, name, p), p, regime, filter: opts.regimeFilter })
        if (sig) {
          pending[s] = { type: 'entry', side: sig.side, stop: sig.stop, strategy: name, params: p, regime }
          break
        }
      }
    }
  }

  // 结束时按最后收盘价平掉所有仓位（不计滑点之外的额外成本）
  const endTs = timeline[timeline.length - 1]
  for (const s of symbols) if (pos[s]) closePos(s, lastBar[s].close * (1 - pos[s].side * slip), endTs, '回测结束', lastBar[s].close)
  if (hourly.length) hourly[hourly.length - 1].equity = cash

  return { trades, hourly, totals, locked, dailyLossDays: blockedDays.size, startEquity }
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
