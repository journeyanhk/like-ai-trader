// 运行中的进程补读 backend/.env。一般键只补缺失的；告警凭证（MANAGED）以 .env 为准，轮换后立即生效。
// 用途：用户事后在 .env 里加 Telegram / 探活地址，不用重启服务也能生效。
const fs = require('node:fs')
const path = require('node:path')
let lastMtime = 0
const MANAGED = new Set(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'HEALTHCHECK_PING_URL'])
function loadEnv() {
  const p = path.join(__dirname, '..', '.env')
  try {
    const m = fs.statSync(p).mtimeMs
    if (m === lastMtime) return
    lastMtime = m
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      const k = t.slice(0, i).trim()
      if (MANAGED.has(k) || !process.env[k]) process.env[k] = t.slice(i + 1).trim()
    }
  } catch { /* 没有 .env 就算了 */ }
}
module.exports = { loadEnv }
