// AI 模型调用（DeepSeek，OpenAI 兼容接口）
// 边界：AI 只读代码算好的数字、只写文字；输出不会进入下单流程。不消耗 Surf 点数（费用走你自己的 DeepSeek 账户）。
const fs = require('fs')
const path = require('path')
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    const m = txt.match(/^DEEPSEEK_API_KEY=(.+)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

/** 今天 / 本月用量（从 trade_reviews 统计，按 created_at 的 UTC 日期） */
async function usage() {
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

function cost(u) {
  const p = cfg.ai.priceUsdPerM
  const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0
  const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, (u?.prompt_tokens ?? 0) - hit)
  return (hit * p.inputHit + miss * p.inputMiss + (u?.completion_tokens ?? 0) * p.output) / 1e6
}

/** 调用模型，要求返回 JSON */
async function chatJSON(system, user) {
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
          model: cfg.ai.model,
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
      return { json, usage: body.usage ?? null, costUsd: cost(body.usage), model: body.model || cfg.ai.model, ms: Date.now() - started }
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('AI 调用超时') : e
      if (e.fatal) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

let balCache = { at: 0, value: null }
/** DeepSeek 账户余额（免费接口，缓存 10 分钟） */
async function balance() {
  if (Date.now() - balCache.at < 10 * 60_000) return balCache.value
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

module.exports = { apiKey, hasKey: () => !!apiKey(), usage, canCall, chatJSON, balance, dayKey }
