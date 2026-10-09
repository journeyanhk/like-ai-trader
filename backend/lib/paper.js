// 模拟交易引擎（PAPER）
// 每小时：K 线收盘 → 市场状态 → 允许的策略出信号 → 风控审核 → 模拟下单（下一根 K 线开盘价 + 滑点成交）
// 每分钟：风控巡检（止损、回撤锁定、日亏停手、5 个自动暂停条件）
// AI 不参与这里的任何决定；所有规则都是确定性代码。
// 为减少数据库访问，账户状态常驻内存，只在变化时写库；心跳与对账每 5 分钟一次。
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const okx = require('./okx')
const feed = require('./feed')
const risk = require('./risk')
const orders = require('./orders')
const { STRATEGIES } = require('./strategies')
const { LABELS } = require('./regime')

const H1 = 3600_000
const H8 = 8 * H1
const DAY = 86400_000
const FEE = cfg.costs.takerPct / 100
const SLIP = cfg.costs.slippageBps / 10000

// 自动暂停条件
const PAUSE = {
  stale: { label: `行情数据过期超过 ${cfg.staleDataSeconds} 秒`, auto: true },
  deviation: { label: `两个价格源偏差超过 ${cfg.priceSourceMaxDeviationPct}%`, auto: true },
  api_errors: { label: `连续接口错误 ≥ ${cfg.paper.maxApiErrors} 次`, auto: true },
  order_unknown: { label: `订单状态超过 ${cfg.paper.orderUnknownSeconds} 秒未知`, auto: false },
  reconcile: { label: '本地持仓与订单账本不一致', auto: false },
}

const S = {
  loaded: false,
  acct: null,
  positions: {}, // symbol -> row
  quotes: {}, // symbol -> { last, index, ts, at }
  lastClose: {}, // symbol -> 最近收盘价（行情取不到时用于估值）
  apiErrors: 0,
  healthy: {}, // pause key -> 连续正常次数
  inflight: new Map(), // clientOrderId -> 提交时间（超时未完成 → 状态未知）
  lastReconcile: null,
  lastMonitorAt: null,
  lastChecks: null,
  bootAt: Date.now(),
}

// ---------- 串行锁：每小时任务、每分钟巡检、人工操作互不打架 ----------
let chain = Promise.resolve()
function withLock(fn) {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}

const n = (v) => (v == null ? null : Number(v))
const now = () => Date.now()
const dayKeyOf = (ts) => Math.floor(ts / DAY)

// ---------- 读写 ----------
function rowToAcct(r) {
  return {
    status: r.status,
    status_reason: r.status_reason,
    pause_keys: r.pause_keys || [],
    cash: n(r.cash),
    peak_equity: n(r.peak_equity),
    day_key: n(r.day_key),
    day_start_equity: n(r.day_start_equity),
    day_blocked: !!r.day_blocked,
    enabled_strategies: r.enabled_strategies || [...cfg.paper.strategies],
    disabled_strategies: r.disabled_strategies || {},
    last_bar_ts: n(r.last_bar_ts),
    last_heartbeat: n(r.last_heartbeat),
    last_cycle_at: n(r.last_cycle_at),
    started_at: n(r.started_at),
  }
}
function rowToPos(r) {
  return {
    symbol: r.symbol,
    side: n(r.side),
    qty: n(r.qty),
    entry_px: n(r.entry_px),
    entry_ts: n(r.entry_ts),
    stop: n(r.stop),
    strategy: r.strategy,
    params: r.params,
    regime: r.regime,
    fees: n(r.fees),
    slippage: n(r.slippage),
    funding: n(r.funding),
    risk_amt: n(r.risk_amt),
    last_funding_ts: n(r.last_funding_ts),
  }
}

async function load(force = false) {
  if (S.loaded && !force) return
  await require('./settings').ensureLoaded()
  let { rows } = await dbQuery(`SELECT * FROM paper_account WHERE id='main'`)
  if (!rows.length) {
    const t = now()
    const eq = cfg.paperStartingEquity
    await dbQuery(
      `INSERT INTO paper_account (id, status, pause_keys, cash, peak_equity, day_key, day_start_equity, day_blocked, enabled_strategies, disabled_strategies, started_at, updated_at)
       VALUES ('main','running','[]',$1,$1,$2,$1,false,$3,'{}',$4,$4) ON CONFLICT (id) DO NOTHING`,
      [eq, dayKeyOf(t), JSON.stringify(cfg.paper.strategies), t],
    )
    await feed.logEvent('info', 'system', `模拟账户已创建，起始资金 ${eq.toLocaleString()} USDT`)
    rows = (await dbQuery(`SELECT * FROM paper_account WHERE id='main'`)).rows
  }
  S.acct = rowToAcct(rows[0])
  const pos = await dbQuery('SELECT * FROM paper_positions')
  S.positions = Object.fromEntries(pos.rows.map((r) => [r.symbol, rowToPos(r)]))
  S.loaded = true
}

