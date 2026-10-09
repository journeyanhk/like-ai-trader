// P0-2 等价性测试 + 确定性测试
// 用同一段 60 天真实历史（数据库里的 OKX K 线与资金费率）：
//   A. 回测：runBacktest 一次跑完
//   B. 模拟盘：真正的 paper.runCycle 主循环，按小时推进时钟逐根驱动（内存存储 + 历史回放行情，不碰正式账户）
// 要求：fills 逐笔一致；期末 cash / realized_pnl / funding_pnl / fees_paid / unrealized / equity 六个字段差值为 0。
// 确定性：同一输入连跑两次，fills 的 sha256 相同。
// 运行：cd backend && node tests/equivalence.js [天数=60]
const crypto = require('crypto')
const cfg = require('../lib/config')
const feed = require('../lib/feed')
const sim = require('../lib/simulate')
const { runBacktest } = require('../lib/backtest')
const { createPaper, anchorFor } = require('../lib/paper')
const { memoryStore } = require('../lib/paperStore')
const { STRATEGIES } = require('../lib/strategies')

const H1 = 3600_000
const DAY = 86400_000
const DAYS = Number(process.argv[2]) || 60
const FIELDS = ['cash', 'realized_pnl', 'funding_pnl', 'fees_paid', 'unrealized', 'equity']
const FILL_KEYS = ['ts', 'symbol', 'intent', 'side', 'qty', 'px', 'ref_px', 'fee', 'reason', 'strategy', 'signal_ts']

const { retry, replayMarket } = require('./replay')

const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex')
const pickFill = (f) => Object.fromEntries(FILL_KEYS.map((k) => [k, f[k]]))

async function runPaper(raw, start, end) {
  const clock = { t: start + 2 * 60_000 }
  const store = memoryStore()
  const paper = createPaper({ store, market: replayMarket(raw, clock) })
  await paper.load()
  let cycles = 0
  for (let t = start; t <= end; t += H1) {
    clock.t = t + 2 * 60_000
    const r = await paper.runCycle()
    if (!r.skipped) cycles++
    // 每 24 小时从存储重新加载一次，验证落库 → 读回不丢精度
    if (cycles % 24 === 0) await paper.load(true)
  }
  const st = paper.S.st
  const fills = store.mem.orders.map((o) => pickFill({ ...o, ts: o.fill_ts, px: o.fill_px }))
  return { paper, store, st, fills, cycles, anchorTs: paper.S.anchorTs, fundings: store.mem.funding }
}

function runBt(raw, anchorTs, from, to) {
  const data = {}
  for (const s of cfg.symbols) {
    const b1 = raw[s]['1h'].filter((b) => b.ts >= anchorTs && b.ts < to)
    const b4 = raw[s]['4h'].filter((b) => b.ts >= anchorTs && b.ts + 4 * H1 <= to)
    data[s] = { ...sim.buildSeries(b1, b4), funding: new Map(raw[s].funding.map((f) => [f.ts, f.rate])) }
  }
  const strategies = [...cfg.paper.strategies]
  const res = runBacktest(data, {
    strategies,
    paramsAt: (n) => ({ ...STRATEGIES[n].defaults }),
    from,
    to,
    regimeFilter: true,
    ddLock: true,
    invalidation: true,
    closeAtEnd: false,
    until: 'open',
  })
  return { res, st: res.state, fills: res.state.fills.map(pickFill), fundings: res.state.fundings }
}

