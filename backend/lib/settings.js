// 可调参数（风控）：网页上可以调，但只能比设计文档的数字更严格，不能放宽
// 修改立即生效（模拟盘和回测共用），每次修改都留记录
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')

// 设计文档中的数值 = 上限（最宽松）
const DEFS = {
  riskPerTradePct: { label: '单笔风险（占权益 %）', min: 0.1, max: 0.5, step: 0.05, unit: '%', help: '每笔交易碰到止损时最多亏多少。越小越保守。' },
  dailyLossLimitPct: { label: '单日亏损上限（%）', min: 0.5, max: 2, step: 0.1, unit: '%', help: '当天（UTC）亏到这个比例，当天不再开新仓。' },
  maxDrawdownPct: { label: '最大回撤锁定（%）', min: 3, max: 10, step: 0.5, unit: '%', help: '从最高点回撤到这个比例，全部平仓并锁定，需要你手动解锁。' },
  maxGrossExposurePct: { label: '总仓位上限（占权益 %）', min: 10, max: 100, step: 5, unit: '%', help: '所有币种的仓位加起来不超过权益的多少。' },
  maxSymbolExposurePct: { label: '单个币仓位上限（%）', min: 10, max: 50, step: 5, unit: '%', help: '单个币的仓位不超过权益的多少。' },
  maxLeverage: { label: '杠杆上限（倍）', min: 1, max: 3, step: 0.5, unit: 'x', help: '总仓位 ÷ 权益的上限。' },
}
const DOC = { ...cfg.risk } // 启动时的文档默认值

let loaded = false
async function ensureLoaded(force = false) {
  if (loaded && !force) return
  const { rows } = await dbQuery(`SELECT key, value FROM trader_settings WHERE key LIKE 'risk.%'`)
  for (const r of rows) {
    const k = r.key.slice(5)
    const v = Number(r.value)
    if (DEFS[k] && Number.isFinite(v) && v >= DEFS[k].min && v <= DEFS[k].max) cfg.risk[k] = v
  }
  loaded = true
}

function view() {
  return Object.entries(DEFS).map(([key, d]) => ({ key, ...d, value: cfg.risk[key], docValue: DOC[key] }))
}

/** changes: { key: number }，reason 必填 */
async function update(changes, reason, source = 'web') {
  await ensureLoaded()
  reason = String(reason || '').trim().slice(0, 300)
  if (!reason) return { ok: false, error: '请填写修改原因（会记录在案）' }
  const applied = []
  for (const [key, raw] of Object.entries(changes || {})) {
    const d = DEFS[key]
    if (!d) return { ok: false, error: `不认识的参数：${key}` }
    const v = Math.round(Number(raw) * 1000) / 1000
    if (!Number.isFinite(v)) return { ok: false, error: `${d.label} 不是有效数字` }
    if (v > d.max) return { ok: false, error: `${d.label} 不能超过 ${d.max}${d.unit}（设计文档上限，只能更严格不能放宽）` }
    if (v < d.min) return { ok: false, error: `${d.label} 不能低于 ${d.min}${d.unit}` }
    if (v !== cfg.risk[key]) applied.push({ key, old: cfg.risk[key], value: v })
  }
  if (cfg.risk.maxSymbolExposurePct > cfg.risk.maxGrossExposurePct) {
    /* 保持原样，下面校验新值 */
  }
  const next = { ...cfg.risk, ...Object.fromEntries(applied.map((a) => [a.key, a.value])) }
  if (next.maxSymbolExposurePct > next.maxGrossExposurePct) return { ok: false, error: '单个币仓位上限不能大于总仓位上限' }
  if (!applied.length) return { ok: false, error: '没有任何变化' }
  const t = Date.now()
  for (const a of applied) {
    await dbQuery(
      `INSERT INTO trader_settings (key, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=$3`,
      [`risk.${a.key}`, JSON.stringify(a.value), t],
    )
    await dbQuery(`INSERT INTO settings_changes (ts, key, old_value, new_value, reason, source) VALUES ($1,$2,$3,$4,$5,$6)`, [
      t,
      `risk.${a.key}`,
      JSON.stringify(a.old),
      JSON.stringify(a.value),
      reason,
      source,
    ])
    cfg.risk[a.key] = a.value
  }
  const feed = require('./feed')
  await feed.logEvent(
    'warn',
    'settings',
    `风控参数已修改：${applied.map((a) => `${DEFS[a.key].label} ${a.old} → ${a.value}`).join('；')}（原因：${reason}）`,
  )
  return { ok: true, applied }
}

async function resetToDoc(reason) {
  const changes = Object.fromEntries(Object.keys(DEFS).map((k) => [k, DOC[k]]))
  return update(changes, reason || '恢复设计文档默认值')
}

async function history(limit = 50) {
  const { rows } = await dbQuery(
    `SELECT id, ts::float8 AS ts, key, old_value, new_value, reason, source FROM settings_changes ORDER BY id DESC LIMIT $1`,
    [limit],
  )
  const EXTRA = { 'ai.newsEnabled': 'AI 复盘参考新闻（Surf 点数）', 'ai.apiKey': 'AI 的 API Key（已打码）', 'ai.model': 'AI 模型' }
  const show = (v) => (v === true ? '开启' : v === false ? '关闭' : v)
  return rows.map((r) => ({ ...r, old_value: show(r.old_value), new_value: show(r.new_value), ts: Number(r.ts), label: DEFS[r.key.replace('risk.', '')]?.label ?? EXTRA[r.key] ?? r.key }))
}

module.exports = { ensureLoaded, view, update, resetToDoc, history, DEFS }
