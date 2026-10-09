// 回测实验室：完整回测 + 滚动样本外验证 + 参数敏感性 + 验收判定
// 全部在本地计算，只读数据库里的 K 线 / 资金费率，不调用任何付费接口
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const feed = require('./feed')
const { buildSeries } = require('./simulate')
const { STRATEGIES, expandGrid } = require('./strategies')
const { runBacktest, metrics, dailyCurve } = require('./backtest')

const DAY = 86400_000

/**
 * 读取锚定历史：K 线从 anchorTs 开始（指标、市场状态都从这里起算，模拟盘用同一个锚点），到 toTs 为止。
 * 不传 anchorTs 时取最近 historyDays 天。
 */
async function loadData(symbols, { anchorTs = null, toTs = Number.MAX_SAFE_INTEGER } = {}) {
  const data = {}
  const anchor = anchorTs ?? Math.floor((Date.now() - cfg.historyDays * DAY) / (4 * 3600_000)) * 4 * 3600_000
  for (const s of symbols) {
    const [b1, b4, f] = await Promise.all([feed.loadBarsRange(s, '1h', anchor, toTs), feed.loadBarsRange(s, '4h', anchor, toTs), feed.loadFunding(s)])
    if (b1.length < 24 * 60) throw new Error(`${s} 历史数据不足，请先同步行情`)
    const series = buildSeries(b1, b4)
    data[s] = { ...series, funding: new Map(f.map((x) => [x.ts, x.rate])), fundingFrom: f[0]?.ts ?? null }
  }
  return data
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d)
const roundM = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]))

function trainScore(m) {
  if (m.trades < cfg.backtest.minTrainTrades) return -Infinity
  return m.sharpe
}

function marketLabel(data, from, to) {
  const bars = data[Object.keys(data)[0]].bars
  const a = bars.find((b) => b.ts >= from)
  const z = [...bars].reverse().find((b) => b.ts < to)
  if (!a || !z) return { label: '—', changePct: null }
  const ch = (z.close / a.open - 1) * 100
  return { label: ch > 10 ? '上涨' : ch < -10 ? '下跌' : '震荡', changePct: round(ch) }
}

