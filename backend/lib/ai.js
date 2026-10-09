// AI 模型调用（DeepSeek，OpenAI 兼容接口）
// 边界：AI 只读代码算好的数字、只写文字；输出不会进入下单流程。不消耗 Surf 点数（费用走你自己的 DeepSeek 账户）。
const fs = require('fs')
const path = require('path')
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')

let balCache = { at: 0, value: null }

// 已知模型价格（美元 / 每 100 万 token，按高峰价，偏保守）；未知模型按最贵的估算
const MODELS = {
  'deepseek-flash': { label: 'DeepSeek Flash（快、便宜，推荐）', price: { inputHit: 0.006, inputMiss: 0.3, output: 1.2 } },
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro（更强，约贵 3 倍）', price: { inputHit: 0.044, inputMiss: 1.32, output: 3.96 } },
}
const FALLBACK_PRICE = MODELS['deepseek-v4-pro'].price

// 网页设置里保存的 Key / 模型（存在数据库 settings 表，优先于服务器 .env 文件）
const conf = { loaded: false, apiKey: null, model: null }
async function ensureConf(force = false) {
  if (conf.loaded && !force) return conf
  const { rows } = await dbQuery(`SELECT key, value FROM trader_settings WHERE key IN ('ai.apiKey','ai.model')`)
  conf.apiKey = null
  conf.model = null
  for (const r of rows) {
    if (r.key === 'ai.apiKey' && typeof r.value === 'string' && r.value) conf.apiKey = r.value
    if (r.key === 'ai.model' && typeof r.value === 'string' && r.value) conf.model = r.value
  }
  conf.loaded = true
  return conf
}

function envKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    const m = txt.match(/^DEEPSEEK_API_KEY=(.+)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}
function apiKey() {
  return conf.apiKey || envKey()
}
function keySource() {
  return conf.apiKey ? 'web' : envKey() ? 'file' : null
}
const mask = (k) => (k ? `${k.slice(0, 5)}••••${k.slice(-4)}` : null)
function model() {
  return conf.model || cfg.ai.model
}
const priceOf = (m) => MODELS[m]?.price ?? FALLBACK_PRICE

