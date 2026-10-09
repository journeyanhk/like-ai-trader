// 留出集一次性检验（预注册，见 docs/research-log.md）：只有第 1 轮研究中结论为「通过」的那一个候选能跑，且只能跑一次。
// 方法：用留出集起点前 180 天按同样的参数网格、同样的打分（训练期夏普，笔数不足记 −∞）选参数；
//       然后在 [2026-07-11, 最近一根已收盘 K 线] 上跑一次，ddLock=false。
// 通过线（三条都要过）：夏普 > 0；最大回撤 < 15%；每天交易笔数与滚动验证期相差不超过 ±50%。
// 运行：cd backend && node scripts/research/holdout.js H1|H2|H3
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('../../lib/config')
const { STRATEGIES, expandGrid } = require('../../lib/strategies')
const { loadData } = require('../../lib/lab')
const { runBacktest, metrics } = require('../../lib/backtest')
const { variant, onData } = require('./hypotheses')

const DAY = 86400_000
;(async () => {
  await require('../../lib/settings').ensureLoaded()
  const h = process.argv[2]
  const tag = `R1-${h}`
  const { rows } = await dbQuery(`SELECT id, summary FROM backtest_runs WHERE summary->>'research' = $1`, [tag])
  if (!rows[0]) throw new Error(`${tag} 还没有跑过滚动验证`)
  if (rows[0].summary.researchVerdict !== '通过') throw new Error(`${tag} 的结论是「${rows[0].summary.researchVerdict}」，不能碰留出集`)
  const { rows: done } = await dbQuery(`SELECT id FROM backtest_runs WHERE summary->>'research' = $1`, [`${tag}-holdout`])
  if (done.length) throw new Error(`${tag} 已经用过留出集（#${done[0].id}），不允许再跑`)
  const { rows: other } = await dbQuery(`SELECT summary->>'research' AS r FROM backtest_runs WHERE summary->>'research' LIKE 'R1-%-holdout'`)
  if (other.length) throw new Error(`本轮留出集已被 ${other[0].r} 用掉`)

  const v = variant(h)
  STRATEGIES[v.name] = v
  for (const r of ['trend_up', 'trend_down']) cfg.allowedStrategies[r] = [...cfg.allowedStrategies[r], v.name]
  const data = await loadData(cfg.symbols)
  onData(data)
  const hf = cfg.backtest.holdoutFrom
  const lastTs = data['BTC/USDT'].bars[data['BTC/USDT'].bars.length - 1].ts
  const cache = new Map()
  const run = (from, to, p) => runBacktest(data, { strategies: [v.name], paramsAt: () => p, from, to, regimeFilter: true, ddLock: false, cache })
  let best = { score: -Infinity, p: { ...v.defaults } }
  for (const p of expandGrid(v.grid, v.defaults)) {
    const m = metrics(run(hf - cfg.backtest.trainDays * DAY, hf, p))
    const sc = m.trades < cfg.backtest.minTrainTrades ? -Infinity : m.sharpe
    if (sc > best.score) best = { score: sc, p }
  }
  v.research.reset()
  const res = run(hf, lastTs + 3600_000, best.p)
  const m = metrics(res)
  const days = (lastTs + 3600_000 - hf) / DAY
  const s = rows[0].summary
  const wfDays = (s.to - s.from) / DAY // 近似：滚动验证样本外天数见 JSON
  const wfRate = s.wfTradesPerDay ?? null
  const rate = m.trades / days
  const checks = [
    { label: '夏普 > 0', value: m.sharpe.toFixed(2), pass: m.sharpe > 0 },
    { label: '最大回撤 < 15%', value: `${m.maxDrawdownPct.toFixed(2)}%`, pass: m.maxDrawdownPct < 15 },
    { label: '交易频率与滚动验证期 ±50%', value: `${rate.toFixed(3)} 笔/天 vs ${wfRate?.toFixed(3)}`, pass: wfRate != null && Math.abs(rate / wfRate - 1) <= 0.5 },
  ]
  const verdict = checks.every((c) => c.pass) ? '策略门通过' : '候选作废'
  await dbQuery(`INSERT INTO backtest_runs (status, request, summary, duration_ms) VALUES ('done', $1, $2, 0)`, [JSON.stringify({ research: `${tag}-holdout` }), JSON.stringify({ research: `${tag}-holdout`, purpose: 'strategy', params: best.p, from: hf, to: lastTs + 3600_000, sharpe: m.sharpe, maxDrawdownPct: m.maxDrawdownPct, trades: m.trades, checks, verdict, wfDays })])
  console.log(`${tag} 留出集 ${new Date(hf).toISOString().slice(0, 10)} → ${new Date(lastTs).toISOString().slice(0, 16)}，参数 ${JSON.stringify(best.p)}`)
  for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.label}：${c.value}`)
  console.log(`  收益 ${m.totalReturnPct.toFixed(2)}%，${m.trades} 笔；结论：${verdict}`)
  process.exit(0)
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
