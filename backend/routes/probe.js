// /api/probe —— P2-4 外部探活（给 UptimeRobot / Healthchecks.io / Better Stack 等外部监控用）
//   GET /api/probe        健康返回 200，不健康返回 503（外部监控据此报警；进程整个挂掉时请求失败，同样会报警）
//   POST /api/probe/test  发送一条 Telegram 测试消息
const { Router } = require('express')
const paper = require('../lib/paper')
const notify = require('../lib/notify')
const cfg = require('../lib/config')

const router = Router()
const H1 = 3600_000

function health() {
  const s = paper.snapshot()
  const t = Date.now()
  const problems = []
  const runner = require('../lib/runner').info()
  // 备用实例本身不跑模拟盘：只要租约在别人手里且没过期，就算健康
  if (runner.role === 'standby' && runner.leaseHolder && runner.leaseExpires > t) {
    return { ok: true, problems, role: 'standby', runner, serverTime: t, telegram: notify.status(), pushPing: { configured: !!process.env.HEALTHCHECK_PING_URL } }
  }
  if (!s) problems.push('模拟盘还没加载')
  else {
    const mon = s.lastMonitorAt ? (t - s.lastMonitorAt) / 1000 : null
    const hb = s.lastHeartbeat ? (t - s.lastHeartbeat) / 1000 : null
    const lastBar = Math.floor(t / H1) * H1 - H1
    if (mon == null || mon > 180) problems.push(`每分钟巡检停了（上次 ${mon == null ? '无' : `${Math.round(mon)} 秒前`}）`)
    if (hb == null || hb > (cfg.paper.heartbeatEveryMs * cfg.paper.heartbeatMissing) / 1000) problems.push(`心跳中断（上次 ${hb == null ? '无' : `${Math.round(hb / 60)} 分钟前`}）`)
    if (s.lastBarTs != null && s.lastBarTs < lastBar - H1 && t - lastBar > 15 * 60_000) problems.push(`整点交易循环落后（已处理到 ${new Date(s.lastBarTs).toISOString().slice(0, 13)}:00 UTC）`)
    if (s.status !== 'running') problems.push(`账户状态：${s.status}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    status: s?.status ?? null,
    pauseKeys: s?.pauseKeys ?? [],
    lastMonitorAt: s?.lastMonitorAt ?? null,
    lastHeartbeat: s?.lastHeartbeat ?? null,
    lastBarTs: s?.lastBarTs ?? null,
    serverTime: Date.now(),
    role: runner.role,
    runner,
    telegram: notify.status(),
    pushPing: { configured: !!process.env.HEALTHCHECK_PING_URL },
  }
}

router.get('/instances', async (_req, res) => {
  try {
    res.json({ self: require('../lib/runner').info(), instances: await require('../lib/runner').instances() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/', (_req, res) => {
  const h = health()
  res.status(h.ok ? 200 : 503).json(h)
})

router.post('/test', async (_req, res) => {
  const r = await notify.sendTelegram(`✅ [模拟盘] Telegram 测试消息：通知已接通（${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC）`)
  res.status(r.ok ? 200 : 400).json(r)
})

module.exports = router
module.exports.health = health
