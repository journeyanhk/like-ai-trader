// 定时任务入口：每分钟风控巡检（止损、回撤锁定、日亏停手、自动暂停条件、心跳、对账）
// 只访问 OKX 免费公共接口；数据库只在状态变化时写入，心跳/对账每 5 分钟一次
const paper = require('../lib/paper')
const jobs = require('../lib/jobs')

let catchingUp = false
exports.handler = async () => {
  await paper.monitor()
  // 整点那次如果因为重启等原因错过了，这里补跑一次（同一根 K 线不会重复执行）
  if (paper.needsCycle() && !catchingUp) {
    catchingUp = true
    console.log('[monitor] 整点交易循环未执行，开始补跑')
    try {
      const r = await jobs.runHourly()
      await paper.runCycle(r.regimes)
    } finally {
      catchingUp = false
    }
  }
  // 每日复盘如果因为重启错过了，00:10 之后补生成（每天只检查一次，不阻塞巡检）
  require('../lib/review').ensureYesterday().catch((e) => console.error('[review] 补生成失败', e.message))
}
