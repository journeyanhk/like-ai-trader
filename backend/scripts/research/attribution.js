// 归因诊断（第二轮审查「第一步」）：样本外夏普从回测 #4 的 1.21 掉到 #5 的 0.77，拆成 5 个变化各贡献多少。
// - 只做诊断，不是优化：策略、参数网格、滚动验证规则都与 lab.js 完全相同，只切换下面 5 个开关。
// - 不碰模拟账户；引擎代码（simulate/backtest/config…）一字未改，切换全部通过传入的 conf / 数据副本完成。
// - 「打开留出集」之外的组合会读到 2026-07-11 之后的数据——这与回测 #4 当时的口径相同（#4 是在设置留出集之前跑的），
//   只用于还原历史数字，不用于比较或挑选策略；后续任何研究仍然只能用留出集之前的数据。
// 运行：cd backend && node scripts/research/attribution.js
const cfg = require('../../lib/config')
const { loadData } = require('../../lib/lab')
const { STRATEGIES, expandGrid } = require('../../lib/strategies')
const { runBacktest, metrics } = require('../../lib/backtest')

const DAY = 86400_000
const STRATS = ['breakout']
// 回测 #4 时库里只有 OKX REST 接口给的约 3 个月真实资金费，更早的按保守假设（每 8 小时 0.01%）计
const OLD_FUNDING_FROM = Date.UTC(2026, 6, 9)

const FACTORS = [
  { key: 'holdout', label: '去掉最近 90 天（留出集）' },
  { key: 'funding', label: '资金费改用 730 天真实数据' },
  { key: 'group', label: '5 币同组上限 60%' },
  { key: 'rounding', label: '合约张数取整 / 最小下单量' },
  { key: 'ddLock', label: '回撤 10% 锁定（#5 开了，#4 没开）' },
]

function confFor(on) {
  const c = structuredClone(cfg)
  if (!on.group) {
    c.correlationGroups = { majors: ['BTC/USDT', 'ETH/USDT'] } // 旧配置：只有 BTC/ETH 一组，上限沿用总敞口 100%
    delete c.risk.maxGroupExposurePct
  }
  if (!on.rounding) {
    c.contracts = Object.fromEntries(Object.entries(cfg.contracts).map(([s, x]) => [s, { ...x, ctVal: 1, lotSz: 0.000001, minSz: 0 }]))
  }
  return c
}

function withOldFunding(data) {
  const out = {}
  for (const [s, d] of Object.entries(data)) out[s] = { ...d, funding: new Map([...d.funding].filter(([ts]) => ts >= OLD_FUNDING_FROM)) }
  return out
}

function walkforward(data, conf, ddLock) {
  const cache = new Map()
  const symbols = Object.keys(data)
  const allTs = data[symbols[0]].bars.map((b) => b.ts)
  const start = allTs[0] + cfg.backtest.warmupDays * DAY
  const end = allTs[allTs.length - 1] + 3600_000
  const run = (from, to, paramsAt, strats = STRATS) => runBacktest(data, { strategies: strats, paramsAt, from, to, regimeFilter: true, ddLock, cache, conf })
  const { trainDays, testDays, stepDays, minTrainTrades } = cfg.backtest
  const defaults = Object.fromEntries(STRATS.map((n) => [n, { ...STRATEGIES[n].defaults }]))
  const folds = []
  for (let t0 = start; t0 + (trainDays + testDays) * DAY <= end; t0 += stepDays * DAY) {
    const trainEnd = t0 + trainDays * DAY
    const chosen = {}
    for (const n of STRATS) {
      let best = { score: -Infinity, p: defaults[n] }
      for (const p of expandGrid(STRATEGIES[n].grid, STRATEGIES[n].defaults)) {
        const m = metrics(run(t0, trainEnd, () => p, [n]))
        const sc = m.trades < minTrainTrades ? -Infinity : m.sharpe
        if (sc > best.score) best = { score: sc, p }
      }
      chosen[n] = best.p
    }
    folds.push({ trainEnd, testEnd: trainEnd + testDays * DAY, params: chosen })
  }
  const segs = folds.map((f, k) => ({ from: f.trainEnd, to: k === folds.length - 1 ? f.testEnd : f.trainEnd + stepDays * DAY, params: f.params }))
  const paramsAt = (n, ts) => (segs.find((s) => ts >= s.from && ts < s.to) ?? segs[segs.length - 1]).params[n]
  const oos = run(segs[0].from, segs[segs.length - 1].to, paramsAt)
  const m = metrics(oos)
  const years = (segs[segs.length - 1].to - segs[0].from) / (365 * DAY)
  return { sharpe: m.sharpe, ret: m.totalReturnPct, mdd: m.maxDrawdownPct, trades: m.trades, funding: oos.totals.funding, rejects: oos.rejects?.length ?? 0, lockedAt: oos.locked?.ts ?? null, lastTradeTs: oos.trades.length ? oos.trades[oos.trades.length - 1].exitTs : null, years, from: segs[0].from, to: segs[segs.length - 1].to }
}