async function runLab(req) {
  await require('./settings').ensureLoaded()
  const symbols = (req.symbols?.length ? req.symbols : cfg.symbols).filter((s) => cfg.symbols.includes(s))
  const strategies = (req.strategies?.length ? req.strategies : Object.keys(STRATEGIES)).filter((s) => STRATEGIES[s])
  const regimeFilter = req.regimeFilter !== false
  const ddLock = !!req.ddLock
  const data = await loadData(symbols)
  const cache = new Map()

  const allTs = data[symbols[0]].bars.map((b) => b.ts)
  const start = allTs[0] + cfg.backtest.warmupDays * DAY
  const end = allTs[allTs.length - 1] + 3600_000

  const defaults = Object.fromEntries(strategies.map((n) => [n, { ...STRATEGIES[n].defaults }]))
  const run = (from, to, paramsAt, strats = strategies) =>
    runBacktest(data, { strategies: strats, paramsAt, from, to, regimeFilter, ddLock, cache })

  // ===== 1. 全周期回测（默认参数）=====
  const main = run(start, end, (n) => defaults[n])
  const mainM = metrics(main)

  // 买入持有基准（等权）
  const bench = []
  {
    const firstPx = Object.fromEntries(symbols.map((s) => [s, data[s].bars.find((b) => b.ts >= start)?.open]))
    const daily = dailyCurve(main.hourly)
    const lastClose = {}
    const ptr = Object.fromEntries(symbols.map((s) => [s, 0]))
    for (const d of daily) {
      for (const s of symbols) {
        const bars = data[s].bars
        while (ptr[s] < bars.length && bars[ptr[s]].ts < d.ts + DAY) lastClose[s] = bars[ptr[s]++].close
      }
      const v = symbols.reduce((a, s) => a + (lastClose[s] / firstPx[s]) * (cfg.paperStartingEquity / symbols.length), 0)
      bench.push({ ts: d.ts, equity: v })
    }
  }

  // 按策略 / 市场状态 / 标的拆分
  const breakdown = (key) => {
    const g = {}
    for (const t of main.trades) {
      const k = t[key]
      g[k] ??= { key: k, trades: 0, pnl: 0, wins: 0 }
      g[k].trades++
      g[k].pnl += t.pnl
      if (t.pnl > 0) g[k].wins++
    }
    return Object.values(g).map((x) => ({ ...x, pnl: round(x.pnl), winRatePct: round((x.wins / x.trades) * 100) }))
  }

  // 市场状态时间占比
  const regimeShare = {}
  for (const s of symbols) {
    data[s].bars.forEach((b, i) => {
      if (b.ts < start) return
      const r = data[s].regimes[i]
      regimeShare[r] = (regimeShare[r] || 0) + 1
    })
  }
  const totalBars = Object.values(regimeShare).reduce((a, b) => a + b, 0)

  // ===== 2. 滚动样本外验证（walk-forward）=====
  const { trainDays, testDays, stepDays } = cfg.backtest
  const folds = []
  for (let t0 = start; t0 + (trainDays + testDays) * DAY <= end; t0 += stepDays * DAY) {
    const trainEnd = t0 + trainDays * DAY
    const testEnd = trainEnd + testDays * DAY
    const chosen = {}
    for (const n of strategies) {
      let best = { score: -Infinity, p: defaults[n] }
      for (const p of expandGrid(STRATEGIES[n].grid, STRATEGIES[n].defaults)) {
        const m = metrics(run(t0, trainEnd, () => p, [n]))
        const sc = trainScore(m)
        if (sc > best.score) best = { score: sc, p }
      }
      chosen[n] = best.p
    }
    const isM = metrics(run(t0, trainEnd, (n) => chosen[n]))
    const oosM = metrics(run(trainEnd, testEnd, (n) => chosen[n]))
    folds.push({ trainStart: t0, trainEnd, testEnd, params: chosen, inSample: roundM(isM), outOfSample: roundM(oosM), market: marketLabel(data, trainEnd, testEnd) })
  }

  // 拼接样本外：每个窗口只取前 stepDays 天（最后一个窗口取完整），参数在边界切换，不重叠
  let wf = null
  if (folds.length) {
    const segs = folds.map((f, k) => ({ from: f.trainEnd, to: k === folds.length - 1 ? f.testEnd : f.trainEnd + stepDays * DAY, params: f.params }))
    const paramsAt = (n, ts) => (segs.find((s) => ts >= s.from && ts < s.to) ?? segs[segs.length - 1]).params[n]
    const oos = run(segs[0].from, segs[segs.length - 1].to, paramsAt)
    const m = metrics(oos)
    const isAvg = folds.reduce((a, f) => a + f.inSample.sharpe, 0) / folds.length
    const markets = new Set(folds.map((f) => f.market.label))
    wf = {
      metrics: roundM(m),
      curve: dailyCurve(oos.hourly).map((d) => ({ ts: d.ts, equity: round(d.equity) })),
      from: segs[0].from,
      to: segs[segs.length - 1].to,
      avgInSampleSharpe: round(isAvg),
      coverage: { up: markets.has('上涨'), down: markets.has('下跌'), range: markets.has('震荡') },
      totals: Object.fromEntries(Object.entries(oos.totals).map(([k, v]) => [k, round(v)])),
    }
  }

  // ===== 3. 参数敏感性（±20%）=====
  const sensitivity = []
  for (const n of strategies) {
    const st = STRATEGIES[n]
    for (const key of st.sensitivityKeys) {
      for (const f of [0.8, 1.2]) {
        const p = { ...defaults[n], [key]: defaults[n][key] * f }
        if (key === 'rsiLow') p.rsiHigh = 100 - p.rsiLow
        if (key === 'fast' || key === 'slow') p[key] = Math.round(p[key])
        const m = metrics(run(start, end, (nn) => (nn === n ? p : defaults[nn])))
        sensitivity.push({ strategy: n, param: key, label: st.paramLabels[key], factor: f, value: round(p[key]), sharpe: round(m.sharpe), totalReturnPct: round(m.totalReturnPct), maxDrawdownPct: round(m.maxDrawdownPct), trades: m.trades })
      }
    }
  }
  const baseSharpe = mainM.sharpe
  const collapsed = sensitivity.filter((x) => (baseSharpe > 0 ? x.sharpe < baseSharpe * 0.5 : x.sharpe < baseSharpe - 0.5))
  // 策略本身不赚钱时，"稳定"没有意义，不予通过
  const stable = baseSharpe > 0 && collapsed.length === 0

  // ===== 4. 验收判定（对照设计文档）=====
  const checks = wf
    ? [
        { key: 'sharpe', label: '样本外夏普比率 > 1.0', value: round(wf.metrics.sharpe), pass: wf.metrics.sharpe > 1 },
        { key: 'mdd', label: '样本外最大回撤 < 15%', value: `${round(wf.metrics.maxDrawdownPct)}%`, pass: wf.metrics.maxDrawdownPct < 15 },
        { key: 'trades', label: '样本外交易笔数 > 100', value: wf.metrics.trades, pass: wf.metrics.trades > 100 },
        { key: 'coverage', label: '验证期覆盖上涨、下跌、震荡行情', value: [wf.coverage.up && '上涨', wf.coverage.down && '下跌', wf.coverage.range && '震荡'].filter(Boolean).join(' / ') || '—', pass: wf.coverage.up && wf.coverage.down && wf.coverage.range },
        { key: 'stable', label: '参数 ±20% 扰动后不崩塌', value: baseSharpe <= 0 ? '基础参数本身亏损，不适用' : stable ? '稳定' : `${collapsed.length} 项明显变差`, pass: stable },
      ]
    : []

  const fundingFrom = Math.min(...symbols.map((s) => data[s].fundingFrom ?? Infinity))
  const summary = {
    symbols,
    strategies,
    regimeFilter,
    ddLock,
    from: start,
    to: end,
    totalReturnPct: round(mainM.totalReturnPct),
    sharpe: round(mainM.sharpe),
    maxDrawdownPct: round(mainM.maxDrawdownPct),
    trades: mainM.trades,
    oosSharpe: wf ? round(wf.metrics.sharpe) : null,
    passed: checks.length ? checks.every((c) => c.pass) : false,
    passCount: checks.filter((c) => c.pass).length,
    checkCount: checks.length,
  }

  return {
    summary,
    result: {
      main: {
        metrics: roundM(mainM),
        totals: Object.fromEntries(Object.entries(main.totals).map(([k, v]) => [k, round(v)])),
        locked: main.locked,
        dailyLossDays: main.dailyLossDays,
        curve: dailyCurve(main.hourly).map((d) => ({ ts: d.ts, equity: round(d.equity) })),
        benchmark: bench.map((d) => ({ ts: d.ts, equity: round(d.equity) })),
        benchmarkReturnPct: bench.length ? round((bench[bench.length - 1].equity / cfg.paperStartingEquity - 1) * 100) : null,
        trades: main.trades.slice(-300).map((t) => ({ ...t, entryPx: round(t.entryPx, 4), exitPx: round(t.exitPx, 4), qty: round(t.qty, 5), pnl: round(t.pnl), fees: round(t.fees), slippage: round(t.slippage), funding: round(t.funding), riskAmt: round(t.riskAmt) })),
        tradeCount: main.trades.length,
        byStrategy: breakdown('strategy'),
        byRegime: breakdown('regime'),
        bySymbol: breakdown('symbol'),
        regimeShare: Object.entries(regimeShare).map(([k, v]) => ({ regime: k, pct: round((v / totalBars) * 100, 1) })),
        params: defaults,
      },
      walkforward: wf ? { ...wf, folds } : null,
      sensitivity: { baseSharpe: round(baseSharpe), stable, rows: sensitivity },
      checks,
      assumptions: {
        costs: cfg.costs,
        risk: cfg.risk,
        startEquity: cfg.paperStartingEquity,
        fundingHistoryFrom: Number.isFinite(fundingFrom) ? fundingFrom : null,
        walkforward: cfg.backtest,
      },
    },
  }
}

// 异步执行，结果写入数据库
let current = null
async function startRun(req) {
  if (current) return { id: current, running: true }
  const { rows } = await dbQuery(`INSERT INTO backtest_runs (status, request) VALUES ('running', $1) RETURNING id`, [JSON.stringify(req)])
  const id = rows[0].id
  current = id
  const t0 = Date.now()
  setImmediate(async () => {
    try {
      const out = await runLab(req)
      await dbQuery(`UPDATE backtest_runs SET status='done', summary=$2, result=$3, duration_ms=$4 WHERE id=$1`, [
        id,
        JSON.stringify(out.summary),
        JSON.stringify(out.result),
        Date.now() - t0,
      ])
      await feed.logEvent('info', 'backtest', `回测 #${id} 完成：样本外夏普 ${out.summary.oosSharpe ?? '—'}，验收 ${out.summary.passCount}/${out.summary.checkCount} 项通过`)
    } catch (e) {
      console.error('backtest failed', e)
      await dbQuery(`UPDATE backtest_runs SET status='error', error=$2, duration_ms=$3 WHERE id=$1`, [id, e.message, Date.now() - t0])
    } finally {
      current = null
    }
  })
  return { id, running: true }
}

module.exports = { runLab, startRun, loadData }
