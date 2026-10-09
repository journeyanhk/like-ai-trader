// 共用模拟撮合引擎（P0-1）
// 回测（backtest.js）与模拟盘（paper.js）只调用这里，开仓、止损、资金费结算、仓位计算都只有这一份实现。
//
// 时间约定（两边完全一致）：
//   barOpen(ts)  —— K 线 ts 开盘时刻：
//       ① 新的一天（UTC）重置日内基准
//       ② 资金费：若 ts 是结算时刻（UTC 0/8/16 点），先给「已持有」的仓位结算（按本根开盘价估算名义价值）
//       ③ 执行上一根收盘产生的离场指令（开盘价 ± 滑点）
//       ④ 计算一次权益（之后整个标的循环共用这一个数）
//       ⑤ 执行上一根收盘产生的开仓指令：风控审核 risk.evaluateEntry → 仓位 risk.sizePosition → 合约取整
//   barClose(ts) —— K 线 ts 收盘时刻：
//       ① 止损：按本根最高/最低价判断，成交价 = 止损价；若开盘就已跳空越过止损，按开盘价成交
//       ② 记录收盘价、更新峰值、日亏停手（当天持续有效）、回撤锁定
//       ③ 持仓：策略离场 / 移动止损 → 挂到下一根开盘执行
//       ④ 空仓：按市场状态与已启用策略出入场信号 → 挂到下一根开盘执行
//   回测：对每个 ts 依次调用 barOpen(ts)、barClose(ts)
//   模拟盘：每小时收盘后调用 barClose(刚收盘的 K 线)、barOpen(当前 K 线)，序列与回测相同
const cfg = require('./config')
const risk = require('./risk')
const { STRATEGIES } = require('./strategies')
const { regimeSeries } = require('./regime')

const H1 = 3600_000
const H8 = 8 * H1
const DAY = 86400_000
const dayKeyOf = (ts) => Math.floor(ts / DAY)

function costsOf(conf = cfg) {
  return {
    fee: conf.costs.takerPct / 100,
    slip: conf.costs.slippageBps / 10000,
    stopSlip: (conf.costs.stopSlippageBps ?? 0) / 10000,
    assumed: conf.costs.assumedFundingPct8h / 100,
  }
}

// ---------- 锚定历史：两边用同一段 K 线计算指标与市场状态 ----------
/** 由 1h/4h K 线构建序列；prev 为上次结果时只重算最后 24 根以后的市场状态（增量，结果与全量一致） */
function buildSeries(bars1h, bars4h, prev = null) {
  const from = prev ? Math.max(0, Math.min(prev.regimes.length, bars1h.length) - 24) : 0
  const r = regimeSeries(bars1h, bars4h, { from }).regime
  const regimes = prev ? [...prev.regimes.slice(0, from), ...r.slice(from)] : r
  return { bars: bars1h, bars4h, regimes, idx: new Map(bars1h.map((b, i) => [b.ts, i])) }
}

/** 策略指标缓存：同一组参数只算一次 */
function indicatorCache(series, cache = new Map()) {
  return (sym, name, p) => {
    const key = `${sym}|${name}|${JSON.stringify(p)}`
    let x = cache.get(key)
    if (!x) {
      x = STRATEGIES[name].prepare(series[sym].bars, p)
      cache.set(key, x)
    }
    return x
  }
}