;(async () => {
  await require('../../lib/settings').ensureLoaded()
  const t0 = Date.now()
  const full = await loadData(cfg.symbols)
  const held = await loadData(cfg.symbols, { toTs: cfg.backtest.holdoutFrom })
  const variants = { full: { real: full, old: withOldFunding(full) }, held: { real: held, old: withOldFunding(held) } }

  const evalOn = (on) => walkforward(variants[on.holdout ? 'held' : 'full'][on.funding ? 'real' : 'old'], confFor(on), !!on.ddLock)
  const fmt = (r) => `夏普 ${r.sharpe.toFixed(2).padStart(5)}  收益 ${r.ret.toFixed(2).padStart(6)}%  回撤 ${r.mdd.toFixed(2).padStart(5)}%  ${String(r.trades).padStart(3)} 笔  资金费 ${r.funding.toFixed(0).padStart(5)}  拒单 ${String(r.rejects).padStart(3)}  样本外 ${r.years.toFixed(2)} 年${r.lockedAt ? `  锁定于 ${new Date(r.lockedAt).toISOString().slice(0, 10)}（此后不再交易）` : ''}`
  const se = (sr, T) => Math.sqrt((1 + (sr * sr) / 2) / T)

  const off = Object.fromEntries(FACTORS.map((f) => [f.key, false]))
  const base = evalOn(off)
  console.log(`基线（#4 口径：全部关闭）           ${fmt(base)}  标准误差 ±${se(base.sharpe, base.years).toFixed(2)}`)

  console.log('\n【逐个累加】（按 #4 → #5 的顺序依次打开）')
  let on = { ...off }
  let prev = base
  const steps = []
  for (const f of FACTORS) {
    on = { ...on, [f.key]: true }
    const r = evalOn(on)
    steps.push({ f, r, d: r.sharpe - prev.sharpe })
    console.log(`+ ${f.label.padEnd(22, '　')} ${fmt(r)}  夏普变化 ${(r.sharpe - prev.sharpe >= 0 ? '+' : '') + (r.sharpe - prev.sharpe).toFixed(2)}`)
    prev = r
  }
  console.log(`  全部打开（应≈回测 #5 的 0.77）：${prev.sharpe.toFixed(2)}；标准误差 ±${se(prev.sharpe, prev.years).toFixed(2)}`)

  console.log('\n【单独打开】（只打开这一项，其余保持 #4 口径）')
  const solo = []
  for (const f of FACTORS) {
    const r = evalOn({ ...off, [f.key]: true })
    solo.push({ f, r, d: r.sharpe - base.sharpe })
    console.log(`  ${f.label.padEnd(22, '　')} ${fmt(r)}  夏普变化 ${(r.sharpe - base.sharpe >= 0 ? '+' : '') + (r.sharpe - base.sharpe).toFixed(2)}`)
  }
  console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.log('\nJSON ' + JSON.stringify({ base, steps: steps.map((x) => ({ key: x.f.key, label: x.f.label, ...x.r, delta: x.d })), solo: solo.map((x) => ({ key: x.f.key, label: x.f.label, ...x.r, delta: x.d })) }))
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