;(async () => {
  await require('../lib/settings').ensureLoaded()
  const t0 = Date.now()
  // 最近一根已收盘 K 线
  const lastTs = Math.min(...(await Promise.all(cfg.symbols.map(async (s) => (await retry(() => feed.loadBars(s, '1h', 1)))[0].ts))))
  const end = lastTs // 最后一次循环时刻 = end + 2 分钟：处理 end-1h 收盘、end 开盘
  const start = end - DAYS * DAY
  const anchorTs = anchorFor(start + 2 * 60_000)
  const raw = {}
  for (const s of cfg.symbols) {
    const [b1, b4, f] = await Promise.all([
      retry(() => feed.loadBarsRange(s, '1h', anchorTs, end + H1)),
      retry(() => feed.loadBarsRange(s, '4h', anchorTs, end + H1)),
      retry(() => feed.loadFunding(s)),
    ])
    raw[s] = { '1h': b1, '4h': b4, funding: f }
  }
  console.log(`数据：${cfg.symbols.length} 个币，锚定历史起点 ${new Date(anchorTs).toISOString()}，测试区间 ${new Date(start).toISOString()} → ${new Date(end).toISOString()}（${DAYS} 天）`)
  console.log(`策略 ${cfg.paper.strategies.join(',')}，单笔风险 ${cfg.risk.riskPerTradePct}%，读数用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // ---------- A. 回测 ----------
  const from = start - H1
  const to = end + H1
  const bt1 = runBt(raw, anchorTs, from, to)
  const bt2 = runBt(raw, anchorTs, from, to)

  // ---------- B. 模拟盘主循环 ----------
  const t1 = Date.now()
  const pp1 = await runPaper(raw, start, end)
  console.log(`模拟盘主循环：${pp1.cycles} 次 runCycle，用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  if (pp1.anchorTs !== anchorTs) throw new Error('锚点不一致')
  const pp2 = await runPaper(raw, start, end)

  // ---------- 等价性 ----------
  let ok = true
  const fail = (m) => {
    ok = false
    console.log('FAIL', m)
  }
  console.log(`\n回测 fills ${bt1.fills.length} 笔，模拟盘 fills ${pp1.fills.length} 笔；资金费结算 回测 ${bt1.fundings.length} 次 / 模拟盘 ${pp1.fundings.length} 次`)
  if (bt1.fills.length !== pp1.fills.length) fail('fills 笔数不同')
  const nCmp = Math.max(bt1.fills.length, pp1.fills.length)
  let firstDiff = -1
  for (let k = 0; k < nCmp; k++) {
    const a = bt1.fills[k]
    const b = pp1.fills[k]
    if (!a || !b || FILL_KEYS.some((key) => a[key] !== b[key])) {
      firstDiff = k
      fail(`第 ${k + 1} 笔不一致：\n  回测 ${JSON.stringify(a)}\n  模拟 ${JSON.stringify(b)}`)
      break
    }
  }
  if (firstDiff < 0) console.log(`PASS fills 逐笔一致（${nCmp} 笔 × ${FILL_KEYS.length} 个字段，严格相等 ===）`)
  const fk = ['ts', 'symbol', 'side', 'qty', 'mark', 'rate', 'cashflow']
  const fdiff = bt1.fundings.findIndex((a, k) => fk.some((key) => a[key] !== pp1.fundings[k]?.[key]))
  if (bt1.fundings.length !== pp1.fundings.length || fdiff >= 0) fail(`资金费现金流不一致（第 ${fdiff + 1} 次）`)
  else console.log(`PASS 资金费现金流逐笔一致（${bt1.fundings.length} 次）`)

  const la = sim.ledger(bt1.st)
  const lb2 = sim.ledger(pp1.st)
  console.log('\n期末六字段（回测 / 模拟盘 / 差值）：')
  for (const f of FIELDS) {
    const d = la[f] - lb2[f]
    console.log(`  ${f.padEnd(13)} ${la[f].toFixed(10).padStart(20)} ${lb2[f].toFixed(10).padStart(20)}   差值 ${d}`)
    if (d !== 0) fail(`${f} 差值 ${d}`)
  }
  const pendA = JSON.stringify(bt1.st.pending)
  const pendB = JSON.stringify(pp1.st.pending)
  if (pendA !== pendB) fail(`期末待执行指令不同 ${pendA} vs ${pendB}`)
  const posA = JSON.stringify(bt1.st.positions)
  const posB = JSON.stringify(Object.fromEntries(Object.keys(bt1.st.positions).map((s) => [s, pp1.st.positions[s]])))
  if (posA !== posB || Object.keys(pp1.st.positions).length !== Object.keys(bt1.st.positions).length) fail('期末持仓不同')
  else console.log(`PASS 期末持仓一致（${Object.keys(bt1.st.positions).length} 个）`)
  // 恒等式：cash = 起始资金 + 已实现 − 手续费 + 资金费
  const idt = cfg.paperStartingEquity + la.realized_pnl - la.fees_paid + la.funding_pnl - la.cash
  console.log(`  核算恒等式 起始资金 + 已实现 − 手续费 + 资金费 − 现金 = ${idt.toExponential(2)}（浮点误差级）`)

  // ---------- 确定性 ----------
  const h = [sha(bt1.fills), sha(bt2.fills), sha(pp1.fills), sha(pp2.fills)]
  console.log('\nfills sha256：')
  console.log(`  回测 第 1 次   ${h[0]}`)
  console.log(`  回测 第 2 次   ${h[1]}`)
  console.log(`  模拟盘 第 1 次 ${h[2]}`)
  console.log(`  模拟盘 第 2 次 ${h[3]}`)
  if (h[0] !== h[1]) fail('回测两次 sha256 不同')
  if (h[2] !== h[3]) fail('模拟盘两次 sha256 不同')
  if (h[0] === h[1] && h[2] === h[3]) console.log('PASS 确定性：同一输入连跑两次 sha256 相同')

  console.log('\n成交明细（前 12 笔）：')
  for (const f of bt1.fills.slice(0, 12)) console.log(`  ${new Date(f.ts).toISOString().slice(0, 16)} ${f.symbol.padEnd(10)} ${f.intent.padEnd(5)} ${f.side > 0 ? '买' : '卖'} qty=${f.qty.toPrecision(6)} px=${f.px.toPrecision(7)} fee=${f.fee.toFixed(4)} ${f.reason}`)
  console.log(`\n结果：${ok ? '全部通过' : '未通过'}（总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  process.exit(ok ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(2)
})