async function saveAcct() {
  const a = S.acct
  await dbQuery(
    `UPDATE paper_account SET status=$1, status_reason=$2, pause_keys=$3, cash=$4, peak_equity=$5, day_key=$6, day_start_equity=$7,
       day_blocked=$8, enabled_strategies=$9, disabled_strategies=$10, last_bar_ts=$11, last_heartbeat=$12, last_cycle_at=$13, updated_at=$14
     WHERE id='main'`,
    [
      a.status,
      a.status_reason,
      JSON.stringify(a.pause_keys),
      a.cash,
      a.peak_equity,
      a.day_key,
      a.day_start_equity,
      a.day_blocked,
      JSON.stringify(a.enabled_strategies),
      JSON.stringify(a.disabled_strategies),
      a.last_bar_ts,
      a.last_heartbeat,
      a.last_cycle_at,
      now(),
    ],
  )
}

async function savePos(p) {
  await dbQuery(
    `INSERT INTO paper_positions (symbol, side, qty, entry_px, entry_ts, stop, strategy, params, regime, fees, slippage, funding, risk_amt, last_funding_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (symbol) DO UPDATE SET side=$2, qty=$3, entry_px=$4, entry_ts=$5, stop=$6, strategy=$7, params=$8, regime=$9,
       fees=$10, slippage=$11, funding=$12, risk_amt=$13, last_funding_ts=$14`,
    [p.symbol, p.side, p.qty, p.entry_px, p.entry_ts, p.stop, p.strategy, JSON.stringify(p.params || {}), p.regime, p.fees, p.slippage, p.funding, p.risk_amt, p.last_funding_ts],
  )
}

// ---------- 估值 ----------
function markOf(symbol) {
  const q = S.quotes[symbol]
  if (q && now() - q.at < 5 * 60_000) return q.last
  return S.lastClose[symbol] ?? S.positions[symbol]?.entry_px ?? null
}
function marks() {
  return Object.fromEntries(cfg.symbols.map((s) => [s, markOf(s)]))
}
function unrealized() {
  return Object.values(S.positions).reduce((u, p) => u + p.side * p.qty * ((markOf(p.symbol) ?? p.entry_px) - p.entry_px), 0)
}
function equityNow() {
  return S.acct.cash + unrealized()
}

// ---------- 下单（模拟成交引擎） ----------
/**
 * 订单生命周期：PENDING → SUBMITTED（写库）→ FILLED / REJECTED（写库）
 * clientOrderId 唯一：同一信号重复执行时数据库直接拒绝第二次插入，不会重复下单
 */
async function placeOrder({ clientId, symbol, side, intent, qty, refPx, reason, strategy, signalTs }) {
  const t = now()
  let o = { client_order_id: clientId, status: 'PENDING', history: [] }
  o = orders.transition(o, 'SUBMITTED', '提交到模拟撮合', t)
  const ins = await dbQuery(
    `INSERT INTO paper_orders (client_order_id, symbol, side, intent, qty, ref_px, status, reason, strategy, signal_ts, history, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT (client_order_id) DO NOTHING RETURNING id`,
    [clientId, symbol, side, intent, qty, refPx, o.status, reason, strategy, signalTs, JSON.stringify(o.history), t],
  )
  if (!ins.rows.length) {
    await feed.logEvent('warn', 'order', `重复订单已拦截：${clientId}`, { clientId })
    return null
  }
  S.inflight.set(clientId, t)
  const fillPx = refPx * (1 + side * SLIP) // 买入价格往上滑、卖出往下滑
  return { id: ins.rows[0].id, order: o, fillPx, fee: qty * fillPx * FEE, slippage: qty * Math.abs(fillPx - refPx) }
}

async function finishOrder(placed, status, note) {
  const o = orders.transition(placed.order, status, note)
  await dbQuery(`UPDATE paper_orders SET status=$1, fill_px=$2, fee=$3, slippage=$4, history=$5, updated_at=$6 WHERE id=$7`, [
    o.status,
    status === 'FILLED' ? placed.fillPx : null,
    status === 'FILLED' ? placed.fee : null,
    status === 'FILLED' ? placed.slippage : null,
    JSON.stringify(o.history),
    o.updated_at,
    placed.id,
  ])
  S.inflight.delete(o.client_order_id)
}

