// 定时任务入口：每小时第 2 分钟执行（等上一根 1h K 线收盘后）
// 同步行情 → 判定市场状态 → 模拟交易循环（策略信号 → 风控审核 → 模拟下单）
const { runHourly } = require('../lib/jobs')
const paper = require('../lib/paper')

exports.handler = async () => {
  const r = await runHourly()
  console.log('[hourly]', JSON.stringify(r.regimes))
  const c = await paper.runCycle(r.regimes)
  console.log('[paper]', c.skipped ? c.reason : JSON.stringify(c.decisions?.map((d) => ({ s: d.symbol, a: d.actions, n: d.notes }))))
}
