// 告警凭证轮换后的验证：读 backend/.env 里的新 Telegram token / chat id / Healthchecks 地址，
// 各发一次测试，成功后写一条 system 事件（不记录凭证本身，只记录指纹前 8 位）。
// 运行：cd backend && node scripts/rotate-creds.js
const crypto = require('node:crypto')
require('../lib/envfile').loadEnv()
const fp = (v) => (v ? crypto.createHash('sha256').update(v).digest('hex').slice(0, 8) : '无')
;(async () => {
  const tg = await require('../lib/notify').sendTelegram('🔑 like-ai-trader：告警凭证已轮换，新 token 测试消息（模拟盘）')
  let hc = { ok: false }
  try {
    const r = await fetch(process.env.HEALTHCHECK_PING_URL, { signal: AbortSignal.timeout(10000) })
    hc = { ok: r.ok, status: r.status }
  } catch (e) {
    hc = { ok: false, error: e.message }
  }
  const msg = `告警凭证已轮换：Telegram token 指纹 ${fp(process.env.TELEGRAM_BOT_TOKEN)}（测试${tg.ok ? '成功' : '失败 ' + tg.error}），Healthchecks 地址指纹 ${fp(process.env.HEALTHCHECK_PING_URL)}（测试${hc.ok ? '成功' : '失败'}）`
  await require('../lib/feed').logEvent(tg.ok && hc.ok ? 'info' : 'error', 'system', msg)
  console.log(msg)
  process.exit(tg.ok && hc.ok ? 0 : 1)
})()
