// 风控引擎（确定性，纯函数，不可被策略覆盖）
// 所有数字来自 config.js；回测与模拟盘共用同一套规则
const cfg = require('./config')

const pct = (x) => `${(x * 100).toFixed(2)}%`

/** 当前敞口：按标的、按相关组、总敞口、杠杆（都以名义价值 / 权益计） */
function exposure(positions, marks, equity, conf = cfg) {
  const bySymbol = {}
  let gross = 0
  for (const [s, p] of Object.entries(positions || {})) {
    const n = Math.abs(p.qty * (marks[s] ?? p.entry_px ?? 0))
    bySymbol[s] = n
    gross += n
  }
  const byGroup = {}
  for (const [g, syms] of Object.entries(conf.correlationGroups || {})) byGroup[g] = syms.reduce((a, s) => a + (bySymbol[s] || 0), 0)
  return { bySymbol, byGroup, gross, leverage: equity > 0 ? gross / equity : 0 }
}

/**
 * 仓位计算：仓位 = 风险金额 / |入场价 − 止损价|，再按单标的 / 相关组 / 总敞口 / 杠杆上限裁剪
 */
function sizePosition({ equity, entryPx, stopPx, symbol, positions = {}, marks = {} }, conf = cfg) {
  const r = conf.risk
  const dist = Math.abs(entryPx - stopPx)
  const riskBudget = equity * (r.riskPerTradePct / 100)
  if (!(dist > 0) || !(equity > 0)) return { qty: 0, notional: 0, riskAmt: 0, riskBudget, dist, limitedBy: '止损距离无效' }
  const raw = riskBudget / dist
  const ex = exposure(positions, marks, equity, conf)
  const others = ex.gross - (ex.bySymbol[symbol] || 0)
  const group = Object.entries(conf.correlationGroups || {}).find(([, syms]) => syms.includes(symbol))
  const groupOthers = group ? ex.byGroup[group[0]] - (ex.bySymbol[symbol] || 0) : 0
  const caps = [
    { key: '风险预算', notional: raw * entryPx },
    { key: `单标的上限 ${r.maxSymbolExposurePct}%`, notional: equity * (r.maxSymbolExposurePct / 100) },
    { key: `总敞口上限 ${r.maxGrossExposurePct}%`, notional: equity * (r.maxGrossExposurePct / 100) - others },
    { key: `杠杆上限 ${r.maxLeverage}x`, notional: equity * r.maxLeverage - others },
  ]
  if (group) caps.push({ key: `相关资产组合并上限 ${r.maxGroupExposurePct ?? r.maxGrossExposurePct}%`, notional: equity * ((r.maxGroupExposurePct ?? r.maxGrossExposurePct) / 100) - groupOthers })
  const best = caps.reduce((a, b) => (b.notional < a.notional ? b : a))
  const notional = Math.max(0, best.notional)
  const qty = notional / entryPx
  return { qty, notional, riskAmt: qty * dist, riskBudget, dist, limitedBy: best.key }
}

function dailyLoss(equity, dayStartEquity, conf = cfg) {
  const lossPct = dayStartEquity > 0 ? (equity - dayStartEquity) / dayStartEquity : 0
  return { changePct: lossPct * 100, hit: lossPct <= -conf.risk.dailyLossLimitPct / 100 }
}

function drawdown(equity, peak, conf = cfg) {
  const dd = peak > 0 ? (peak - equity) / peak : 0
  return { ddPct: dd * 100, hit: dd >= conf.risk.maxDrawdownPct / 100 }
}

/**
 * 策略失效（P1-3）：累计 ≥ invalidationTrades 笔 且 运行 ≥ invalidationMinDays 天之后，
 * 才看最近 invalidationTrades 笔的盈亏比；< 阈值 → 自动下线。
 * age = { total: 累计笔数, days: 自第一笔开仓起的天数 }；不传则只按笔数判断（兼容旧调用）
 */
