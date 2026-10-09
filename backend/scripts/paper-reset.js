// 重置模拟账户并重新开始计时（会清空模拟账户的持仓 / 订单 / 成交 / 净值记录，并生成新的复现包）
// 运行：cd backend && node scripts/paper-reset.js "原因"
const { createPaper, liveMarket } = require('../lib/paper')
const { dbStore } = require('../lib/paperStore')
;(async () => {
  await require('../lib/settings').ensureLoaded()
  const p = createPaper({ store: dbStore(), market: liveMarket() })
  const r = await p.resetAccount(process.argv[2] || '')
  const b = await require('../lib/repro').latest(r.startedAt)
  console.log(`已重置，开始时间 ${new Date(r.startedAt).toISOString()}`)
  console.log(`复现包 #${b?.id}：config ${b?.config_hash}，code ${b?.code_hash}，commit ${b?.git_commit}${b?.git_dirty ? '（有未提交改动）' : ''}`)
  console.log(`锚点 ${new Date(b.params.anchorTs).toISOString()}，首个处理 K 线 ${new Date(b.params.from).toISOString()}，策略 ${b.params.strategies.join(',')}`)
  for (const c of b.data.candles) console.log(`  candles ${c.symbol} ${c.interval}：全表 ${c.rows} 行，窗口内 ${c.win_rows} 行 ${new Date(c.win_first_ts).toISOString().slice(0, 13)} → ${new Date(c.win_last_ts).toISOString().slice(0, 13)}`)
  for (const f of b.data.funding_rates) console.log(`  funding_rates ${f.symbol}：全表 ${f.rows} 行，窗口内 ${f.win_rows} 行 ${new Date(f.win_first_ts).toISOString().slice(0, 13)} → ${new Date(f.win_last_ts).toISOString().slice(0, 13)}`)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