const sideName = (s) => (s > 0 ? '做多' : '做空')
const fmt = (x, d = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

async function openPosition({ symbol, sig, qty, refPx, strategy, params, regime, signalTs, riskAmt, entryTs }) {
  const clientId = orders.clientOrderId(strategy, signalTs, symbol, 'open')
  const placed = await placeOrder({ clientId, symbol, side: sig.side, intent: 'open', qty, refPx, reason: '策略入场', strategy, signalTs })
  if (!placed) return null
  const p = {
    symbol,
    side: sig.side,
    qty,
    entry_px: placed.fillPx,
    entry_ts: entryTs,
    stop: sig.stop,
    strategy,
    params,
    regime,
    fees: placed.fee,
    slippage: placed.slippage,
    funding: 0,
    risk_amt: riskAmt,
    last_funding_ts: entryTs - 1,
  }
  S.acct.cash -= placed.fee
  S.positions[symbol] = p
  await savePos(p)
  await saveAcct()
  await finishOrder(placed, 'FILLED', `成交价 ${fmt(placed.fillPx)}`)
  await feed.logEvent('info', 'order', `开仓 ${symbol} ${sideName(sig.side)} ${qty.toPrecision(4)} @ ${fmt(placed.fillPx)}，止损 ${fmt(sig.stop)}（${STRATEGIES[strategy]?.label ?? strategy}）`, {
    clientId,
    riskAmt,
  })
  return p
}

async function closePosition(symbol, refPx, reason, source, signalTs) {
  const p = S.positions[symbol]
  if (!p) return null
  const clientId = orders.clientOrderId(source, signalTs, symbol, 'close')
  const placed = await placeOrder({ clientId, symbol, side: -p.side, intent: 'close', qty: p.qty, refPx, reason, strategy: p.strategy, signalTs })
  if (!placed) return null
  const gross = p.side * p.qty * (placed.fillPx - p.entry_px)
  const fees = p.fees + placed.fee
  const pnl = gross - fees - p.funding
  S.acct.cash += gross - placed.fee
  delete S.positions[symbol]
  const t = now()
  await dbQuery(
    `INSERT INTO paper_trades (symbol, strategy, side, entry_ts, entry_px, exit_ts, exit_px, qty, regime, reason, fees, slippage, funding, pnl, risk_amt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [symbol, p.strategy, p.side > 0 ? 'long' : 'short', p.entry_ts, p.entry_px, t, placed.fillPx, p.qty, p.regime, reason, fees, p.slippage + placed.slippage, p.funding, pnl, p.risk_amt],
  )
  await dbQuery('DELETE FROM paper_positions WHERE symbol=$1', [symbol])
  await saveAcct()
  await finishOrder(placed, 'FILLED', `成交价 ${fmt(placed.fillPx)}`)
  await feed.logEvent(pnl >= 0 ? 'info' : 'warn', 'trade', `平仓 ${symbol}（${reason}）@ ${fmt(placed.fillPx)}，净盈亏 ${pnl >= 0 ? '+' : ''}${fmt(pnl)} USDT`, {
    clientId,
    pnl,
  })
  await checkInvalidation(p.strategy)
  return pnl
}

async function checkInvalidation(strategy) {
  const { rows } = await dbQuery('SELECT pnl FROM paper_trades WHERE strategy=$1 ORDER BY exit_ts DESC LIMIT $2', [strategy, cfg.paper.invalidationTrades])
  const r = risk.strategyInvalidation(rows.map((x) => ({ pnl: n(x.pnl) })).reverse())
  if (r.invalid && !S.acct.disabled_strategies[strategy]) {
    S.acct.disabled_strategies[strategy] = `最近 ${r.n} 笔盈亏比 ${r.pf.toFixed(2)} < ${cfg.paper.invalidationPf}，已自动下线`
    await saveAcct()
    await feed.logEvent('warn', 'risk', `${STRATEGIES[strategy]?.label ?? strategy} 触发失效条件，自动下线（最近 ${r.n} 笔盈亏比 ${r.pf.toFixed(2)}）`)
  }
}

// ---------- 风控动作 ----------
async function flattenAll(reason, source) {
  const t = now()
  const results = []
  for (const s of Object.keys(S.positions)) {
    let px = null
    try {
      const q = await okx.quote(s)
      S.quotes[s] = { ...q, at: now() }
      px = q.last
    } catch {
      px = markOf(s) // 取不到实时价时用最近价格估算（会在事件里注明）
    }
    const pnl = await closePosition(s, px, reason, source, t)
    results.push({ symbol: s, pnl })
  }
  return results
}

async function lockForDrawdown(equity, dd) {
  S.acct.status = 'locked'
  S.acct.status_reason = `回撤 ${dd.toFixed(2)}% 达到 ${cfg.risk.maxDrawdownPct}% 上限，已全部平仓并锁定，需人工解锁`
  await saveAcct()
  await feed.logEvent('error', 'risk', `回撤风控触发：权益 ${fmt(equity)}，较峰值回撤 ${dd.toFixed(2)}%，全部平仓并锁定`)
  await flattenAll(`回撤 ${cfg.risk.maxDrawdownPct}% 风控锁定`, 'ddlock')
}

/** 每次估值后都跑：更新峰值、日内基准、日亏停手、回撤锁定 */
async function riskSweep(t = now()) {
  const a = S.acct
  let dirty = false
  const eq = equityNow()
  const dk = dayKeyOf(t)
  if (a.day_key !== dk) {
    a.day_key = dk
    a.day_start_equity = eq
    if (a.day_blocked) await feed.logEvent('info', 'risk', '新的一天（UTC），日亏停手解除')
    a.day_blocked = false
    dirty = true
  }
  if (eq > a.peak_equity) {
    a.peak_equity = eq
    dirty = true
  }
  const dl = risk.dailyLoss(eq, a.day_start_equity)
  if (dl.hit && !a.day_blocked) {
    a.day_blocked = true
    dirty = true
    await feed.logEvent('warn', 'risk', `今日亏损 ${dl.changePct.toFixed(2)}% 达到 ${cfg.risk.dailyLossLimitPct}% 上限，今天不再开新仓`)
  }
  const dd = risk.drawdown(eq, a.peak_equity)
  if (dd.hit && a.status !== 'locked') {
    await lockForDrawdown(eq, dd.ddPct)
    return
  }
  if (dirty) await saveAcct()
}

// ---------- 自动暂停 ----------
async function setPause(key, active, detail) {
  const a = S.acct
  const has = a.pause_keys.includes(key)
  if (active) {
    S.healthy[key] = 0
    if (!has) {
      a.pause_keys = [...a.pause_keys, key]
      await saveAcct()
      await feed.logEvent('error', 'auto_pause', `自动暂停开新仓：${PAUSE[key].label}${detail ? `（${detail}）` : ''}`, { key, detail })
    }
    return
  }
  if (!has || !PAUSE[key].auto) return
  S.healthy[key] = (S.healthy[key] || 0) + 1
  if (S.healthy[key] >= cfg.paper.autoResumeHealthyChecks) {
    a.pause_keys = a.pause_keys.filter((k) => k !== key)
    S.healthy[key] = 0
    await saveAcct()
    await feed.logEvent('info', 'auto_resume', `自动恢复：${PAUSE[key].label} 已连续 ${cfg.paper.autoResumeHealthyChecks} 次检查正常`, { key })
  }
}

/** 对账：把所有已成交订单重放一遍，得到的持仓应与持仓表一致 */
async function reconcile() {
  const { rows } = await dbQuery(`SELECT symbol, SUM(side*qty)::float8 AS net FROM paper_orders WHERE status='FILLED' GROUP BY symbol`)
  const ledger = Object.fromEntries(rows.map((r) => [r.symbol, n(r.net)]))
  const db = await dbQuery('SELECT symbol, side, qty FROM paper_positions')
  const dbPos = Object.fromEntries(db.rows.map((r) => [r.symbol, n(r.side) * n(r.qty)]))
  const diffs = []
  for (const s of new Set([...Object.keys(ledger), ...Object.keys(dbPos), ...Object.keys(S.positions)])) {
    const l = ledger[s] || 0
    const d = dbPos[s] || 0
    const m = S.positions[s] ? S.positions[s].side * S.positions[s].qty : 0
    const tol = 1e-9 * Math.max(1, Math.abs(l), Math.abs(d))
    if (Math.abs(l - d) > tol || Math.abs(m - d) > tol) diffs.push({ symbol: s, ledger: l, positions: d, memory: m })
  }
  S.lastReconcile = { at: now(), ok: diffs.length === 0, diffs }
  return S.lastReconcile
}

/** 找出卡住的订单（提交后超过 30 秒没有结果）→ 标为 UNKNOWN */
async function sweepUnknownOrders(fromDb = false) {
  const limit = cfg.paper.orderUnknownSeconds * 1000
  const t = now()
  const stuck = []
  for (const [cid, since] of S.inflight) if (t - since > limit) stuck.push(cid)
  if (fromDb) {
    const { rows } = await dbQuery(`SELECT client_order_id FROM paper_orders WHERE status IN ('PENDING','SUBMITTED','PARTIAL') AND created_at < $1`, [t - limit])
    for (const r of rows) if (!stuck.includes(r.client_order_id)) stuck.push(r.client_order_id)
  }
  for (const cid of stuck) {
    const { rows } = await dbQuery('SELECT * FROM paper_orders WHERE client_order_id=$1', [cid])
    const o = rows[0]
    S.inflight.delete(cid)
    if (!o || orders.isFinal(o.status) || o.status === 'UNKNOWN') continue
    const next = orders.transition(o, 'UNKNOWN', `超过 ${cfg.paper.orderUnknownSeconds} 秒没有结果`)
    await dbQuery('UPDATE paper_orders SET status=$1, history=$2, updated_at=$3 WHERE id=$4', [next.status, JSON.stringify(next.history), next.updated_at, o.id])
  }
  const { rows } = stuck.length || fromDb ? await dbQuery(`SELECT COUNT(*)::int AS c FROM paper_orders WHERE status='UNKNOWN'`) : { rows: [{ c: S._unknownCount || 0 }] }
  S._unknownCount = rows[0].c
  return S._unknownCount
}

// ---------- 每分钟风控巡检 ----------
async function fetchQuotes() {
  const out = {}
  for (const s of cfg.symbols) {
    try {
      const q = await okx.quote(s)
      S.quotes[s] = { ...q, at: now() }
      out[s] = q
      S.apiErrors = 0
    } catch (e) {
      S.apiErrors++
      out[s] = null
      out[`${s}:error`] = e.message
    }
  }
  return out
}

async function monitor() {
  return withLock(async () => {
    await load()
    const t = now()
    const quotes = await fetchQuotes()

    // 1) 数据类检查
    const per = {}
    for (const s of cfg.symbols) per[s] = risk.dataChecks(quotes[s], t)
    const staleBad = cfg.symbols.filter((s) => !per[s].stale.ok)
    const devBad = cfg.symbols.filter((s) => per[s].deviation.ok === false && quotes[s])
    await setPause('stale', staleBad.length > 0, staleBad.map((s) => `${s} ${per[s].stale.detail}`).join('；'))
    await setPause('deviation', devBad.length > 0, devBad.map((s) => `${s} ${per[s].deviation.detail}`).join('；'))
    await setPause('api_errors', S.apiErrors >= cfg.paper.maxApiErrors, `连续 ${S.apiErrors} 次`)

    // 2) 订单状态未知
    const heartbeatDue = !S.acct.last_heartbeat || t - S.acct.last_heartbeat >= cfg.paper.heartbeatEveryMs - 5000
    const unknown = await sweepUnknownOrders(heartbeatDue)
    if (unknown > 0) await setPause('order_unknown', true, `${unknown} 笔`)

    // 3) 止损（行情正常才判断；暂停只拦开新仓，平仓永远允许）
    for (const [s, p] of Object.entries({ ...S.positions })) {
      const q = quotes[s]
      if (!q || !per[s].stale.ok) continue
      const hit = p.side > 0 ? q.last <= p.stop : q.last >= p.stop
      if (hit) await closePosition(s, q.last, '止损', 'stop', t)
    }

    // 4) 日亏 / 回撤
    await riskSweep(t)

    // 5) 心跳 + 对账（每 5 分钟）
    if (heartbeatDue) {
      const rc = await reconcile()
      if (!rc.ok) await setPause('reconcile', true, rc.diffs.map((d) => d.symbol).join('、'))
      S.acct.last_heartbeat = t
      await saveAcct()
    }
    S.lastMonitorAt = t
    S.lastChecks = { at: t, per, apiErrors: S.apiErrors, unknown }
    return S.lastChecks
  })
}

// ---------- 每小时交易循环 ----------
async function fundingFor(symbol, ts) {
  const { rows } = await dbQuery('SELECT rate FROM funding_rates WHERE symbol=$1 AND ts=$2', [symbol, ts])
  return rows.length ? n(rows[0].rate) : null
}

async function runCycle(regimes = null, { force = false } = {}) {
  return withLock(async () => {
    await load()
    const t = now()
    const barTs = Math.floor(t / H1) * H1 - H1 // 刚收盘的那根 1h K 线
    const a = S.acct
    if (!force && a.last_bar_ts != null && a.last_bar_ts >= barTs) {
      return { skipped: true, reason: `这根 K 线（${new Date(barTs).toISOString().slice(11, 16)} UTC）已经处理过，不会重复下单` }
    }
    if (!regimes) {
      const jobs = require('./jobs')
      regimes = []
      for (const s of cfg.symbols) regimes.push({ symbol: s, ...(await jobs.regimeFor(s)) })
    }
    const regimeOf = Object.fromEntries(regimes.map((r) => [r.symbol, r]))
    await fetchQuotes()

    const ctxs = {}
    const decisions = []
    // 阶段 1：资金费、K 线内止损、持仓离场
    for (const s of cfg.symbols) {
      const d = { symbol: s, regime: regimeOf[s]?.regime ?? 'unclear', regimeLabel: regimeOf[s]?.label ?? '—', actions: [], notes: [] }
      decisions.push(d)
      const bars = await feed.loadBars(s, '1h', cfg.paper.barsForSignals)
      const last = bars[bars.length - 1]
      d.barTs = last?.ts ?? null
      d.close = last?.close ?? null
      if (last) S.lastClose[s] = last.close
      const fresh = last?.ts === barTs
      d.fresh = fresh
      let cur = null
      try {
        cur = await okx.currentBar(s)
        if (cur.ts !== barTs + H1) cur = null
      } catch {
        cur = null
      }
      // 正常情况（收盘后 2 分钟内执行）按本根 K 线开盘价成交，与回测一致；
      // 如果是补跑（晚于 10 分钟），改用实时价，避免"用过去的价格成交"占便宜
      const late = t - (barTs + H1) > 10 * 60_000
      const ref = cur ? (late ? S.quotes[s]?.last ?? null : cur.open) : null
      if (late && ref) d.notes.push('本次为补跑，按实时价格成交')
      d.nextOpen = ref
      ctxs[s] = { bars, i: bars.length - 1, fresh, cur, ref, hadPos: !!S.positions[s] }
      if (!fresh) {
        d.notes.push('K 线未更新到最新一根，本小时不开新仓')
        continue
      }
      const p = S.positions[s]
      if (!p) continue
      // 资金费（OKX 每 8 小时结算：UTC 0/8/16 点）
      for (let fts = Math.ceil((p.last_funding_ts + 1) / H8) * H8; fts <= (cur?.ts ?? barTs + H1); fts += H8) {
        if (fts < p.entry_ts) continue
        const rate = await fundingFor(s, fts)
        const px = fts === cur?.ts ? cur.open : bars.find((b) => b.ts === fts)?.open ?? last.close
        const cost = rate != null ? p.side * p.qty * px * rate : Math.abs(p.qty * px * (cfg.costs.assumedFundingPct8h / 100))
        p.funding += cost
        S.acct.cash -= cost
        p.last_funding_ts = fts
        d.actions.push(`资金费结算 ${cost >= 0 ? '支付' : '收取'} ${fmt(Math.abs(cost))} USDT${rate == null ? '（按保守假设）' : ''}`)
        await savePos(p)
        await saveAcct()
      }
      // 刚收盘这根 K 线内是否碰到止损（交易所挂着的止损单会在影线处成交）
      if (p.entry_ts <= last.ts) {
        const hit = p.side > 0 ? last.low <= p.stop : last.high >= p.stop
        if (hit) {
          const ref = p.side > 0 ? Math.min(last.open, p.stop) : Math.max(last.open, p.stop)
          const pnl = await closePosition(s, ref, '止损', 'stop', last.ts)
          d.actions.push(`K 线内触发止损，平仓，净盈亏 ${fmt(pnl ?? 0)} USDT`)
          continue
        }
      }
      // 策略离场 / 移动止损
      const st = STRATEGIES[p.strategy]
      const i = bars.length - 1
      const x = st.prepare(bars, p.params || st.defaults)
      const posObj = { side: p.side, stop: p.stop, entryIdx: i - Math.round((last.ts - p.entry_ts) / H1) }
      const ex = st.exit(i, posObj, { bars, x, p: p.params || st.defaults, regime: d.regime, filter: true })
      if (posObj.stop !== p.stop) {
        d.actions.push(`移动止损 ${fmt(p.stop)} → ${fmt(posObj.stop)}`)
        p.stop = posObj.stop
        await savePos(p)
      }
      if (ex) {
        const ref = ctxs[s].ref
        if (!ref) d.notes.push(`出现离场信号（${ex.reason}），但取不到成交价格，本小时未能平仓（止损仍由每分钟巡检看守）`)
        else {
          const pnl = await closePosition(s, ref, ex.reason, p.strategy, last.ts)
          d.actions.push(`离场信号：${ex.reason}，平仓，净盈亏 ${fmt(pnl ?? 0)} USDT`)
        }
      } else d.actions.push('继续持有')
    }

    // 阶段 2：风控（峰值、日亏、回撤）
    await riskSweep(t)

    // 阶段 3：开新仓
    const equity = equityNow()
    for (const d of decisions) {
      const s = d.symbol
      const c = ctxs[s]
      if (!c.fresh || c.hadPos || S.positions[s]) continue
      const allowed = cfg.allowedStrategies[d.regime] || []
      const candidates = cfg.paper.strategies.filter((nme) => allowed.includes(nme))
      if (!candidates.length) {
        d.notes.push(`市场状态「${d.regimeLabel}」不允许任何策略开新仓`)
        continue
      }
      let found = false
      for (const name of candidates) {
        const st = STRATEGIES[name]
        const params = { ...st.defaults }
        const x = st.prepare(c.bars, params)
        const sig = st.entry(c.i, { bars: c.bars, x, p: params, regime: d.regime, filter: true })
        if (!sig) continue
        found = true
        d.signal = { strategy: name, strategyLabel: st.label, side: sig.side, stop: sig.stop }
        if (!c.ref) {
          d.notes.push('有入场信号，但取不到成交价格，放弃本次信号')
          break
        }
        const refPx = c.ref * (1 + sig.side * SLIP)
        const verdict = risk.evaluateEntry({
          status: S.acct.status,
          pauseKeys: S.acct.pause_keys,
          dayBlocked: S.acct.day_blocked,
          enabled: S.acct.enabled_strategies,
          disabled: S.acct.disabled_strategies,
          regime: d.regime,
          strategy: name,
          signal: sig,
          refPx,
          equity,
          positions: S.positions,
          marks: marks(),
          symbol: s,
          barFresh: c.fresh,
        })
        d.risk = verdict
        if (verdict.approved) {
          await openPosition({ symbol: s, sig, qty: verdict.sizing.qty, refPx: c.ref, strategy: name, params, regime: d.regime, signalTs: c.bars[c.i].ts, riskAmt: verdict.sizing.riskAmt, entryTs: c.cur.ts })
          d.actions.push(`风控通过，${sideName(sig.side)}开仓`)
        } else {
          const why = verdict.checks.filter((k) => !k.ok).map((k) => k.label)
          d.actions.push(`风控拒绝：${why.join('；')}`)
        }
        break
      }
      if (!found) d.notes.push(`允许的策略（${candidates.map((nme) => STRATEGIES[nme].label).join('、')}）本小时没有入场信号`)
    }

    // 阶段 4：记录净值与决策
    await riskSweep(t)
    const eq = equityNow()
    const ex = risk.exposure(S.positions, marks(), eq)
    const snapTs = barTs + H1
    await dbQuery(
      `INSERT INTO paper_equity (ts, equity, cash, unrealized, exposure, drawdown_pct, positions) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ts) DO UPDATE SET equity=$2, cash=$3, unrealized=$4, exposure=$5, drawdown_pct=$6, positions=$7`,
      [snapTs, eq, S.acct.cash, eq - S.acct.cash, ex.gross, risk.drawdown(eq, S.acct.peak_equity).ddPct, Object.keys(S.positions).length],
    )
    const summary = { equity: eq, status: S.acct.status, pauseKeys: S.acct.pause_keys, dayBlocked: S.acct.day_blocked, decisions }
    await dbQuery('INSERT INTO paper_cycles (ts, bar_ts, summary) VALUES ($1,$2,$3)', [t, barTs, JSON.stringify(summary)])
    S.acct.last_bar_ts = barTs
    S.acct.last_cycle_at = t
    await saveAcct()
    return summary
  })
}

// ---------- 人工操作 ----------
async function emergencyStop(note = '') {
  return withLock(async () => {
    await load()
    const prev = S.acct.status
    S.acct.status = 'stopped'
    S.acct.status_reason = `紧急停止（${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC）${note ? `：${note}` : ''}`
    await saveAcct()
    const closed = await flattenAll('紧急停止', 'manual')
    await feed.logEvent('error', 'control', `紧急停止：已平掉 ${closed.length} 个持仓，停止开新仓（之前状态：${prev}）`, { closed })
    return { closed }
  })
}

async function resume() {
  return withLock(async () => {
    await load()
    // 处理状态未知的订单：以持仓表为准，能对上的标为已成交，对不上的标为已撤销
    const unk = (await dbQuery(`SELECT * FROM paper_orders WHERE status='UNKNOWN' ORDER BY id`)).rows
    if (unk.length) {
      const rc = await reconcile()
      const diff = Object.fromEntries(rc.diffs.map((d) => [d.symbol, d.positions - d.ledger]))
      for (const o of unk) {
        const signed = n(o.side) * n(o.qty)
        const left = diff[o.symbol] || 0
        const to = Math.abs(left - signed) < 1e-9 * Math.max(1, Math.abs(signed)) ? 'FILLED' : 'CANCELED'
        if (to === 'FILLED') diff[o.symbol] = left - signed
        const next = orders.transition(o, to, '人工恢复时按持仓表对账处理')
        await dbQuery('UPDATE paper_orders SET status=$1, history=$2, updated_at=$3 WHERE id=$4', [to, JSON.stringify(next.history), next.updated_at, o.id])
      }
      S._unknownCount = 0
    }
    await load(true) // 以数据库为准重新加载
    const rc = await reconcile()
    if (!rc.ok) return { ok: false, error: '对账仍不一致，暂不能恢复。请把这个问题反馈给开发者。', reconcile: rc }
    if (S.acct.status === 'locked') return { ok: false, error: '系统处于回撤锁定状态，请使用「解除锁定」' }
    const prev = S.acct.status
    S.acct.status = 'running'
    S.acct.status_reason = null
    S.acct.pause_keys = S.acct.pause_keys.filter((k) => PAUSE[k].auto)
    await saveAcct()
    await feed.logEvent('info', 'control', `人工恢复运行（之前状态：${prev === 'stopped' ? '紧急停止' : '暂停'}）`)
    return { ok: true }
  })
}

async function unlock() {
  return withLock(async () => {
    await load()
    if (S.acct.status !== 'locked') return { ok: false, error: '当前没有处于锁定状态' }
    const eq = equityNow()
    S.acct.status = 'running'
    S.acct.status_reason = null
    S.acct.peak_equity = eq // 以当前权益为新的峰值，否则会立刻再次锁定
    await saveAcct()
    await feed.logEvent('info', 'control', `人工解除回撤锁定，以当前权益 ${fmt(eq)} 作为新的峰值`)
    return { ok: true }
  })
}

async function setStrategy(name, enabled) {
  return withLock(async () => {
    await load()
    if (!STRATEGIES[name]) return { ok: false, error: '没有这个策略' }
    const set = new Set(S.acct.enabled_strategies)
    if (enabled) {
      set.add(name)
      delete S.acct.disabled_strategies[name]
    } else set.delete(name)
    S.acct.enabled_strategies = [...set]
    await saveAcct()
    await feed.logEvent('info', 'control', `${enabled ? '启用' : '停用'}策略：${STRATEGIES[name].label}`)
    return { ok: true }
  })
}

// ---------- 启动：对账 + 心跳检查 ----------
async function startup() {
  return withLock(async () => {
    await load(true)
    const t = now()
    const gap = S.acct.last_heartbeat ? t - S.acct.last_heartbeat : null
    const missed = gap != null && gap > cfg.paper.heartbeatEveryMs * cfg.paper.heartbeatMissing
    const unknown = await sweepUnknownOrders(true)
    const rc = await reconcile()
    await feed.logEvent(
      missed || !rc.ok ? 'warn' : 'info',
      'system',
      `系统启动，完成对账：${rc.ok ? '持仓一致' : '持仓不一致！'}${missed ? `；心跳中断约 ${Math.round(gap / 60000)} 分钟（期间系统可能宕机）` : ''}`,
      { reconcile: rc, gapMs: gap },
    )
    if (unknown > 0) await setPause('order_unknown', true, `${unknown} 笔`)
    if (!rc.ok) await setPause('reconcile', true, rc.diffs.map((d) => d.symbol).join('、'))
    S.acct.last_heartbeat = t
    await saveAcct()
  })
}

// ---------- 状态（给页面用，只读内存，不查数据库） ----------
function snapshot() {
  if (!S.loaded) return null
  const a = S.acct
  const eq = equityNow()
  const m = marks()
  const ex = risk.exposure(S.positions, m, eq)
  const dl = risk.dailyLoss(eq, a.day_start_equity)
  const dd = risk.drawdown(eq, a.peak_equity)
  const t = now()
  const state = a.status === 'locked' ? 'locked' : a.status === 'stopped' ? 'stopped' : a.pause_keys.length ? 'paused' : a.day_blocked ? 'day_blocked' : 'running'
  return {
    mode: cfg.mode,
    state,
    status: a.status,
    statusReason: a.status_reason,
    pauseKeys: a.pause_keys,
    pauseDefs: PAUSE,
    dayBlocked: a.day_blocked,
    startedAt: a.started_at,
    startingEquity: cfg.paperStartingEquity,
    equity: eq,
    cash: a.cash,
    unrealized: eq - a.cash,
    peakEquity: a.peak_equity,
    dayStartEquity: a.day_start_equity,
    gauges: {
      dailyChangePct: dl.changePct,
      dailyLimitPct: cfg.risk.dailyLossLimitPct,
      drawdownPct: dd.ddPct,
      drawdownLimitPct: cfg.risk.maxDrawdownPct,
      grossPct: eq > 0 ? (ex.gross / eq) * 100 : 0,
      grossLimitPct: cfg.risk.maxGrossExposurePct,
      leverage: ex.leverage,
      maxLeverage: cfg.risk.maxLeverage,
      bySymbolPct: Object.fromEntries(Object.entries(ex.bySymbol).map(([s, v]) => [s, eq > 0 ? (v / eq) * 100 : 0])),
      symbolLimitPct: cfg.risk.maxSymbolExposurePct,
      riskPerTradePct: cfg.risk.riskPerTradePct,
    },
    positions: Object.values(S.positions).map((p) => {
      const mk = m[p.symbol] ?? p.entry_px
      const u = p.side * p.qty * (mk - p.entry_px)
      return {
        ...p,
        strategyLabel: STRATEGIES[p.strategy]?.label ?? p.strategy,
        regimeLabel: LABELS[p.regime] ?? p.regime,
        mark: mk,
        notional: p.qty * mk,
        unrealized: u,
        stopDistancePct: (Math.abs(mk - p.stop) / mk) * 100,
        riskAtStop: p.side * p.qty * (p.stop - p.entry_px) - p.fees - p.funding,
      }
    }),
    strategies: Object.values(STRATEGIES).map((s) => ({
      name: s.name,
      label: s.label,
      enabled: a.enabled_strategies.includes(s.name),
      disabledReason: a.disabled_strategies[s.name] ?? null,
      allowedRegimes: s.allowedRegimes,
      invalidation: s.invalidation,
    })),
    quotes: Object.fromEntries(
      cfg.symbols.map((s) => {
        const q = S.quotes[s]
        return [s, q ? { last: q.last, index: q.index, ts: q.ts, at: q.at } : null]
      }),
    ),
    checks: S.lastChecks,
    apiErrors: S.apiErrors,
    reconcile: S.lastReconcile,
    lastHeartbeat: a.last_heartbeat,
    lastMonitorAt: S.lastMonitorAt,
    lastCycleAt: a.last_cycle_at,
    lastBarTs: a.last_bar_ts,
    nextCycleAt: Math.floor(t / H1) * H1 + H1 + 2 * 60_000,
    bootAt: S.bootAt,
    serverTime: t,
  }
}

/** 是否需要补跑每小时循环（例如整点那次因为重启错过了） */
function needsCycle() {
  if (!S.loaded) return false
  const t = now()
  const barTs = Math.floor(t / H1) * H1 - H1
  const minute = (t % H1) / 60_000
  return minute >= 5 && (S.acct.last_bar_ts == null || S.acct.last_bar_ts < barTs)
}

// 内部函数仅供测试脚本使用
const _t = { S, openPosition, closePosition, placeOrder, sweepUnknownOrders, riskSweep, saveAcct, withLock }

module.exports = { _t, needsCycle, load, monitor, runCycle, emergencyStop, resume, unlock, setStrategy, startup, snapshot, reconcile, PAUSE }