// ---------- 状态 ----------
function newState({ startEquity = cfg.paperStartingEquity, startTs = null, enabled = [], invalidation = true, log = false } = {}) {
  return {
    startEquity,
    cash: startEquity,
    positions: {}, // symbol -> { symbol, side, qty, entry_px, entry_ts, stop, strategy, params, regime, fees, slippage, funding, risk_amt, last_funding_ts }
    pending: {}, // symbol -> { type: 'entry'|'exit', ... } 下一根开盘执行
    lastClose: {},
    peak: startEquity,
    dayKey: startTs != null ? dayKeyOf(startTs) : null,
    dayStartEq: startEquity,
    dayBlocked: false,
    status: 'running', // running / locked / stopped
    statusReason: null,
    locked: null,
    enabled: [...enabled],
    disabled: {},
    invalidation,
    stratStats: {}, // 策略失效统计 name -> { firstTs, n, recent: [pnl...] }
    totals: { fees: 0, slippage: 0, funding: 0, fundingAssumed: 0, realized: 0 },
    blockedDays: 0,
    lastOpenTs: null,
    lastCloseTs: null,
    seq: 0,
    fills: [],
    rejects: [], // 合约取整后不足最小下单量而放弃的开仓（原因）
    trades: [],
    fundings: [],
    logOn: log,
    log: [],
  }
}

function note(st, ts, symbol, level, type, msg, detail = null) {
  if (st.logOn) st.log.push({ ts, symbol, level, type, msg, detail })
}

function unrealized(st, marks = st.lastClose) {
  let u = 0
  for (const p of Object.values(st.positions)) u += p.side * p.qty * ((marks[p.symbol] ?? p.entry_px) - p.entry_px)
  return u
}
const equity = (st, marks) => st.cash + unrealized(st, marks)

/** 六个对账字段 */
function ledger(st, marks) {
  const u = unrealized(st, marks)
  return { cash: st.cash, realized_pnl: st.totals.realized, funding_pnl: -st.totals.funding, fees_paid: st.totals.fees, unrealized: u, equity: st.cash + u }
}

// ---------- 合约取整（P1-1：OKX ctVal / lotSz / minSz）----------
// 币数量 → 张数 = qty / ctVal，向下取整到 lotSz 的整数倍（只会变小，不会超出风控算出的仓位）；
// 取整后张数 < minSz → 不交易，返回原因。
const dec = (x) => (String(x).split('.')[1] || '').length
function roundQty(symbol, qty, px, conf = cfg) {
  const c = conf.contracts?.[symbol]
  if (!c) return { qty: 0, contracts: null, check: { key: 'contract', label: '合约规格', ok: false, detail: `没有 ${symbol} 的合约规格（ctVal/lotSz/minSz），不交易` } }
  const lots = Math.floor(qty / c.ctVal / c.lotSz + 1e-9)
  const contracts = Number((lots * c.lotSz).toFixed(dec(c.lotSz)))
  const q = Number((contracts * c.ctVal).toFixed(dec(c.lotSz) + dec(c.ctVal)))
  const raw = qty / c.ctVal
  if (contracts < c.minSz) {
    return { qty: 0, contracts, check: { key: 'contract', label: '合约最小下单量', ok: false, detail: `需要 ${raw.toPrecision(4)} 张，取整后 ${contracts} 张 < 最小 ${c.minSz} 张（1 张 = ${c.ctVal} ${symbol.split('/')[0]}），不交易` } }
  }
  return { qty: q, contracts, check: { key: 'contract', label: '合约取整', ok: true, detail: `${raw.toPrecision(6)} 张 → ${contracts} 张（每张 ${c.ctVal}，步长 ${c.lotSz}）= ${q} ${symbol.split('/')[0]}` } }
}

// ---------- 成交原语 ----------
function openPos(st, { symbol, side, qty, px, ref, ts, stop, strategy, params, regime, riskAmt, signalTs, source }, conf = cfg) {
  const { fee: FEE } = costsOf(conf)
  const fee = qty * px * FEE
  const slippage = qty * Math.abs(px - ref)
  st.cash -= fee
  st.totals.fees += fee
  st.totals.slippage += slippage
  const p = { symbol, side, qty, entry_px: px, entry_ts: ts, stop, strategy, params, regime, fees: fee, slippage, funding: 0, risk_amt: riskAmt, last_funding_ts: ts }
  st.positions[symbol] = p
  st.fills.push({ seq: ++st.seq, ts, symbol, intent: 'open', side, qty, px, ref_px: ref, fee, slippage, reason: '策略入场', strategy, source: source ?? strategy, signal_ts: signalTs })
  return p
}

