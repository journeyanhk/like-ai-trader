// 定时任务入口：每分钟风控巡检（止损、回撤锁定、日亏停手、自动暂停条件、心跳、对账）
// 只访问 OKX 免费公共接口；数据库只在状态变化时写入，心跳/对账每 5 分钟一次
const paper = require('../lib/paper')
const jobs = require('../lib/jobs')

let catchingUp = false
// P2-4 推送式探活：配置了 HEALTHCHECK_PING_URL（如 Healthchecks.io）时，每分钟巡检成功就 ping 一次；
// 失败 ping /fail。进程挂掉 → 不再 ping → 外部服务按超时报警（这是进程自己发不出的那种告警）。
function ping(suffix = '') {
  require('../lib/envfile').loadEnv()
  const url = process.env.HEALTHCHECK_PING_URL
  if (!url) return
  fetch(url.replace(/\/$/, '') + suffix, { signal: AbortSignal.timeout(8000) }).catch((e) => console.error('[probe] ping 失败', e.message))
}

let lastProblemKey = ''
exports.handler = async () => {
  // 单实例运行：不是租约持有者就只登记在线，不跑模拟盘、不报平安（报平安的应是真正在干活的那个）
  const lease = await require('../lib/runner').tick()
  if (!lease.leader) return
  try {
    await paper.monitor()
  } catch (e) {
    ping('/fail')
    throw e
  }
  const h = require('../routes/probe').health()
  ping(h.ok ? '' : '/fail')
  // 自检发现问题（进程还活着时）：直接发 Telegram
  const key = h.problems.join('|')
  if (key && key !== lastProblemKey) require('../lib/feed').logEvent('warn', 'probe', `自检异常：${h.problems.join('；')}`)
  if (!key && lastProblemKey) require('../lib/feed').logEvent('info', 'probe', '自检恢复正常')
  lastProblemKey = key
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
