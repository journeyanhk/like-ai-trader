// 定时任务入口：每小时第 2 分钟执行（等上一根 1h K 线收盘后）
const { runHourly } = require('../lib/jobs')

exports.handler = async () => {
  const r = await runHourly()
  console.log('[hourly]', JSON.stringify(r.regimes))
}
