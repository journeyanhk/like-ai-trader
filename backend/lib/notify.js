// P2-4 Telegram 直发：重要事件直接推送到你的 Telegram（不经过任何第三方中转）
// 配置（backend/.env）：TELEGRAM_BOT_TOKEN=xxx  TELEGRAM_CHAT_ID=xxx
// 规则：错误 / 警告 / 开平仓 / 人工操作 推送；同一条消息 10 分钟内不重复；每小时最多 30 条，防刷屏。
const SEND_TYPES = new Set(['risk', 'auto_pause', 'auto_resume', 'control', 'order', 'trade', 'system', 'data_quality', 'probe'])
const recent = new Map() // message -> ts
let hourKey = 0
let hourCount = 0
let lastError = null
let lastSentAt = null

const configured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)

async function sendTelegram(text) {
  if (!configured()) return { ok: false, error: '未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' }
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`)
    lastSentAt = Date.now()
    lastError = null
    return { ok: true }
  } catch (e) {
    lastError = e.message
    console.error('[notify] Telegram 发送失败：', e.message)
    return { ok: false, error: e.message }
  }
}

const ICON = { error: '🛑', warn: '⚠️', info: 'ℹ️' }

/** 由事件日志调用：决定是否推送（不阻塞调用方） */
function onEvent(level, type, message) {
  if (!configured()) return
  const important = level === 'error' || level === 'warn' || ['order', 'trade', 'control', 'auto_resume', 'probe'].includes(type)
  if (!important || !SEND_TYPES.has(type)) return
  const now = Date.now()
  if (recent.has(message) && now - recent.get(message) < 10 * 60_000) return
  const hk = Math.floor(now / 3600_000)
  if (hk !== hourKey) {
    hourKey = hk
    hourCount = 0
  }
  if (++hourCount > 30) return
  recent.set(message, now)
  for (const [m, t] of recent) if (now - t > 3600_000) recent.delete(m)
  sendTelegram(`${ICON[level] ?? ''} [模拟盘] ${message}`).catch(() => {})
}

const status = () => ({ configured: configured(), lastSentAt, lastError })

module.exports = { onEvent, sendTelegram, status, configured }