function closePos(st, symbol, { px, ref, ts, reason, source, signalTs }, conf = cfg) {
  const p = st.positions[symbol]
  if (!p) return null
  const { fee: FEE } = costsOf(conf)
  const fee = p.qty * px * FEE
  const slippage = p.qty * Math.abs(px - ref)
  const gross = p.side * p.qty * (px - p.entry_px)
  st.cash += gross - fee
  st.totals.realized += gross
  st.totals.fees += fee
  st.totals.slippage += slippage
  const fees = p.fees + fee
  const trade = {
    symbol,
    strategy: p.strategy,
    side: p.side > 0 ? 'long' : 'short',
    entry_ts: p.entry_ts,
    entry_px: p.entry_px,
    exit_ts: ts,
    exit_px: px,
    qty: p.qty,
    regime: p.regime,
    reason,
    fees,
    slippage: p.slippage + slippage,
    funding: p.funding,
    pnl: gross - fees - p.funding,
    risk_amt: p.risk_amt,
    params: p.params,
  }
  st.trades.push(trade)
  st.fills.push({ seq: ++st.seq, ts, symbol, intent: 'close', side: -p.side, qty: p.qty, px, ref_px: ref, fee, slippage, reason, strategy: p.strategy, source, signal_ts: signalTs })
  delete st.positions[symbol]
  delete st.pending[symbol]
  checkInvalidation(st, trade, conf)
  return trade
}

function checkInvalidation(st, trade, conf) {
  const s = (st.stratStats[trade.strategy] ??= { firstTs: trade.entry_ts, n: 0, recent: [] })
  s.n++
  s.recent = [...s.recent, trade.pnl].slice(-conf.paper.invalidationTrades)
  if (!st.invalidation || st.disabled[trade.strategy]) return
  // P1-3：累计 ≥20 笔 且 自该策略第一笔开仓起 ≥30 天，才评估最近 20 笔盈亏比
  const r = risk.strategyInvalidation(s.recent.map((pnl) => ({ pnl })), conf, { total: s.n, days: (trade.exit_ts - s.firstTs) / DAY })
  if (r.invalid) {
    st.disabled[trade.strategy] = `运行 ${r.days.toFixed(0)} 天、累计 ${r.total} 笔，最近 ${r.n} 笔盈亏比 ${r.pf.toFixed(2)} < ${conf.paper.invalidationPf}，已自动下线`
    note(st, trade.exit_ts, null, 'warn', 'risk', `${STRATEGIES[trade.strategy]?.label ?? trade.strategy} 触发失效条件，自动下线（运行 ${r.days.toFixed(0)} 天、累计 ${r.total} 笔，最近 ${r.n} 笔盈亏比 ${r.pf.toFixed(2)}）`)
  }
}

/** 资金费：cost > 0 表示付出（正费率多头付钱）；没有历史费率时按保守假设计成本 */
function settleFunding(st, symbol, ts, mark, rate, conf = cfg) {
  const p = st.positions[symbol]
  const { assumed } = costsOf(conf)
  const cost = rate != null ? p.side * p.qty * mark * rate : Math.abs(p.qty * mark * assumed)
  st.cash -= cost
  st.totals.funding += cost
  if (rate == null) st.totals.fundingAssumed += cost
  p.funding += cost
  p.last_funding_ts = ts
  const ev = { ts, symbol, side: p.side, qty: p.qty, mark, rate, assumed: rate == null, cashflow: -cost }
  st.fundings.push(ev)
  return ev
}