/** 用某个 Key 拉取可用模型列表（免费接口）；Key 无效会抛错 */
async function fetchModels(key) {
  const r = await fetch(`${cfg.ai.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  if (r.status === 401 || r.status === 403) throw new Error('API Key 无效（DeepSeek 拒绝了这个 Key）')
  if (!r.ok) throw new Error(`DeepSeek 接口返回 ${r.status}，请稍后再试`)
  const b = await r.json()
  return (b?.data ?? []).map((x) => x.id).filter(Boolean)
}

let modelsCache = { at: 0, key: null, value: null }
async function listModels() {
  await ensureConf()
  const key = apiKey()
  let ids = Object.keys(MODELS)
  let fromApi = false
  if (key) {
    if (modelsCache.key === key && Date.now() - modelsCache.at < 10 * 60_000) {
      ids = modelsCache.value
      fromApi = true
    } else {
      try {
        ids = await fetchModels(key)
        modelsCache = { at: Date.now(), key, value: ids }
        fromApi = true
      } catch {
        /* 用内置列表 */
      }
    }
  }
  return ids.map((id) => ({ id, label: MODELS[id]?.label ?? id, price: priceOf(id), knownPrice: !!MODELS[id], available: fromApi }))
}

/** 网页保存 Key / 模型：Key 先验证再保存；每次修改都留记录 */
async function updateConfig({ apiKey: newKey, model: newModel }, reason) {
  await ensureConf()
  reason = String(reason || '').trim().slice(0, 300)
  if (!reason) return { ok: false, error: '请填写修改原因（会记录在案）' }
  const changes = []
  if (newKey != null && String(newKey).trim()) {
    const k = String(newKey).trim()
    if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(k)) return { ok: false, error: 'API Key 格式不对（应以 sk- 开头）' }
    if (k !== apiKey()) {
      try {
        await fetchModels(k)
      } catch (e) {
        return { ok: false, error: e.message }
      }
      changes.push({ key: 'ai.apiKey', value: k, old: mask(apiKey()), shown: mask(k) })
    }
  }
  if (newModel != null && String(newModel).trim() && String(newModel).trim() !== model()) {
    const m = String(newModel).trim()
    const ids = (await listModels()).map((x) => x.id)
    if (!ids.includes(m)) return { ok: false, error: `没有这个模型：${m}` }
    changes.push({ key: 'ai.model', value: m, old: model(), shown: m })
  }
  if (!changes.length) return { ok: false, error: '没有任何变化' }
  const t = Date.now()
  for (const c of changes) {
    await dbQuery(`INSERT INTO trader_settings (key, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=$3`, [c.key, JSON.stringify(c.value), t])
    // 修改记录里只保存打码后的 Key
    await dbQuery(`INSERT INTO settings_changes (ts, key, old_value, new_value, reason, source) VALUES ($1,$2,$3,$4,$5,'web')`, [t, c.key, JSON.stringify(c.old), JSON.stringify(c.shown), reason])
  }
  await ensureConf(true)
  balCache = { at: 0, value: null }
  modelsCache = { at: 0, key: null, value: null }
  const feed = require('./feed')
  await feed.logEvent('warn', 'settings', `AI 设置已修改：${changes.map((c) => (c.key === 'ai.apiKey' ? `API Key → ${c.shown}` : `模型 ${c.old} → ${c.shown}`)).join('；')}（原因：${reason}）`)
  return { ok: true }
}

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

/** 今天 / 本月用量（从 trade_reviews 统计，按 created_at 的 UTC 日期） */
async function usage() {
  await ensureConf()
  const t = Date.now()
  const d0 = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())
  const m0 = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1)
  const { rows } = await dbQuery(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= $1 AND model IS NOT NULL)::int AS calls_today,
       COUNT(*) FILTER (WHERE created_at >= $1 AND kind='market' AND trigger='manual' AND model IS NOT NULL)::int AS market_today,
       COUNT(*) FILTER (WHERE model IS NOT NULL)::int AS calls_month,
       COALESCE(SUM(cost_usd),0)::float8 AS cost_month,
       COALESCE(SUM(news_credits),0)::int AS news_credits_month
     FROM trade_reviews WHERE created_at >= $2`,
    [d0, m0],
  )
  const r = rows[0]
  return {
    callsToday: r.calls_today,
    marketToday: r.market_today,
    callsMonth: r.calls_month,
    costMonthUsd: Number(r.cost_month),
    newsCreditsMonth: r.news_credits_month,
    limits: { maxCallsPerDay: cfg.ai.maxCallsPerDay, marketCallsPerDay: cfg.ai.marketCallsPerDay, monthlyBudgetUsd: cfg.ai.monthlyBudgetUsd },
  }
}

/** 能不能调用；不能就返回原因 */
async function canCall(kind) {
  if (!apiKey()) return { ok: false, reason: '未配置 DeepSeek API Key' }
  const u = await usage()
  if (u.callsToday >= cfg.ai.maxCallsPerDay) return { ok: false, reason: `今天 AI 调用已达上限 ${cfg.ai.maxCallsPerDay} 次` }
  if (kind === 'market' && u.marketToday >= cfg.ai.marketCallsPerDay) return { ok: false, reason: `今天「解读市场」已用完 ${cfg.ai.marketCallsPerDay} 次` }
  if (u.costMonthUsd >= cfg.ai.monthlyBudgetUsd) return { ok: false, reason: `本月估算花费已达预算 ${cfg.ai.monthlyBudgetUsd} 美元` }
  return { ok: true }
}

function cost(u, m) {
  const p = priceOf(m)
  const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0
  const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, (u?.prompt_tokens ?? 0) - hit)
  return (hit * p.inputHit + miss * p.inputMiss + (u?.completion_tokens ?? 0) * p.output) / 1e6
}

/** 调用模型，要求返回 JSON */
async function chatJSON(system, user) {
  await ensureConf()
  const useModel = model()
  const key = apiKey()
  if (!key) throw new Error('未配置 DeepSeek API Key')
  const started = Date.now()
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.ai.timeoutMs)
    try {
      const r = await fetch(`${cfg.ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: useModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          max_tokens: cfg.ai.maxTokens,
        }),
        signal: ctrl.signal,
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        const msg = body?.error?.message || `HTTP ${r.status}`
        // 余额不足 / Key 错误不重试
        if ([400, 401, 402, 403, 422].includes(r.status)) throw Object.assign(new Error(msg), { fatal: true })
        throw new Error(msg)
      }
      const text = body?.choices?.[0]?.message?.content ?? ''
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error('AI 返回的不是有效 JSON')
      }
      return { json, usage: body.usage ?? null, costUsd: cost(body.usage, useModel), model: body.model || useModel, ms: Date.now() - started }
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('AI 调用超时') : e
      if (e.fatal) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

/** DeepSeek 账户余额（免费接口，缓存 10 分钟） */
async function balance() {
  if (Date.now() - balCache.at < 10 * 60_000) return balCache.value
  await ensureConf()
  const key = apiKey()
  let value = null
  if (key) {
    try {
      const r = await fetch(`${cfg.ai.baseUrl}/user/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
      const b = await r.json()
      const info = b?.balance_infos?.find((x) => Number(x.total_balance) > 0) ?? b?.balance_infos?.[0]
      value = info ? { currency: info.currency, total: Number(info.total_balance), available: !!b.is_available } : null
    } catch {
      value = null
    }
  }
  balCache = { at: Date.now(), value }
  return value
}

module.exports = {
  apiKey,
  hasKey: () => !!apiKey(),
  ensureConf,
  keyInfo: () => ({ masked: mask(apiKey()), source: keySource() }),
  model,
  priceOf,
  listModels,
  updateConfig,
  usage,
  canCall,
  chatJSON,
  balance,
  dayKey,
}
