// 定时任务入口：每小时第 2 分钟执行（等上一根 1h K 线收盘后）
// 同步行情 → 判定市场状态 → 模拟交易循环（策略信号 → 风控审核 → 模拟下单）
const { runHourly } = require('../lib/jobs')
const paper = require('../lib/paper')

exports.handler = async () => {
  // 单实例运行：只有租约持有者执行（避免重复下单、重复记录市场状态变化）
  const lease = await require('../lib/runner').tick()
  if (!lease.leader) return console.log('[hourly] 备用实例，跳过（模拟盘由另一实例运行）')
  const r = await runHourly()
  console.log('[hourly]', JSON.stringify(r.regimes))
  const c = await paper.runCycle(r.regimes)
  console.log('[paper]', c.skipped ? c.reason : JSON.stringify(c.decisions?.map((d) => ({ s: d.symbol, a: d.actions, n: d.notes }))))
}