const stopHit = (p, bar) => (p.side > 0 ? bar.low <= p.stop : bar.high >= p.stop)
/** 止损成交价：止损价；开盘已跳空越过止损则按开盘价 */
function stopFill(p, barOpen, conf = cfg) {
  const ref = p.side > 0 ? Math.min(barOpen, p.stop) : Math.max(barOpen, p.stop)
  return { px: ref * (1 - p.side * costsOf(conf).stopSlip), ref }
}
function closeAtStop(st, symbol, barOpen, ts, conf = cfg) {
  const p = st.positions[symbol]
  const f = stopFill(p, barOpen, conf)
  return closePos(st, symbol, { px: f.px, ref: f.ref, ts, reason: '止损', source: 'stop', signalTs: ts }, conf)
}
/** 市价平仓（人工紧急停止等）：价格 ± 滑点 */
function closeAtMarket(st, symbol, price, ts, reason, source, conf = cfg) {
  const p = st.positions[symbol]
  const { slip } = costsOf(conf)
  return closePos(st, symbol, { px: price * (1 - p.side * slip), ref: price, ts, reason, source, signalTs: ts }, conf)
}

// ---------- 开盘 ----------
/**
 * mkt: { open: {sym: 开盘价}, fundingRate(sym, ts) -> rate|null, gates?: { pauseKeys: [], bySymbol: {sym: [原因]} } }
 * o:   { symbols, regimeFilter, allowEntries, conf }
 */
function barOpen(st, ts, mkt, o) {
  const conf = o.conf || cfg
  const { slip } = costsOf(conf)
  const rep = o.report || null
  const say = (s, k, m) => rep && (rep[s] ??= { actions: [], notes: [] })[k].push(m)

  // ① 新的一天
  const dk = dayKeyOf(ts)
  if (st.dayKey !== dk) {
    st.dayKey = dk
    st.dayStartEq = equity(st)
    if (st.dayBlocked) note(st, ts, null, 'info', 'risk', '新的一天（UTC），日亏停手解除')
    st.dayBlocked = false
  }

  // ② 资金费：先结算已持有的仓位
  if (ts % H8 === 0) {
    for (const s of o.symbols) {
      const p = st.positions[s]
      if (!p || p.last_funding_ts >= ts) continue
      const mark = mkt.open[s] ?? st.lastClose[s] ?? p.entry_px
      const ev = settleFunding(st, s, ts, mark, mkt.fundingRate(s, ts), conf)
      say(s, 'actions', `资金费结算 ${ev.cashflow <= 0 ? '支付' : '收取'} ${Math.abs(ev.cashflow).toFixed(2)} USDT${ev.assumed ? '（按保守假设）' : ''}`)
    }
  }

  // ③ 离场指令
  for (const s of o.symbols) {
    const pd = st.pending[s]
    if (pd?.type !== 'exit') continue
    if (!st.positions[s]) {
      delete st.pending[s]
      continue
    }
    const open = mkt.open[s]
    if (open == null) {
      say(s, 'notes', `离场指令（${pd.reason}）取不到开盘价，下一根继续执行（止损仍由每分钟巡检看守）`)
      continue
    }
    const side = st.positions[s].side
    const t = closePos(st, s, { px: open * (1 - side * slip), ref: open, ts, reason: pd.reason, source: pd.source, signalTs: pd.signalTs }, conf)
    say(s, 'actions', `离场：${pd.reason}，平仓，净盈亏 ${t.pnl.toFixed(2)} USDT`)
  }

  // ④ 权益只算一次（P2-1）
  const eq = equity(st)
  const marks = { ...st.lastClose }

  // ⑤ 开仓指令
  for (const s of o.symbols) {
    const pd = st.pending[s]
    if (pd?.type !== 'entry') continue
    delete st.pending[s]
    const open = mkt.open[s]
    if (open == null) {
      say(s, 'notes', '有入场信号，但取不到开盘价，放弃本次信号')
      continue
    }
    if (o.allowEntries === false) {
      say(s, 'notes', '补跑历史 K 线，不按过去的价格开新仓')
      continue
    }
    const refPx = open * (1 + pd.side * slip)
    const gates = mkt.gates || {}
    const verdict = risk.evaluateEntry(
      {
        status: st.status,
        pauseKeys: [...(gates.pauseKeys || []), ...(gates.bySymbol?.[s] || [])],
        dayBlocked: st.dayBlocked,
        enabled: st.enabled,
        disabled: st.disabled,
        regime: pd.regime,
        strategy: pd.strategy,
        signal: { side: pd.side, stop: pd.stop },
        refPx,
        equity: eq,
        positions: st.positions,
        marks,
        symbol: s,
        barFresh: true,
        regimeFilter: o.regimeFilter,
      },
      conf,
    )
    let qty = verdict.sizing?.qty ?? 0
    if (verdict.approved) {
      const r = roundQty(s, qty, refPx, conf)
      qty = r.qty
      if (r.check) verdict.checks.push(r.check)
      if (!(qty > 0)) {
        verdict.approved = false
        st.rejects.push({ ts, symbol: s, strategy: pd.strategy, reason: r.check?.detail ?? '数量为 0' }) // 回测和模拟盘都记录
      }
    }
    if (rep) (rep[s] ??= { actions: [], notes: [] }).risk = verdict
    if (!verdict.approved) {
      const why = verdict.checks.filter((k) => !k.ok).map((k) => `${k.label}（${k.detail}）`)
      say(s, 'actions', `风控拒绝：${why.join('；')}`)
      note(st, ts, s, 'info', 'reject', `${s} 开仓被拒绝：${why.join('；')}`)
      continue
    }
    openPos(st, { symbol: s, side: pd.side, qty, px: refPx, ref: open, ts, stop: pd.stop, strategy: pd.strategy, params: pd.params, regime: pd.regime, riskAmt: qty * Math.abs(refPx - pd.stop), signalTs: pd.signalTs }, conf)
    say(s, 'actions', `风控通过，${pd.side > 0 ? '做多' : '做空'}开仓`)
  }
  st.lastOpenTs = ts
}

