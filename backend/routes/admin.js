// /api/admin —— 线上实例一次性初始化（线上没有 .env，且用的是独立数据库）
// POST /api/admin/bootstrap { token, chatId, pingUrl, settings?: {key:value}, settingsReason?, reset?: "原因" }
// 鉴权：token 的 sha256 必须等于下面固定的指纹（即 Telegram 机器人令牌；代码里只存指纹，不存令牌本身）。
// 做的事：告警凭证写入本库 app_secrets；风控设置与开发环境对齐（记录原因）；
//        可选：确认历史数据齐全后重置模拟账户并生成复现包（重新开始 30 天计时）。
const crypto = require('node:crypto')
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('../lib/config')

const ADMIN_SHA256 = '2a278d1241cdabec49698afe936bfbf22fd0a0a680f76a5a5e70bf605bf1af25'
const router = Router()
const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex')
const DAY = 86400_000

async function dataStatus() {
  const c = (await dbQuery(`SELECT symbol, COUNT(*)::int AS n, MIN(ts)::float8 AS first FROM candles WHERE interval='1h' GROUP BY symbol`)).rows
  const f = (await dbQuery(`SELECT symbol, COUNT(*)::int AS n, MIN(ts)::float8 AS first FROM funding_rates GROUP BY symbol`)).rows
  const needC = Math.floor(cfg.historyDays * 24 * 0.99)
  const needF = Math.floor(cfg.historyDays * 3 * 0.99)
  const complete = cfg.symbols.every((s) => (c.find((x) => x.symbol === s)?.n ?? 0) >= needC && (f.find((x) => x.symbol === s)?.n ?? 0) >= needF)
  return { candles1h: c.map((x) => ({ symbol: x.symbol, n: x.n })), funding: f.map((x) => ({ symbol: x.symbol, n: x.n })), needC, needF, complete }
}

router.post('/bootstrap', async (req, res) => {
  const b = req.body || {}
  if (sha(b.token) !== ADMIN_SHA256) return res.status(403).json({ ok: false, error: '鉴权失败' })
  try {
    const out = { ok: true, steps: [] }
    const put = (k, v) => dbQuery('INSERT INTO app_secrets (key,value,updated_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at', [k, String(v), Date.now()])
    await put('TELEGRAM_BOT_TOKEN', b.token)
    if (b.chatId) await put('TELEGRAM_CHAT_ID', b.chatId)
    if (b.pingUrl) await put('HEALTHCHECK_PING_URL', b.pingUrl)
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'HEALTHCHECK_PING_URL']) delete process.env[k]
    await require('../lib/runner').loadSecrets(true)
    out.steps.push('告警凭证已写入')

    if (b.settings && Object.keys(b.settings).length) {
      const r = await require('../lib/settings').update(b.settings, b.settingsReason || '线上初始化：与开发环境设置对齐', 'bootstrap')
      out.steps.push(`风控设置：${r.ok ? JSON.stringify(b.settings) : r.error}`)
    }

    // 历史数据：资金费不足 historyDays 就从 OKX 官方月度文件回填
    let d = await dataStatus()
    if (!d.complete) {
      await require('../lib/feed').syncAll()
      for (const s of cfg.symbols) {
        const n = d.funding.find((x) => x.symbol === s)?.n ?? 0
        if (n < d.needF) await require('../lib/fundingArchive').backfill(s, Date.now() - cfg.historyDays * DAY)
      }
      d = await dataStatus()
    }
    out.data = d

    if (b.reset) {
      if (!d.complete) return res.status(409).json({ ...out, ok: false, error: '历史数据还不齐全，暂不重置' })
      const paper = require('../lib/paper')
      const r = await paper.resetAccount(String(b.reset).slice(0, 200))
      const bundle = await require('../lib/repro').latest(r.startedAt)
      out.reset = { startedAt: r.startedAt, bundle: bundle && { id: bundle.id, config_hash: bundle.config_hash, code_hash: bundle.code_hash, git_commit: bundle.git_commit, data: bundle.data, params: bundle.params } }
    }
    const tg = await require('../lib/notify').sendTelegram('✅ [模拟盘·线上] 告警已接通：线上实例开始负责模拟盘与告警')
    out.telegram = tg
    await require('../lib/feed').logEvent('info', 'system', `线上初始化完成：${out.steps.join('；')}${out.reset ? `；模拟账户已重置，复现包 #${out.reset.bundle?.id}` : ''}；Telegram ${tg.ok ? '已接通' : '失败 ' + tg.error}`)
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
