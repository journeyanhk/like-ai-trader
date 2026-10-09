// 第 1 轮预注册研究：H1–H3（定义见 docs/research-log.md，运行前已提交 git）。
// - 每个假设只在「趋势突破」上叠加一条入场过滤，其余（参数网格、风控、成本）不变；一律 ddLock=false（策略口径）。
// - 每个假设只允许跑一次：数据库里已有同名研究记录就拒绝再跑。
// - 不改模拟盘决策路径：假设以「研究变体」的形式只注册在本进程内存里，不写进 strategies.js / config.js。
// - 只用留出集（2026-07-11）之前的数据；留出集检验另见 holdout.js，只有通过者才能跑。
// 运行：cd backend && node scripts/research/hypotheses.js baseline|H1|H2|H3
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('../../lib/config')
const { STRATEGIES } = require('../../lib/strategies')
const lab = require('../../lib/lab')

const H1 = 3600_000
const DAY = 86400_000
const BASE = STRATEGIES.breakout

// 预注册常量（与 research-log.md 一致，不许改）
const BASELINE_SHARPE = 1.0
const PASS_SHARPE = 1.3
const DECIDABLE = { min: 0.1, max: 0.7 }

// 运行时上下文：bars 数组 → 币种；资金费有序数组；BTC 每根 K 线的市场状态
const ctx = { symOf: new Map(), funding: {}, btcRegime: new Map() }
function onData(data) {
  for (const [s, d] of Object.entries(data)) {
    ctx.symOf.set(d.bars, s)
    ctx.funding[s] = [...d.funding].map(([ts, rate]) => ({ ts, rate })).sort((a, b) => a.ts - b.ts)
  }
  const b = data['BTC/USDT']
  if (b) b.bars.forEach((bar, i) => ctx.btcRegime.set(bar.ts, b.regimes[i]))
}

// 最后一个 ts ≤ t 的下标
function lastIdx(arr, t) {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (arr[m].ts <= t) {
      ans = m
      lo = m + 1
    } else hi = m - 1
  }
  return ans
}

const FILTERS = {
  // H1：资金费极端时不顺势开仓。阈值 = 该币过去 90 天 |费率| 的 90 分位（最近排名法）；
  // 费率取时间戳 ≤ 信号 K 线收盘时刻的最近一次已结算值。做多看正向极端（费率 > 阈值不做多），做空看负向极端（费率 < −阈值不做空）。
  H1(i, sig, { bars }) {
    const s = ctx.symOf.get(bars)
    const f = ctx.funding[s]
    if (!f?.length) return true
    const close = bars[i].ts + H1
    const k = lastIdx(f, close)
    if (k < 0) return true
    const win = []
    for (let j = k; j >= 0 && f[j].ts > close - 90 * DAY; j--) win.push(Math.abs(f[j].rate))
    win.sort((a, b) => a - b)
    const q90 = win[Math.max(0, Math.ceil(0.9 * win.length) - 1)]
    const rate = f[k].rate
    if (sig.side > 0 && rate > q90) return false
    if (sig.side < 0 && rate < -q90) return false
    return true
  },
  // H2：只做波动率压缩后的突破。ATR(14) 取 i−1，与截止 i−1 的 720 根 ATR 中位数比较，严格低于才开仓；历史不足 720 根则不开。
  H2(i, sig, { x }) {
    if (i - 720 < 0) return false
    const w = x.atr.slice(i - 720, i)
    if (w.some((v) => v == null)) return false
    const sorted = [...w].sort((a, b) => a - b)
    const med = (sorted[359] + sorted[360]) / 2
    return x.atr[i - 1] < med
  },
  // H3：ETH/SOL/XRP/DOGE 开多要求 BTC 同一根 K 线的市场状态为 trend_up，开空要求 trend_down；BTC 本身不受影响。
  H3(i, sig, { bars }) {
    const s = ctx.symOf.get(bars)
    if (s === 'BTC/USDT') return true
    const r = ctx.btcRegime.get(bars[i].ts)
    return sig.side > 0 ? r === 'trend_up' : r === 'trend_down'
  },
}

function variant(h) {
  let raw = 0
  let blocked = 0
  const name = `breakout_${h}`
  return {
    ...BASE,
    name,
    label: `趋势突破 + ${h}`,
    entry(i, c) {
      const sig = BASE.entry(i, c)
      if (!sig) return null
      raw++
      if (!FILTERS[h](i, sig, c)) {
        blocked++
        return null
      }
      return sig
    },
    research: {
      reset() {
        raw = 0
        blocked = 0
      },
      stats: () => ({ raw, blocked, ratio: raw ? blocked / raw : null }),
    },
  }
}