// ---------- 收盘 ----------
/**
 * mkt: { series: {sym: {bars, regimes, idx}}, indicators(sym, name, params) }
 * o:   { symbols, paramsAt(name, ts), regimeFilter, ddLock, allowEntries, conf, report }
 */
function barClose(st, ts, mkt, o) {
  const conf = o.conf || cfg
  const rep = o.report || null
  const R = (s) => (rep ? (rep[s] ??= { actions: [], notes: [] }) : null)

  // ① 止损（K 线最高/最低价）
  for (const s of o.symbols) {
    const S = mkt.series[s]
    const i = S?.idx.get(ts)
    if (i == null) continue
    const b = S.bars[i]
    const p = st.positions[s]
    if (p && p.entry_ts <= ts && stopHit(p, b)) {
      const t = closeAtStop(st, s, b.open, ts, conf)
      R(s)?.actions.push(`K 线内触发止损，平仓，净盈亏 ${t.pnl.toFixed(2)} USDT`)
    }
    st.lastClose[s] = b.close
  }

  // ② 峰值 / 日亏 / 回撤
  const eq = equity(st)
  if (eq > st.peak) st.peak = eq
  const dl = risk.dailyLoss(eq, st.dayStartEq, conf)
  if (dl.hit && !st.dayBlocked) {
    st.dayBlocked = true
    st.blockedDays++
    note(st, ts, null, 'warn', 'risk', `今日亏损 ${dl.changePct.toFixed(2)}% 达到 ${conf.risk.dailyLossLimitPct}% 上限，今天不再开新仓`)
  }
  if (o.ddLock && st.status === 'running') {
    const dd = risk.drawdown(eq, st.peak, conf)
    if (dd.hit) {
      st.status = 'locked'
      st.locked = { ts, equity: eq }
      st.statusReason = `回撤 ${dd.ddPct.toFixed(2)}% 达到 ${conf.risk.maxDrawdownPct}% 上限，已全部平仓并锁定，需人工解锁`
      for (const s of Object.keys(st.positions)) st.pending[s] = { type: 'exit', reason: `回撤 ${conf.risk.maxDrawdownPct}% 风控锁定`, source: 'ddlock', signalTs: ts }
      note(st, ts, null, 'error', 'risk', `回撤风控触发：权益 ${eq.toFixed(2)}，较峰值回撤 ${dd.ddPct.toFixed(2)}%，下一根开盘全部平仓并锁定`)
    }
  }

  // ③④ 信号
  for (const s of o.symbols) {
    const S = mkt.series[s]
    const i = S?.idx.get(ts)
    if (i == null) {
      R(s)?.notes.push('K 线未更新到最新一根，本小时不处理该币种')
      continue
    }
    if (st.pending[s]) continue
    const regime = S.regimes[i]
    const p = st.positions[s]
    if (p) {
      const strat = STRATEGIES[p.strategy]
      const prm = p.params || strat.defaults
      const posObj = { side: p.side, stop: p.stop, entryIdx: S.idx.get(p.entry_ts) ?? i - Math.round((ts - p.entry_ts) / H1) }
      const ex = strat.exit(i, posObj, { bars: S.bars, x: mkt.indicators(s, p.strategy, prm), p: prm, regime, filter: o.regimeFilter !== false })
      if (posObj.stop !== p.stop) {
        R(s)?.actions.push(`移动止损 ${p.stop.toFixed(4)} → ${posObj.stop.toFixed(4)}`)
        p.stop = posObj.stop
      }
      if (ex) {
        st.pending[s] = { type: 'exit', reason: ex.reason, source: p.strategy, signalTs: ts }
        R(s)?.actions.push(`离场信号：${ex.reason}，下一根开盘平仓`)
      } else R(s)?.actions.push('继续持有')
      continue
    }
    if (o.allowEntries === false) continue
    if (st.status !== 'running') {
      R(s)?.notes.push(st.status === 'locked' ? '回撤锁定中，不开新仓' : '已紧急停止，不开新仓')
      continue
    }
    if (st.dayBlocked) {
      R(s)?.notes.push('今日亏损已达上限，不开新仓')
      continue
    }
    const allowed = conf.allowedStrategies[regime] || []
    const cands = Object.keys(STRATEGIES).filter((n) => st.enabled.includes(n) && !st.disabled[n] && (o.regimeFilter === false || allowed.includes(n)))
    if (!cands.length) {
      R(s)?.notes.push(`市场状态「${regime}」下没有可用的已启用策略，不开新仓`)
      continue
    }
    let found = false
    for (const name of cands) {
      const prm = o.paramsAt(name, ts)
      const sig = STRATEGIES[name].entry(i, { bars: S.bars, x: mkt.indicators(s, name, prm), p: prm, regime, filter: o.regimeFilter !== false })
      if (!sig) continue
      st.pending[s] = { type: 'entry', side: sig.side, stop: sig.stop, strategy: name, params: prm, regime, signalTs: ts, source: name }
      if (rep) {
        R(s).signal = { strategy: name, strategyLabel: STRATEGIES[name].label, side: sig.side, stop: sig.stop }
        R(s).actions.push(`${STRATEGIES[name].label}出现${sig.side > 0 ? '做多' : '做空'}信号，下一根开盘执行`)
      }
      found = true
      break
    }
    if (!found) R(s)?.notes.push(`允许的策略（${cands.map((n) => STRATEGIES[n].label).join('、')}）本小时没有入场信号`)
  }
  st.lastCloseTs = ts
}

module.exports = {
  H1,
  H8,
  DAY,
  dayKeyOf,
  costsOf,
  buildSeries,
  indicatorCache,
  newState,
  equity,
  unrealized,
  ledger,
  roundQty,
  openPos,
  closePos,
  settleFunding,
  stopHit,
  stopFill,
  closeAtStop,
  closeAtMarket,
  barOpen,
  barClose,
}
