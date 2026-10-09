// 模拟交易（PAPER）—— 只负责「接线」：取数据、喂给共用引擎 simulate.js、把结果落库
// 开仓、止损、资金费、仓位计算全部在 simulate.js 里，与回测是同一份代码（P0-1）。
//   每小时：barClose(刚收盘的 K 线) → barOpen(当前 K 线，用它的开盘价成交)
//   每分钟：数据检查 / 自动暂停 / 盘中止损（成交价规则与引擎相同：止损价，跳空按开盘价）/ 心跳 / 对账
// AI 不参与这里的任何决定；所有规则都是确定性代码。
// createPaper({ store, market }) 可注入存储与行情：正式运行用数据库 + OKX，等价性测试用内存 + 历史回放。
const cfg = require('./config')
const risk = require('./risk')
const orders = require('./orders')
const sim = require('./simulate')
const { STRATEGIES } = require('./strategies')
const { LABELS } = require('./regime')

const { H1, H8, DAY } = sim

// 自动暂停条件
const PAUSE = {
  stale: { label: `行情数据过期超过 ${cfg.staleDataSeconds} 秒`, auto: true },
  deviation: { label: `两个价格源偏差超过 ${cfg.priceSourceMaxDeviationPct}%`, auto: true },
  api_errors: { label: `连续接口错误 ≥ ${cfg.paper.maxApiErrors} 次`, auto: true },
  order_unknown: { label: `订单状态超过 ${cfg.paper.orderUnknownSeconds} 秒未知`, auto: false },
  reconcile: { label: '本地持仓与订单账本不一致', auto: false },
}

const sideName = (s) => (s > 0 ? '做多' : '做空')
const fmt = (x, d = 2) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

/** 锚定历史起点：指标与市场状态从这里起算（与回测 lab.loadData 的规则相同：historyDays 天前，按 4 小时对齐） */
const anchorFor = (ts, conf = cfg) => Math.floor((ts - conf.historyDays * DAY) / (4 * H1)) * 4 * H1

function liveMarket() {
  const okx = require('./okx')
  const feed = require('./feed')
  return {
    now: () => Date.now(),
    bars: (s, iv, from, to) => feed.loadBarsRange(s, iv, from, to),
    funding: (s, from, to) => feed.loadFundingRange(s, from, to),
    currentBar: (s) => okx.currentBar(s),
    quote: (s) => okx.quote(s),
  }
}