function strategyInvalidation(trades, conf = cfg, age = null) {
  const n = conf.paper.invalidationTrades
  const minDays = conf.paper.invalidationMinDays ?? 0
  const last = trades.slice(-n)
  const win = last.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0)
  const loss = -last.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0)
  const pf = loss ? win / loss : win ? 99 : 0
  const total = age?.total ?? trades.length
  const days = age?.days ?? Infinity
  const eligible = total >= n && last.length >= n && days >= minDays
  return { n: last.length, need: n, total, days, minDays, eligible, pf, invalid: eligible && pf < conf.paper.invalidationPf }
}

/**
 * 数据类自动暂停条件（每个标的）
 * quote: { last, index, ts } 或 null（取数失败）
 */
function dataChecks(quote, now, conf = cfg) {
  const age = quote?.ts ? (now - quote.ts) / 1000 : null
  const dev = quote?.last && quote?.index ? (Math.abs(quote.last - quote.index) / quote.index) * 100 : null
  return {
    stale: { ok: age != null && age <= conf.staleDataSeconds, value: age, detail: age == null ? '取不到行情' : `${Math.round(age)} 秒前` },
    deviation: {
      ok: dev != null && dev <= conf.priceSourceMaxDeviationPct,
      value: dev,
      detail: dev == null ? '无法比较' : `${dev.toFixed(3)}%`,
    },
  }
}

/**
 * 开仓前风控审核：逐项检查，任何一项不通过都拒绝
 * input: { status, pauseKeys, dayBlocked, enabled, disabled, regime, strategy, signal:{side, stop},
 *          refPx, equity, positions, marks, symbol, barFresh }
 */
function evaluateEntry(input, conf = cfg) {
  const checks = []
  const add = (key, label, ok, detail) => checks.push({ key, label, ok: !!ok, detail })
  const { signal, refPx, equity, symbol, strategy, regime } = input

  add('mode', '运行模式为模拟（PAPER）', conf.mode === 'PAPER', `当前 ${conf.mode}`)
  add('status', '系统处于运行状态', input.status === 'running', input.status === 'running' ? '运行中' : input.status === 'locked' ? '回撤锁定中' : '已紧急停止')
  add('pause', '没有自动暂停', !(input.pauseKeys || []).length, (input.pauseKeys || []).length ? `暂停原因：${input.pauseKeys.join('、')}` : '无')
  add('daily', `今日亏损未达 ${conf.risk.dailyLossLimitPct}%`, !input.dayBlocked, input.dayBlocked ? '今日已停开新仓' : '未触发')
  add('bar', 'K 线数据是最新的', input.barFresh, input.barFresh ? '最新' : 'K 线未更新')
  const allowed = conf.allowedStrategies[regime] || []
  if (input.regimeFilter === false) add('regime', '市场状态允许此策略', true, '研究模式：未开启市场状态过滤')
  else add('regime', '市场状态允许此策略', allowed.includes(strategy), `当前状态 ${regime}，允许：${allowed.join('、') || '无（不开新仓）'}`)
  add('enabled', '策略已启用且未失效', (input.enabled || []).includes(strategy) && !input.disabled?.[strategy], input.disabled?.[strategy] || ((input.enabled || []).includes(strategy) ? '正常' : '已手动停用'))
  add('noPos', '该币种当前没有持仓', !input.positions?.[symbol], input.positions?.[symbol] ? '已有持仓' : '无持仓')
  const rightSide = signal.side > 0 ? refPx > signal.stop : refPx < signal.stop
  add('stop', '止损价在正确一侧', rightSide, `成交参考价 ${refPx.toFixed(2)}，止损 ${signal.stop.toFixed(2)}`)

  let sizing = null
  if (rightSide) {
    sizing = sizePosition({ equity, entryPx: refPx, stopPx: signal.stop, symbol, positions: input.positions, marks: input.marks }, conf)
    add('size', '仓位不低于权益的 1%（太小不值得交易）', sizing.notional >= equity * 0.01, `仓位 ${sizing.notional.toFixed(0)} USDT（受「${sizing.limitedBy}」约束），风险 ${sizing.riskAmt.toFixed(2)} USDT = 权益 ${pct(sizing.riskAmt / equity)}`)
  }
  return { approved: checks.every((c) => c.ok), checks, sizing }
}

module.exports = { exposure, sizePosition, dailyLoss, drawdown, strategyInvalidation, dataChecks, evaluateEntry }