async function main() {
  const h = process.argv[2]
  if (!['baseline', 'H1', 'H2', 'H3'].includes(h)) throw new Error('用法：node scripts/research/hypotheses.js baseline|H1|H2|H3')
  const tag = h === 'baseline' ? 'R1-baseline' : `R1-${h}`
  const { rows: prev } = await dbQuery(`SELECT id FROM backtest_runs WHERE summary->>'research' = $1`, [tag])
  if (prev.length) throw new Error(`${tag} 已经跑过（回测 #${prev[0].id}），按预注册规则不允许重跑`)

  let strat = 'breakout'
  if (h !== 'baseline') {
    const v = variant(h)
    STRATEGIES[v.name] = v
    for (const r of ['trend_up', 'trend_down']) cfg.allowedStrategies[r] = [...cfg.allowedStrategies[r], v.name]
    strat = v.name
  }

  const req = { strategies: [strat], symbols: cfg.symbols, regimeFilter: true, ddLock: false, research: tag }
  const t0 = Date.now()
  const { rows } = await dbQuery(`INSERT INTO backtest_runs (status, request) VALUES ('running', $1) RETURNING id`, [JSON.stringify({ ...req, onData: undefined })])
  const id = rows[0].id
  const out = await lab.runLab({ ...req, onData })
  const wf = out.result.walkforward
  const fs = wf.filterStats?.[strat] ?? null
  const sharpe = wf.metrics.sharpe
  const gate = out.result.checks
  const gateAll = gate.every((c) => c.pass)
  let verdict
  if (h === 'baseline') verdict = '基线'
  else if (!fs || fs.ratio == null || fs.ratio < DECIDABLE.min || fs.ratio > DECIDABLE.max) verdict = '不可判定'
  else if (sharpe >= PASS_SHARPE && gateAll) verdict = '通过'
  else verdict = '不通过'
  out.summary.researchVerdict = verdict
  out.summary.filterStats = fs
  out.summary.wfTradesPerDay = wf.metrics.trades / ((wf.to - wf.from) / DAY)
  await dbQuery(`UPDATE backtest_runs SET status='done', summary=$2, result=$3, duration_ms=$4 WHERE id=$1`, [id, JSON.stringify(out.summary), JSON.stringify(out.result), Date.now() - t0])

  const m = wf.metrics
  console.log(`${tag} → 回测 #${id}（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
  console.log(`  样本外 ${new Date(wf.from).toISOString().slice(0, 10)} → ${new Date(wf.to).toISOString().slice(0, 10)}：夏普 ${m.sharpe.toFixed(2)}（基线 ${BASELINE_SHARPE.toFixed(2)}，变化 ${(m.sharpe - BASELINE_SHARPE >= 0 ? '+' : '') + (m.sharpe - BASELINE_SHARPE).toFixed(2)}；通过线 ≥ ${PASS_SHARPE}）收益 ${m.totalReturnPct.toFixed(2)}% 回撤 ${m.maxDrawdownPct.toFixed(2)}% ${m.trades} 笔`)
  if (fs) console.log(`  过滤：原入场信号 ${fs.raw}，被过滤 ${fs.blocked}，比例 ${(fs.ratio * 100).toFixed(1)}%（可判定区间 10%–70%）`)
  console.log(`  策略门 5 项：${gate.map((c) => `${c.pass ? '✓' : '✗'} ${c.label}=${c.value}`).join('；')}`)
  console.log(`  运营信息：若开 10% 回撤锁定，样本外触发 ${wf.opsLocks.count} 次 ${wf.opsLocks.events.map((e) => `${new Date(e.ts).toISOString().slice(0, 10)}(回撤 ${e.ddPct}%)`).join('、')}`)
  console.log(`  结论：${verdict}`)
  console.log('JSON ' + JSON.stringify({ tag, id, sharpe: m.sharpe, ret: m.totalReturnPct, mdd: m.maxDrawdownPct, trades: m.trades, from: wf.from, to: wf.to, filter: fs, gate: gate.map((c) => ({ key: c.key, value: c.value, pass: c.pass })), locks: wf.opsLocks, verdict }))
  process.exit(0)
}

module.exports = { variant, onData, FILTERS, BASELINE_SHARPE, PASS_SHARPE, DECIDABLE }

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
