// P0-3 资金费现金流人工核对：从等价性测试同一段 60 天回放中挑三笔
//   ① BTC 多头 + 正费率  ② BTC 空头  ③ ETH 负费率
// 列出引擎记账的 qty / mark / rate / cashflow，并直接向 OKX 公共接口取同一时刻的
//   资金费率历史（public/funding-rate-history）、标记价格 K 线（market/history-mark-price-candles）、成交价 K 线（market/history-candles）
// 用交易所口径「资金费 = 持仓数量 × 标记价格 × 费率，多付空收（费率为正时）」重算并比对。
// 运行：cd backend && node tests/funding-audit.test.js
const cfg = require('../lib/config')
const feed = require('../lib/feed')
const sim = require('../lib/simulate')
const { runBacktest } = require('../lib/backtest')
const { anchorFor } = require('../lib/paper')
const { STRATEGIES } = require('../lib/strategies')
const { retry, loadRaw, H1 } = require('./replay')

const DAY = 86400_000
const okx = async (path, params) => {
  const r = await fetch(`https://www.okx.com/api/v5/${path}?${new URLSearchParams(params)}`)
  const j = await r.json()
  if (j.code !== '0') throw new Error(`OKX ${j.code} ${j.msg}`)
  return j.data
}
const inst = (s) => `${s.replace('/', '-')}-SWAP`

async function exchange(symbol, ts) {
  const fr = await retry(() => okx('public/funding-rate-history', { instId: inst(symbol), after: String(ts + 1), limit: '1' }))
  const mk = await retry(() => okx('market/history-mark-price-candles', { instId: inst(symbol), bar: '1H', after: String(ts + 1), limit: '1' }))
  const lc = await retry(() => okx('market/history-candles', { instId: inst(symbol), bar: '1H', after: String(ts + 1), limit: '1' }))
  const f = fr.find((r) => Number(r.fundingTime) === ts)
  const m = mk.find((r) => Number(r[0]) === ts)
  const l = lc.find((r) => Number(r[0]) === ts)
  return { fundingRate: f && Number(f.fundingRate), realizedRate: f && Number(f.realizedRate), markOpen: m && Number(m[1]), lastOpen: l && Number(l[1]) }
}

;(async () => {
  await require('../lib/settings').ensureLoaded()
  const end = Math.min(...(await Promise.all(cfg.symbols.map(async (s) => (await retry(() => feed.loadBars(s, '1h', 1)))[0].ts))))
  const start = end - 60 * DAY
  const anchorTs = anchorFor(start + 2 * 60_000)
  const raw = await loadRaw(cfg.symbols, anchorTs, end)
  const data = {}
  for (const s of cfg.symbols) {
    const b1 = raw[s]['1h'].filter((b) => b.ts < end + H1)
    const b4 = raw[s]['4h'].filter((b) => b.ts + 4 * H1 <= end + H1)
    data[s] = { ...sim.buildSeries(b1, b4), funding: new Map(raw[s].funding.map((f) => [f.ts, f.rate])) }
  }
  const res = runBacktest(data, { strategies: [...cfg.paper.strategies], paramsAt: (n) => ({ ...STRATEGIES[n].defaults }), from: start - H1, to: end + H1, regimeFilter: true, ddLock: true, invalidation: true, closeAtEnd: false, until: 'open' })
  const ev = res.state.fundings
  const picks = [
    ['① BTC 多头 · 正费率', ev.find((e) => e.symbol === 'BTC/USDT' && e.side > 0 && e.rate > 0)],
    ['② BTC 空头', ev.find((e) => e.symbol === 'BTC/USDT' && e.side < 0 && e.rate != null)],
    ['③ ETH 负费率', ev.find((e) => e.symbol === 'ETH/USDT' && e.rate < 0)],
  ]
  let bad = 0
  for (const [label, e] of picks) {
    if (!e) {
      console.log(`${label}：这 60 天里没有出现这种情况`)
      bad++
      continue
    }
    const x = await exchange(e.symbol, e.ts)
    const exCash = -e.side * e.qty * x.markOpen * x.fundingRate // 交易所口径
    const ourRecalc = -e.side * e.qty * e.mark * e.rate // 用引擎自己的四个数手算
    console.log(`\n${label}  ${new Date(e.ts).toISOString().slice(0, 16)} UTC  ${e.side > 0 ? '多' : '空'}`)
    console.log(`  引擎记账   qty=${e.qty}  mark=${e.mark}  rate=${e.rate}  cashflow=${e.cashflow.toFixed(6)} USDT`)
    console.log(`  手算核对   −方向 × qty × mark × rate = ${ourRecalc.toFixed(6)}   与记账差 ${(ourRecalc - e.cashflow).toExponential(2)}`)
    console.log(`  OKX 历史   费率 fundingRate=${x.fundingRate}  realizedRate=${x.realizedRate}  标记价(该小时开盘)=${x.markOpen}  成交价(该小时开盘)=${x.lastOpen}`)
    console.log(`  对账       费率一致：${x.fundingRate === e.rate ? '是' : '否'}；引擎 mark 与 OKX 成交价开盘一致：${x.lastOpen === e.mark ? '是' : '否'}`)
    console.log(`             交易所口径现金流（用标记价）= ${exCash.toFixed(6)} USDT，与引擎差 ${(e.cashflow - exCash).toFixed(6)} USDT（${(((e.cashflow - exCash) / exCash) * 100).toFixed(4)}%，来自成交价与标记价的价差）`)
    if (Math.abs(ourRecalc - e.cashflow) > 1e-9 || x.fundingRate !== e.rate) bad++
  }
  if (bad) process.exitCode = 1
  console.log(bad ? '\n结果：有不一致，见上' : '\n结果：三笔费率与交易所一致，现金流公式核对无误')
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