function createPaper({ store, market, conf = cfg, symbols = conf.symbols } = {}) {
  const now = () => market.now()
  const S = {
    loaded: false,
    meta: null, // 账户里不属于引擎的字段：暂停条件、心跳、开始时间等
    st: null, // 共用引擎状态
    curOpen: {}, // 当前 K 线开盘价（盘中止损跳空判断用）
    dbPos: new Set(),
    hist: {}, // 锚定历史缓存 symbol -> { b1, b4, series, funding: Map, fundTs }
    quotes: {},
    lastValid: {}, // 最近一次有效（未过期）报价 symbol -> { px, at }
    apiErrors: 0,
    healthy: {},
    inflight: new Map(),
    lastReconcile: null,
    lastMonitorAt: null,
    lastChecks: null,
    bootAt: now(),
    unknownCount: 0,
  }

  let chain = Promise.resolve()
  function withLock(fn) {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  // ---------- 读写 ----------
  function engineBlob(st) {
    return {
      v: 1,
      anchorTs: S.anchorTs,
      pending: st.pending,
      lastClose: st.lastClose,
      totals: st.totals,
      stratStats: st.stratStats,
      locked: st.locked,
      blockedDays: st.blockedDays,
      lastOpenTs: st.lastOpenTs,
      lastCloseTs: st.lastCloseTs,
      seq: st.seq,
      curOpen: S.curOpen,
    }
  }

  // P0-4 复现包：账户开始时落盘（只在正式数据库存储下；测试用内存存储不写）
  async function writeRepro(a, why) {
    if (store.kind !== 'db') return null
    const repro = require('./repro')
    const b = await repro.buildBundle({ startedAt: a.started_at, anchorTs: anchorFor(a.started_at, conf), conf, enabled: a.enabled_strategies || conf.paper.strategies })
    const id = await repro.save(b)
    await store.logEvent('info', 'system', `已保存复现包 #${id}（${why}）：配置 ${b.config_hash.slice(0, 12)}，代码 ${b.code_hash.slice(0, 12)}，commit ${b.git_commit?.slice(0, 8) ?? '无'}`, { id, config_hash: b.config_hash, git_commit: b.git_commit })
    return id
  }

  /** 清空模拟账户全部记录，从现在重新开始计时（会重新生成复现包） */
  async function resetAccount(reason = '') {
    return withLock(async () => {
      await store.wipe()
      S.loaded = false
      S.hist = {}
      S.inflight.clear()
      S.unknownCount = 0
      await load(true)
      await store.logEvent('warn', 'control', `模拟账户已重置，重新开始计时${reason ? `：${reason}` : ''}`)
      return { ok: true, startedAt: S.meta.started_at }
    })
  }

  async function load(force = false) {
    if (S.loaded && !force) return
    if (store.kind === 'db') await require('./settings').ensureLoaded()
    let a = await store.loadAccount()
    if (!a) {
      const t = now()
      const eq = conf.paperStartingEquity
      await store.insertAccount({
        status: 'running',
        pause_keys: [],
        cash: eq,
        peak_equity: eq,
        day_key: sim.dayKeyOf(t),
        day_start_equity: eq,
        day_blocked: false,
        enabled_strategies: [...conf.paper.strategies],
        disabled_strategies: {},
        started_at: t,
        updated_at: t,
        engine: null,
      })
      await store.logEvent('info', 'system', `模拟账户已创建，起始资金 ${eq.toLocaleString()} USDT`)
      a = await store.loadAccount()
      await writeRepro(a, '账户创建')
    }
    const e = a.engine || {}
    const st = sim.newState({ startEquity: conf.paperStartingEquity, enabled: a.enabled_strategies || conf.paper.strategies, invalidation: true, log: true })
    st.cash = a.cash
    st.peak = a.peak_equity
    st.dayKey = a.day_key
    st.dayStartEq = a.day_start_equity
    st.dayBlocked = !!a.day_blocked
    st.status = a.status
    st.statusReason = a.status_reason
    st.disabled = a.disabled_strategies || {}
    st.pending = e.pending || {}
    st.lastClose = e.lastClose || {}
    st.totals = { ...st.totals, ...(e.totals || {}) }
    st.stratStats = e.stratStats || {}
    st.locked = e.locked ?? null
    st.blockedDays = e.blockedDays || 0
    st.lastOpenTs = e.lastOpenTs ?? null
    st.lastCloseTs = e.lastCloseTs ?? a.last_bar_ts ?? null
    st.seq = e.seq || 0
    S.curOpen = e.curOpen || {}
    const pos = await store.loadPositions()
    st.positions = Object.fromEntries(pos.map((p) => [p.symbol, p]))
    S.dbPos = new Set(Object.keys(st.positions))
    S.st = st
    S.meta = {
      pause_keys: a.pause_keys || [],
      last_heartbeat: a.last_heartbeat,
      last_cycle_at: a.last_cycle_at,
      started_at: a.started_at,
    }
    const newAnchor = e.anchorTs ?? anchorFor(a.started_at, conf)
    if (S.anchorTs !== newAnchor) S.hist = {}
    S.anchorTs = newAnchor
    S.loaded = true
  }

  async function saveAcct() {
    const st = S.st
    await store.saveAccount({
      status: st.status,
      status_reason: st.statusReason,
      pause_keys: S.meta.pause_keys,
      cash: st.cash,
      peak_equity: st.peak,
      day_key: st.dayKey,
      day_start_equity: st.dayStartEq,
      day_blocked: st.dayBlocked,
      enabled_strategies: st.enabled,
      disabled_strategies: st.disabled,
      last_bar_ts: st.lastCloseTs,
      last_heartbeat: S.meta.last_heartbeat,
      last_cycle_at: S.meta.last_cycle_at,
      started_at: S.meta.started_at,
      updated_at: now(),
      engine: engineBlob(st),
    })
  }

  /** 把引擎这一步产生的成交、交易、资金费、日志写入存储（订单走状态机：SUBMITTED → FILLED） */
  async function flush() {
    const st = S.st
    const fills = st.fills.splice(0)
    const trades = st.trades.splice(0)
    const fundings = st.fundings.splice(0)
    const logs = st.log.splice(0)
    st.rejects.splice(0) // 原因已随 st.log 写入事件表
    const t = now()
    for (const f of fills) {
      const cid = orders.clientOrderId(f.source, f.signal_ts, f.symbol, f.intent)
      let o = { client_order_id: cid, status: 'PENDING', history: [] }
      o = orders.transition(o, 'SUBMITTED', '提交到模拟撮合', t)
      const id = await store.insertOrder({ ...o, symbol: f.symbol, side: f.side, intent: f.intent, qty: f.qty, ref_px: f.ref_px, reason: f.reason, strategy: f.strategy, signal_ts: f.signal_ts, fill_ts: f.ts, created_at: t })
      if (id == null) {
        await store.logEvent('error', 'order', `重复订单号：${cid}（同一信号不应执行两次），已暂停开新仓待人工核对`, { cid })
        await setPause('reconcile', true, `重复订单 ${cid}`)
        continue
      }
      S.inflight.set(cid, t)
      const done = orders.transition(o, 'FILLED', `成交价 ${fmt(f.px, 4)}`, t)
      await store.updateOrder(id, { status: 'FILLED', fill_px: f.px, fee: f.fee, slippage: f.slippage, history: done.history, updated_at: t })
      S.inflight.delete(cid)
      if (f.intent === 'open') {
        const p = st.positions[f.symbol]
        await store.logEvent('info', 'order', `开仓 ${f.symbol} ${sideName(f.side)} ${f.qty.toPrecision(4)} @ ${fmt(f.px, 4)}${p ? `，止损 ${fmt(p.stop, 4)}` : ''}（${STRATEGIES[f.strategy]?.label ?? f.strategy}）`, { cid })
      }
    }
    for (const tr of trades) {
      await store.insertTrade(tr)
      await store.logEvent(tr.pnl >= 0 ? 'info' : 'warn', 'trade', `平仓 ${tr.symbol}（${tr.reason}）@ ${fmt(tr.exit_px, 4)}，净盈亏 ${tr.pnl >= 0 ? '+' : ''}${fmt(tr.pnl)} USDT`, { pnl: tr.pnl })
    }
    for (const fe of fundings) await store.insertFunding(fe)
    for (const l of logs) await store.logEvent(l.level, l.type, l.msg, l.detail)
    for (const p of Object.values(st.positions)) await store.upsertPosition(p)
    for (const s of S.dbPos) if (!st.positions[s]) await store.deletePosition(s)
    S.dbPos = new Set(Object.keys(st.positions))
    await saveAcct()
  }

  // ---------- 锚定历史 ----------
  async function refreshHistory(barTs) {
    const to = barTs + H1
    for (const s of symbols) {
      let h = S.hist[s]
      if (!h) {
        const [b1, b4, f] = await Promise.all([market.bars(s, '1h', S.anchorTs, to), market.bars(s, '4h', S.anchorTs, to), market.funding(s, S.anchorTs, to + 1)])
        h = S.hist[s] = { b1, b4, series: null, funding: new Map(f.map((x) => [x.ts, x.rate])), fundTs: f.length ? f[f.length - 1].ts : S.anchorTs - 1 }
      } else {
        const last1 = h.b1.length ? h.b1[h.b1.length - 1].ts : S.anchorTs - 1
        const last4 = h.b4.length ? h.b4[h.b4.length - 1].ts : S.anchorTs - 1
        const [n1, n4, f] = await Promise.all([market.bars(s, '1h', last1 + 1, to), market.bars(s, '4h', last4 + 1, to), market.funding(s, h.fundTs + 1, to + H8)])
        if (!n1.length && !n4.length && h.series) {
          for (const x of f) h.funding.set(x.ts, x.rate)
          if (f.length) h.fundTs = f[f.length - 1].ts
          continue
        }
        h.b1 = h.b1.concat(n1)
        h.b4 = h.b4.concat(n4)
        for (const x of f) h.funding.set(x.ts, x.rate)
        if (f.length) h.fundTs = f[f.length - 1].ts
      }
      h.series = sim.buildSeries(h.b1, h.b4, h.series && h.series.bars.length <= h.b1.length ? h.series : null)
    }
    // 资金费：结算时刻的费率可能刚出，补读一次
    return Object.fromEntries(symbols.map((s) => [s, S.hist[s].series]))
  }

  // ---------- 自动暂停 ----------
  async function setPause(key, active, detail, extra = null) {
    const m = S.meta
    const has = m.pause_keys.includes(key)
    if (active) {
      S.healthy[key] = 0
      if (!has) {
        m.pause_keys = [...m.pause_keys, key]
        await saveAcct()
        await store.logEvent(extra?.drill ? 'warn' : 'error', 'auto_pause', `${extra?.drill ? '【演练】' : ''}自动暂停开新仓：${PAUSE[key].label}${detail ? `（${detail}）` : ''}`, { key, detail, ...(extra || {}) })
      }
      return
    }
    if (!has || !PAUSE[key].auto) return
    S.healthy[key] = (S.healthy[key] || 0) + 1
    if (S.healthy[key] >= conf.paper.autoResumeHealthyChecks) {
      m.pause_keys = m.pause_keys.filter((k) => k !== key)
      S.healthy[key] = 0
      await saveAcct()
      await store.logEvent('info', 'auto_resume', `自动恢复：${PAUSE[key].label} 已连续 ${conf.paper.autoResumeHealthyChecks} 次检查正常`, { key })
    }
  }

  /** 对账：把所有已成交订单重放一遍，得到的持仓应与持仓表、内存一致 */
  async function reconcile() {
    const ledgerNet = await store.ledgerNet()
    const dbPos = Object.fromEntries((await store.loadPositions()).map((p) => [p.symbol, p.side * p.qty]))
    const diffs = []
    for (const s of new Set([...Object.keys(ledgerNet), ...Object.keys(dbPos), ...Object.keys(S.st.positions)])) {
      const l = ledgerNet[s] || 0
      const d = dbPos[s] || 0
      const m = S.st.positions[s] ? S.st.positions[s].side * S.st.positions[s].qty : 0
      const tol = 1e-9 * Math.max(1, Math.abs(l), Math.abs(d))
      if (Math.abs(l - d) > tol || Math.abs(m - d) > tol) diffs.push({ symbol: s, ledger: l, positions: d, memory: m })
    }
    S.lastReconcile = { at: now(), ok: diffs.length === 0, diffs }
    return S.lastReconcile
  }

  async function sweepUnknownOrders(fromDb = false) {
    const limit = conf.paper.orderUnknownSeconds * 1000
    const t = now()
    const stuck = []
    for (const [cid, since] of S.inflight) if (t - since > limit) stuck.push(cid)
    if (fromDb) for (const cid of await store.stuckOrderIds(t - limit)) if (!stuck.includes(cid)) stuck.push(cid)
    for (const cid of stuck) {
      const o = await store.getOrder(cid)
      S.inflight.delete(cid)
      if (!o || orders.isFinal(o.status) || o.status === 'UNKNOWN') continue
      const next = orders.transition(o, 'UNKNOWN', `超过 ${conf.paper.orderUnknownSeconds} 秒没有结果`)
      await store.updateOrder(o.id, { status: next.status, fill_px: o.fill_px, fee: o.fee, slippage: o.slippage, history: next.history, updated_at: next.updated_at })
    }
    if (stuck.length || fromDb) S.unknownCount = await store.countUnknown()
    return S.unknownCount
  }

  // ---------- 行情 ----------
  async function fetchQuotes() {
    const out = {}
    for (const s of symbols) {
      try {
        const q = await market.quote(s)
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
  function liveMarks() {
    return Object.fromEntries(
      symbols.map((s) => {
        const q = S.quotes[s]
        return [s, q && now() - q.at < 5 * 60_000 ? q.last : S.st.lastClose[s] ?? S.st.positions[s]?.entry_px ?? null]
      }),
    )
  }

  // ---------- 每分钟巡检 ----------
  async function monitor() {
    return withLock(async () => {
      await load()
      const t = now()
      const quotes = await fetchQuotes()
      const per = {}
      for (const s of symbols) per[s] = risk.dataChecks(quotes[s], t, conf)
      const staleBad = symbols.filter((s) => !per[s].stale.ok)
      const devBad = symbols.filter((s) => per[s].deviation.ok === false && quotes[s])
      await setPause('stale', staleBad.length > 0, staleBad.map((s) => `${s} ${per[s].stale.detail}`).join('；'))
      await setPause('deviation', devBad.length > 0, devBad.map((s) => `${s} ${per[s].deviation.detail}`).join('；'))
      await setPause('api_errors', S.apiErrors >= conf.paper.maxApiErrors, `连续 ${S.apiErrors} 次`)

      const heartbeatDue = !S.meta.last_heartbeat || t - S.meta.last_heartbeat >= conf.paper.heartbeatEveryMs - 5000
      const unknown = await sweepUnknownOrders(heartbeatDue)
      if (unknown > 0) await setPause('order_unknown', true, `${unknown} 笔`)

      // 盘中止损：用实时价判断是否触发；成交价按引擎规则（止损价，开盘已跳空则按开盘价），记在当前 K 线
      let changed = false
      const barNow = Math.floor(t / H1) * H1
      // 最近有效价：最近一次拿到的有限价格（可能已过期），按报价自身时间记录
      for (const s of symbols) if (quotes[s] && Number.isFinite(quotes[s].last) && quotes[s].last > 0) S.lastValid[s] = { px: quotes[s].last, at: quotes[s].ts ?? t }
      for (const [s, p] of Object.entries({ ...S.st.positions })) {
        // P2-2：数据过期 / 取不到行情（暂停开新仓期间）仍用最近一次有效价判断止损，止损保护不中断
        const fresh = quotes[s] && per[s].stale.ok
        const q = fresh ? quotes[s] : S.lastValid[s] ? { last: S.lastValid[s].px } : null // 止损价可能已在整点上移（移动止损），旧价格也可能已穿过
        if (!q) continue
        if (S.st.lastOpenTs !== barNow) continue // 本根 K 线还没开盘结算（整点循环未跑），交给整点循环按 K 线高低价处理
        if (p.entry_ts > barNow) continue
        const hit = p.side > 0 ? q.last <= p.stop : q.last >= p.stop
        if (!hit) continue
        sim.closeAtStop(S.st, s, S.curOpen[s] ?? p.stop, barNow, conf)
        if (!fresh) await store.logEvent('warn', 'risk', `${s} 行情过期，用最近有效价 ${fmt(q.last, 4)}（${Math.round((t - S.lastValid[s].at) / 1000)} 秒前）判断止损已触发，已平仓`)
        changed = true
      }
      if (changed) await flush()

      if (heartbeatDue) {
        const rc = await reconcile()
        if (!rc.ok) await setPause('reconcile', true, rc.diffs.map((d) => d.symbol).join('、'))
        S.meta.last_heartbeat = t
        await saveAcct()
      }
      S.lastMonitorAt = t
      S.lastChecks = { at: t, per, apiErrors: S.apiErrors, unknown }
      return S.lastChecks
    })
  }

  // ---------- 每小时循环 ----------
  async function runCycle(regimes = null) {
    return withLock(async () => {
      await load()
      const t = now()
      const barTs = Math.floor(t / H1) * H1 - H1 // 刚收盘的那根
      const st = S.st
      if (st.lastCloseTs != null && st.lastCloseTs >= barTs) {
        return { skipped: true, reason: `这根 K 线（${new Date(barTs).toISOString().slice(11, 16)} UTC）已经处理过，不会重复下单` }
      }
      const series = await refreshHistory(barTs)
      await fetchQuotes()
      const indicators = sim.indicatorCache(series)
      const fundingRate = (s, ts) => S.hist[s].funding.get(ts) ?? null
      const liveRegime = Object.fromEntries((regimes || []).map((r) => [r.symbol, r]))
      const spreadGate = Object.fromEntries(symbols.map((s) => [s, liveRegime[s]?.metrics?.spreadPct > conf.regime.maxSpreadPct ? ['盘口价差过大'] : []]))
      const gates = { pauseKeys: S.meta.pause_keys.map((k) => PAUSE[k]?.label ?? k), bySymbol: spreadGate }
      const report = {}
      const base = { symbols, paramsAt: (name) => ({ ...STRATEGIES[name].defaults }), regimeFilter: true, ddLock: true, conf, report }

      // 需要处理的已收盘 K 线（正常只有 1 根；宕机后补跑多根，补跑的旧 K 线不开新仓）
      const first = st.lastCloseTs == null ? barTs : st.lastCloseTs + H1
      const histOpen = (ts) => Object.fromEntries(symbols.map((s) => [s, series[s].bars[series[s].idx.get(ts)]?.open]))
      for (let ts = first; ts <= barTs; ts += H1) {
        const latest = ts === barTs
        if (st.lastOpenTs == null || st.lastOpenTs < ts) sim.barOpen(st, ts, { open: histOpen(ts), fundingRate, gates }, { ...base, allowEntries: false, report: latest ? report : null })
        sim.barClose(st, ts, { series, indicators }, { ...base, allowEntries: latest, report: latest ? report : null })
      }

      // 当前 K 线开盘：资金费 → 离场 → 开仓
      const late = t - (barTs + H1) > 10 * 60_000
      const open = {}
      for (const s of symbols) {
        let cur = null
        try {
          cur = await market.currentBar(s)
          if (cur.ts !== barTs + H1) cur = null
        } catch {
          cur = null
        }
        S.curOpen[s] = cur?.open ?? null
        // 正常情况（收盘后 2 分钟内）按本根开盘价成交，与回测一致；补跑（晚于 10 分钟）改用实时价，避免"用过去的价格成交"
        open[s] = cur ? (late ? S.quotes[s]?.last ?? undefined : cur.open) : undefined
        if (late && open[s] != null) (report[s] ??= { actions: [], notes: [] }).notes.push('本次为补跑，按实时价格成交')
      }
      sim.barOpen(st, barTs + H1, { open, fundingRate, gates }, { ...base, allowEntries: true })
      await flush()

      // 记录净值（按收盘价估值，与回测同口径）与决策
      const lg = sim.ledger(st)
      const ex = risk.exposure(st.positions, st.lastClose, lg.equity, conf)
      await store.insertEquity({ ts: barTs + H1, equity: lg.equity, cash: lg.cash, unrealized: lg.unrealized, exposure: ex.gross, drawdown_pct: risk.drawdown(lg.equity, st.peak, conf).ddPct, positions: Object.keys(st.positions).length })
      const decisions = symbols.map((s) => {
        const S1 = series[s]
        const i = S1.idx.get(barTs)
        const r = report[s] || { actions: [], notes: [] }
        const regime = i != null ? S1.regimes[i] : 'unclear'
        return {
          symbol: s,
          regime,
          regimeLabel: LABELS[regime] ?? regime,
          barTs: i != null ? barTs : S1.bars[S1.bars.length - 1]?.ts ?? null,
          close: i != null ? S1.bars[i].close : null,
          fresh: i != null,
          nextOpen: open[s] ?? null,
          actions: r.actions,
          notes: r.notes,
          signal: r.signal,
          risk: r.risk,
        }
      })
      const summary = { equity: lg.equity, ledger: lg, status: st.status, pauseKeys: S.meta.pause_keys, dayBlocked: st.dayBlocked, decisions }
      await store.insertCycle({ ts: t, bar_ts: barTs, summary })
      S.meta.last_cycle_at = t
      await saveAcct()
      return summary
    })
  }

  // ---------- 人工操作 ----------
  async function flattenAll(reason, source) {
    const t = now()
    const out = []
    for (const s of Object.keys(S.st.positions)) {
      let px
      try {
        const q = await market.quote(s)
        S.quotes[s] = { ...q, at: now() }
        px = q.last
      } catch {
        px = liveMarks()[s]
      }
      const tr = sim.closeAtMarket(S.st, s, px, t, reason, source, conf)
      out.push({ symbol: s, pnl: tr.pnl })
    }
    for (const s of Object.keys(S.st.pending)) delete S.st.pending[s]
    await flush()
    return out
  }

  async function emergencyStop(note = '') {
    return withLock(async () => {
      await load()
      const prev = S.st.status
      S.st.status = 'stopped'
      S.st.statusReason = `紧急停止（${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')} UTC）${note ? `：${note}` : ''}`
      const closed = await flattenAll('紧急停止', 'manual')
      await store.logEvent('error', 'control', `紧急停止：已平掉 ${closed.length} 个持仓，停止开新仓（之前状态：${prev}）`, { closed })
      return { closed }
    })
  }

  async function resume() {
    return withLock(async () => {
      await load()
      const unk = await store.ordersByStatus('UNKNOWN')
      if (unk.length) {
        const rc = await reconcile()
        const diff = Object.fromEntries(rc.diffs.map((d) => [d.symbol, d.positions - d.ledger]))
        for (const o of unk) {
          const signed = Number(o.side) * Number(o.qty)
          const left = diff[o.symbol] || 0
          const to = Math.abs(left - signed) < 1e-9 * Math.max(1, Math.abs(signed)) ? 'FILLED' : 'CANCELED'
          if (to === 'FILLED') diff[o.symbol] = left - signed
          const next = orders.transition(o, to, '人工恢复时按持仓表对账处理')
          await store.updateOrder(o.id, { status: to, fill_px: o.fill_px, fee: o.fee, slippage: o.slippage, history: next.history, updated_at: next.updated_at })
        }
        S.unknownCount = 0
      }
      await load(true)
      const rc = await reconcile()
      if (!rc.ok) return { ok: false, error: '对账仍不一致，暂不能恢复。请把这个问题反馈给开发者。', reconcile: rc }
      if (S.st.status === 'locked') return { ok: false, error: '系统处于回撤锁定状态，请使用「解除锁定」' }
      const prev = S.st.status
      S.st.status = 'running'
      S.st.statusReason = null
      S.meta.pause_keys = S.meta.pause_keys.filter((k) => PAUSE[k].auto)
      await saveAcct()
      await store.logEvent('info', 'control', `人工恢复运行（之前状态：${prev === 'stopped' ? '紧急停止' : '暂停'}）`)
      return { ok: true }
    })
  }

  async function unlock() {
    return withLock(async () => {
      await load()
      if (S.st.status !== 'locked') return { ok: false, error: '当前没有处于锁定状态' }
      const eq = sim.equity(S.st)
      S.st.status = 'running'
      S.st.statusReason = null
      S.st.locked = null
      S.st.peak = eq // 以当前权益为新的峰值，否则会立刻再次锁定
      await saveAcct()
      await store.logEvent('info', 'control', `人工解除回撤锁定，以当前权益 ${fmt(eq)} 作为新的峰值`)
      return { ok: true }
    })
  }

  async function setStrategy(name, enabled) {
    return withLock(async () => {
      await load()
      if (!STRATEGIES[name]) return { ok: false, error: '没有这个策略' }
      const set = new Set(S.st.enabled)
      if (enabled) {
        set.add(name)
        delete S.st.disabled[name]
      } else set.delete(name)
      S.st.enabled = Object.keys(STRATEGIES).filter((k) => set.has(k))
      await saveAcct()
      await store.logEvent('info', 'control', `${enabled ? '启用' : '停用'}策略：${STRATEGIES[name].label}`)
      return { ok: true }
    })
  }

  async function drillPause(key) {
    return withLock(async () => {
      await load()
      if (!PAUSE[key]) return { ok: false, error: '没有这个暂停条件' }
      if (S.st.status !== 'running') return { ok: false, error: '系统当前不是正常运行状态，不能演练' }
      if (S.meta.pause_keys.length) return { ok: false, error: '已有暂停条件在生效，等它恢复后再演练' }
      const m = (now() % H1) / 60_000
      if (m < 8 || m > 50) return { ok: false, error: '为了不影响整点交易，演练只能在每小时第 8–50 分钟进行' }
      await setPause(key, true, '故障演练，人为触发', { drill: true })
      return { ok: true, auto: PAUSE[key].auto }
    })
  }

  async function startup() {
    return withLock(async () => {
      await load(true)
      const t = now()
      const gap = S.meta.last_heartbeat ? t - S.meta.last_heartbeat : null
      const missed = gap != null && gap > conf.paper.heartbeatEveryMs * conf.paper.heartbeatMissing
      const unknown = await sweepUnknownOrders(true)
      const rc = await reconcile()
      await store.logEvent(
        missed || !rc.ok ? 'warn' : 'info',
        'system',
        `系统启动，完成对账：${rc.ok ? '持仓一致' : '持仓不一致！'}${missed ? `；心跳中断约 ${Math.round(gap / 60000)} 分钟（期间系统可能宕机）` : ''}`,
        { reconcile: rc, gapMs: gap },
      )
      if (unknown > 0) await setPause('order_unknown', true, `${unknown} 笔`)
      if (!rc.ok) await setPause('reconcile', true, rc.diffs.map((d) => d.symbol).join('、'))
      if (store.kind === 'db' && !(await require('./repro').latest(S.meta.started_at))) {
        await writeRepro({ started_at: S.meta.started_at, enabled_strategies: [...S.st.enabled] }, '补建：账户早于复现包功能')
      }
      S.meta.last_heartbeat = t
      await saveAcct()
    })
  }

  // ---------- 状态（给页面用，只读内存） ----------
  function snapshot() {
    if (!S.loaded) return null
    const st = S.st
    const m = liveMarks()
    const eq = sim.equity(st, m)
    const ex = risk.exposure(st.positions, m, eq, conf)
    const dl = risk.dailyLoss(eq, st.dayStartEq, conf)
    const dd = risk.drawdown(eq, st.peak, conf)
    const t = now()
    const state = st.status === 'locked' ? 'locked' : st.status === 'stopped' ? 'stopped' : S.meta.pause_keys.length ? 'paused' : st.dayBlocked ? 'day_blocked' : 'running'
    return {
      mode: conf.mode,
      state,
      status: st.status,
      statusReason: st.statusReason,
      pauseKeys: S.meta.pause_keys,
      pauseDefs: PAUSE,
      dayBlocked: st.dayBlocked,
      startedAt: S.meta.started_at,
      startingEquity: conf.paperStartingEquity,
      equity: eq,
      cash: st.cash,
      unrealized: eq - st.cash,
      ledger: sim.ledger(st),
      peakEquity: st.peak,
      dayStartEquity: st.dayStartEq,
      pending: st.pending,
      gauges: {
        dailyChangePct: dl.changePct,
        dailyLimitPct: conf.risk.dailyLossLimitPct,
        drawdownPct: dd.ddPct,
        drawdownLimitPct: conf.risk.maxDrawdownPct,
        grossPct: eq > 0 ? (ex.gross / eq) * 100 : 0,
        grossLimitPct: conf.risk.maxGrossExposurePct,
        leverage: ex.leverage,
        maxLeverage: conf.risk.maxLeverage,
        bySymbolPct: Object.fromEntries(Object.entries(ex.bySymbol).map(([s, v]) => [s, eq > 0 ? (v / eq) * 100 : 0])),
        symbolLimitPct: conf.risk.maxSymbolExposurePct,
        byGroupPct: Object.fromEntries(Object.entries(ex.byGroup).map(([g, v]) => [g, eq > 0 ? (v / eq) * 100 : 0])),
        groupLimitPct: conf.risk.maxGroupExposurePct,
        riskPerTradePct: conf.risk.riskPerTradePct,
      },
      positions: Object.values(st.positions).map((p) => {
        const mk = m[p.symbol] ?? p.entry_px
        return {
          ...p,
          strategyLabel: STRATEGIES[p.strategy]?.label ?? p.strategy,
          regimeLabel: LABELS[p.regime] ?? p.regime,
          mark: mk,
          notional: p.qty * mk,
          unrealized: p.side * p.qty * (mk - p.entry_px),
          stopDistancePct: (Math.abs(mk - p.stop) / mk) * 100,
          riskAtStop: p.side * p.qty * (p.stop - p.entry_px) - p.fees - p.funding,
        }
      }),
      strategies: Object.values(STRATEGIES).map((s) => ({
        name: s.name,
        label: s.label,
        enabled: st.enabled.includes(s.name),
        disabledReason: st.disabled[s.name] ?? null,
        allowedRegimes: s.allowedRegimes,
        invalidation: s.invalidation,
      })),
      quotes: Object.fromEntries(
        symbols.map((s) => {
          const q = S.quotes[s]
          return [s, q ? { last: q.last, index: q.index, ts: q.ts, at: q.at } : null]
        }),
      ),
      checks: S.lastChecks,
      apiErrors: S.apiErrors,
      reconcile: S.lastReconcile,
      lastHeartbeat: S.meta.last_heartbeat,
      lastMonitorAt: S.lastMonitorAt,
      lastCycleAt: S.meta.last_cycle_at,
      lastBarTs: st.lastCloseTs,
      anchorTs: S.anchorTs,
      nextCycleAt: Math.floor(t / H1) * H1 + H1 + 2 * 60_000,
      bootAt: S.bootAt,
      serverTime: t,
    }
  }

  function needsCycle() {
    if (!S.loaded) return false
    const t = now()
    const barTs = Math.floor(t / H1) * H1 - H1
    const minute = (t % H1) / 60_000
    return minute >= 5 && (S.st.lastCloseTs == null || S.st.lastCloseTs < barTs)
  }

  return { S, store, resetAccount, drillPause, needsCycle, load, monitor, runCycle, emergencyStop, resume, unlock, setStrategy, startup, snapshot, reconcile, sweepUnknownOrders, setPause, saveAcct, flush, PAUSE }
}

// 正式实例：数据库 + OKX 实时行情
let live = null
function getLive() {
  if (!live) live = createPaper({ store: require('./paperStore').dbStore(), market: liveMarket() })
  return live
}

module.exports = {
  createPaper,
  liveMarket,
  anchorFor,
  PAUSE,
  load: (...a) => getLive().load(...a),
  monitor: (...a) => getLive().monitor(...a),
  runCycle: (...a) => getLive().runCycle(...a),
  emergencyStop: (...a) => getLive().emergencyStop(...a),
  resume: (...a) => getLive().resume(...a),
  unlock: (...a) => getLive().unlock(...a),
  setStrategy: (...a) => getLive().setStrategy(...a),
  drillPause: (...a) => getLive().drillPause(...a),
  startup: (...a) => getLive().startup(...a),
  snapshot: (...a) => getLive().snapshot(...a),
  reconcile: (...a) => getLive().reconcile(...a),
  needsCycle: (...a) => getLive().needsCycle(...a),
  resetAccount: (...a) => getLive().resetAccount(...a),
}
