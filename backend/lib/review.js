// AI 复盘：代码先算好所有数字（facts），AI 只负责把数字写成中文点评。
// AI 的文字只存档、只给人看，永远不进入下单流程。
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const ai = require('./ai')
const feed = require('./feed')
const okx = require('./okx')
const jobs = require('./jobs')
const paper = require('./paper')
const { STRATEGIES } = require('./strategies')
const { LABELS } = require('./regime')

const DAY = 86400_000
const H1 = 3600_000
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)
const stratLabel = (k) => STRATEGIES[k]?.label ?? k
const n = (x) => (x == null ? null : Number(x))

// ---------- 设置：新闻开关（默认关闭，开启会消耗 Surf 点数） ----------
async function getAiSettings() {
  const { rows } = await dbQuery(`SELECT value FROM settings WHERE key='ai.newsEnabled'`)
  return { newsEnabled: rows[0]?.value === true }
}

async function setNewsEnabled(enabled, reason) {
  reason = String(reason || '').trim().slice(0, 300)
  if (!reason) return { ok: false, error: '请填写修改原因（会记录在案）' }
  const cur = await getAiSettings()
  enabled = !!enabled
  if (cur.newsEnabled === enabled) return { ok: false, error: '没有任何变化' }
  const t = Date.now()
  await dbQuery(`INSERT INTO settings (key, value, updated_at) VALUES ('ai.newsEnabled',$1,$2) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=$2`, [
    JSON.stringify(enabled),
    t,
  ])
  await dbQuery(`INSERT INTO settings_changes (ts, key, old_value, new_value, reason, source) VALUES ($1,'ai.newsEnabled',$2,$3,$4,'web')`, [
    t,
    JSON.stringify(cur.newsEnabled),
    JSON.stringify(enabled),
    reason,
  ])
  await feed.logEvent('warn', 'settings', `AI 复盘参考新闻：${enabled ? '开启（每天约 1 次 Surf 调用）' : '关闭'}（原因：${reason}）`)
  return { ok: true }
}

// ---------- 新闻（Surf 数据接口，仅在开关打开时调用，每次复盘 1 次） ----------
async function fetchNews(from, to) {
  const { dataApi } = require('@surf-ai/sdk/server')
  const res = await dataApi.news.feed({ from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)), limit: cfg.ai.newsLimit })
  const items = (res?.data ?? [])
    .filter((x) => x?.title)
    .map((x) => ({ title: x.title, summary: x.summary?.slice(0, 300) ?? null, source: x.source ?? null, project: x.project_name ?? null, ts: x.published_at ? x.published_at * 1000 : null, url: x.url ?? null }))
  return { items, credits: Number(res?.meta?.credits_used ?? 0) }
}

// ---------- 每日事实（全部由代码计算） ----------
async function dailyFacts(day) {
  const start = Date.parse(`${day}T00:00:00Z`)
  const end = start + DAY
  await paper.load()
  const snap = paper.snapshot()

  // 权益
  const eqBefore = (await dbQuery(`SELECT equity FROM paper_equity WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`, [start])).rows[0]
  const eqRows = (await dbQuery(`SELECT ts::float8 AS ts, equity FROM paper_equity WHERE ts > $1 AND ts <= $2 ORDER BY ts`, [start, end])).rows.map((r) => ({ ts: n(r.ts), equity: n(r.equity) }))
  const startEq = eqBefore ? n(eqBefore.equity) : eqRows[0]?.equity ?? cfg.paperStartingEquity
  const endEq = eqRows.length ? eqRows[eqRows.length - 1].equity : startEq
  let pk = startEq
  let intradayDd = 0
  for (const p of eqRows) {
    pk = Math.max(pk, p.equity)
    intradayDd = Math.max(intradayDd, ((pk - p.equity) / pk) * 100)
  }

  // 成交
  const trades = (
    await dbQuery(`SELECT symbol, strategy, side, entry_ts::float8 AS entry_ts, exit_ts::float8 AS exit_ts, entry_px, exit_px, pnl, risk_amt, reason, regime, fees, funding FROM paper_trades WHERE exit_ts >= $1 AND exit_ts < $2 ORDER BY exit_ts`, [start, end])
  ).rows.map((t) => ({
    symbol: t.symbol,
    strategy: stratLabel(t.strategy),
    side: t.side === 'long' || Number(t.side) > 0 ? '做多' : '做空',
    entryPx: r2(n(t.entry_px)),
    exitPx: r2(n(t.exit_px)),
    pnl: r2(n(t.pnl)),
    r: t.risk_amt ? r2(n(t.pnl) / n(t.risk_amt)) : null,
    holdHours: r2((n(t.exit_ts) - n(t.entry_ts)) / H1, 1),
    exitReason: t.reason,
    regimeAtEntry: LABELS[t.regime] ?? t.regime,
    costs: r2(n(t.fees || 0) + n(t.funding || 0)),
  }))
  const opened = (await dbQuery(`SELECT COUNT(*)::int AS c FROM paper_orders WHERE intent='open' AND status='FILLED' AND created_at >= $1 AND created_at < $2`, [start, end])).rows[0].c
  const orderStatus = Object.fromEntries(
    (await dbQuery(`SELECT status, COUNT(*)::int AS c FROM paper_orders WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [start, end])).rows.map((r) => [r.status, r.c]),
  )

  // 分策略（当天 + 累计）
  const allTrades = (await dbQuery(`SELECT strategy, pnl, exit_ts::float8 AS exit_ts FROM paper_trades WHERE exit_ts < $1`, [end])).rows
  const statOf = (rows) => {
    const w = rows.filter((x) => n(x.pnl) > 0)
    const gw = w.reduce((a, b) => a + n(b.pnl), 0)
    const gl = -rows.filter((x) => n(x.pnl) <= 0).reduce((a, b) => a + n(b.pnl), 0)
    return { trades: rows.length, pnl: r2(rows.reduce((a, b) => a + n(b.pnl), 0)), winRatePct: rows.length ? r2((w.length / rows.length) * 100, 1) : null, profitFactor: gl ? r2(gw / gl) : null }
  }
  const strategies = Object.values(STRATEGIES).map((s) => {
    const st = snap.strategies.find((x) => x.name === s.name)
    const mine = allTrades.filter((t) => t.strategy === s.name)
    return {
      name: s.label,
      enabled: !!st?.enabled,
      disabledReason: st?.disabledReason ?? null,
      allowedRegimes: s.allowedRegimes.map((r) => LABELS[r] ?? r),
      today: statOf(mine.filter((t) => n(t.exit_ts) >= start)),
      cumulative: statOf(mine),
    }
  })

  // 决策：每小时循环里没开仓的原因
  const cycles = (await dbQuery(`SELECT summary FROM paper_cycles WHERE ts >= $1 AND ts < $2 ORDER BY ts`, [start, end])).rows
  const notes = {}
  for (const c of cycles) for (const d of c.summary?.decisions ?? []) for (const note of d.notes ?? []) {
    if (note.includes('补跑')) continue
    const k = `${d.symbol}：${note}`
    notes[k] = (notes[k] || 0) + 1
  }

  // 市场状态
  const regimes = {}
  for (const s of cfg.symbols) {
    const rows = (await dbQuery(`SELECT regime, bar_ts::float8 AS bar_ts FROM regime_snapshots WHERE symbol=$1 AND bar_ts >= $2 AND bar_ts < $3 ORDER BY bar_ts`, [s, start - H1, end])).rows
    const hours = {}
    let changes = 0
    rows.forEach((r, i) => {
      hours[LABELS[r.regime] ?? r.regime] = (hours[LABELS[r.regime] ?? r.regime] || 0) + 1
      if (i && rows[i - 1].regime !== r.regime) changes++
    })
    const bars = (await dbQuery(`SELECT open, high, low, close FROM candles WHERE symbol=$1 AND interval='1h' AND ts >= $2 AND ts < $3 ORDER BY ts`, [s, start, end])).rows
    regimes[s] = {
      hoursByRegime: hours,
      changes,
      endRegime: rows.length ? LABELS[rows[rows.length - 1].regime] : null,
      price: bars.length
        ? { open: r2(n(bars[0].open)), close: r2(n(bars[bars.length - 1].close)), high: r2(Math.max(...bars.map((b) => n(b.high)))), low: r2(Math.min(...bars.map((b) => n(b.low)))), changePct: r2((n(bars[bars.length - 1].close) / n(bars[0].open) - 1) * 100) }
        : null,
    }
  }

  // 事件
  const evRows = (await dbQuery(`SELECT ts::float8 AS ts, level, type, message FROM events WHERE ts >= $1 AND ts < $2 ORDER BY ts`, [start, end])).rows
  const evCount = {}
  for (const e of evRows) evCount[e.level] = (evCount[e.level] || 0) + 1
  const important = evRows
    .filter((e) => e.level !== 'info' || ['control', 'risk', 'trade', 'auto_resume', 'regime_change'].includes(e.type))
    .slice(-40)
    .map((e) => ({ time: new Date(n(e.ts)).toISOString().slice(11, 16) + ' UTC', level: e.level, type: e.type, message: e.message }))

  const settingChanges = (await dbQuery(`SELECT key, old_value, new_value, reason FROM settings_changes WHERE ts >= $1 AND ts < $2 ORDER BY ts`, [start, end])).rows

  // 回测基准（最近一次完成的回测）
  const bt = (await dbQuery(`SELECT id, summary FROM backtest_runs WHERE status='done' ORDER BY id DESC LIMIT 1`)).rows[0]

  const t = Date.now()
  return {
    day,
    mode: cfg.mode,
    account: {
      state: snap.state,
      statusReason: snap.statusReason,
      startEquity: r2(startEq),
      endEquity: r2(endEq),
      dayPnl: r2(endEq - startEq),
      dayReturnPct: r2((endEq / startEq - 1) * 100, 3),
      intradayMaxDrawdownPct: r2(intradayDd, 3),
      totalReturnPct: r2((endEq / cfg.paperStartingEquity - 1) * 100, 3),
      runningDays: snap.startedAt ? r2(Math.max(0, (Math.min(end, t) - snap.startedAt) / DAY), 1) : null,
      paperStartedAt: snap.startedAt ? new Date(snap.startedAt).toISOString() : null,
      note: snap.startedAt && snap.startedAt >= end ? '这一天模拟盘还没有开始运行' : end > t ? '这一天还没结束，数据截至现在' : null,
      openPositionsNow: snap.positions.map((p) => ({ symbol: p.symbol, side: p.side > 0 ? '做多' : '做空', entryPx: r2(p.entry_px), mark: r2(p.mark), unrealized: r2(p.unrealized), strategy: p.strategyLabel })),
    },
    trading: { opened, closed: trades.length, orderStatus, trades },
    strategies,
    whyNoTrade: Object.entries(notes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, c]) => `${k}（${c} 次）`),
    hourlyCycles: { ran: cycles.length, expected: Math.min(24, Math.max(0, Math.floor((Math.min(end, t) - start) / H1))) },
    market: regimes,
    events: { countByLevel: evCount, important },
    riskSettings: { ...cfg.risk },
    settingChanges,
    backtestBaseline: bt ? { id: bt.id, ...(bt.summary ?? {}) } : null,
  }
}

// ---------- 当前市场事实 ----------
async function marketFacts() {
  await paper.load()
  const snap = paper.snapshot()
  const fg = await okx.fearGreed(7).catch(() => [])
  const symbols = []
  for (const s of cfg.symbols) {
    const live = await okx.snapshot(s).catch(() => null)
    const reg = await jobs.regimeFor(s, { spreadPct: live?.spreadPct })
    symbols.push({
      symbol: s,
      price: r2(live?.price),
      change24hPct: r2(live?.change24hPct),
      high24h: live?.high24h,
      low24h: live?.low24h,
      fundingRate8hPct: live?.fundingRate8h != null ? r2(live.fundingRate8h * 100, 4) : null,
      openInterestUsd: live?.openInterestUsd ?? null,
      regime: reg.label,
      regimeReasons: reg.reasons,
      metrics: reg.metrics ? Object.fromEntries(Object.entries(reg.metrics).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, r2(v, 4)])) : null,
      strategiesAllowedNow: (cfg.allowedStrategies[reg.regime] ?? []).map(stratLabel),
    })
  }
  return {
    time: new Date().toISOString(),
    mode: cfg.mode,
    fearGreed: fg.slice(0, 7),
    symbols,
    system: {
      state: snap.state,
      equity: r2(snap.equity),
      positions: snap.positions.map((p) => ({ symbol: p.symbol, side: p.side > 0 ? '做多' : '做空', entryPx: r2(p.entry_px), stop: r2(p.stop), unrealized: r2(p.unrealized), strategy: p.strategyLabel })),
      enabledStrategies: snap.strategies.filter((x) => x.enabled).map((x) => x.label),
      gauges: snap.gauges,
    },
    rules: {
      regimeToStrategies: Object.fromEntries(Object.entries(cfg.allowedStrategies).map(([k, v]) => [LABELS[k] ?? k, v.map(stratLabel)])),
    },
  }
}

// ---------- 提示词 ----------
const BOUNDARY = `你是一个加密货币量化交易系统的「研究员」，读者是不懂编程的项目负责人，请用简单直接的中文。
硬性规则：
1. 你只能写分析文字。你的输出不会、也不能进入下单流程，系统的开仓、平仓、仓位全部由确定性代码和风控决定。
2. 不要给出具体的买卖指令、目标价、仓位大小或杠杆建议。
3. 只根据提供的数据说话；数据里没有的不要编造。数据不足就直说「数据不足」。
4. 改进建议必须是「待验证的假设」，并说明用回测怎么验证。
5. 当前是模拟盘（PAPER），不涉及真钱。`

function dailyPrompt(facts, news) {
  const schema = `{
  "headline": "一句话总结今天（20 字以内）",
  "summary": "3-5 句话：今天账户怎么样、做了什么、为什么",
  "market": "2-3 句话：BTC/ETH 今天走势和市场状态变化，以及对系统的影响",
  "strategies": [{"name": "策略名", "comment": "1-2 句点评，含当天和累计表现"}],
  "anomalies": [{"title": "异常标题", "comment": "发生了什么、影响、是否需要人工处理"}],
  "improvements": [{"idea": "待验证的改进点", "why": "依据", "howToVerify": "在回测实验室里怎么验证"}],
  "watch": ["明天值得关注的 1-3 件事"],
  "news": "如果提供了新闻：1-3 句话说相关新闻可能如何解释今天的行情；没有新闻则为空字符串"
}`
  return `下面是交易系统 ${facts.day}（UTC）这一天的数据，全部由代码计算，请写每日复盘。
没有交易也是正常的，请解释为什么没有交易（参考 whyNoTrade）。没有异常时 anomalies 返回空数组。

数据：
${JSON.stringify(facts)}
${news?.items?.length ? `\n当天新闻（仅供参考解释行情，不要据此给交易指令）：\n${JSON.stringify(news.items.map((x) => ({ title: x.title, summary: x.summary, source: x.source })))}` : ''}

只输出 JSON，格式：
${schema}`
}

function marketPrompt(facts) {
  return `下面是此刻的市场数据和交易系统状态（全部由代码计算）。请给项目负责人做一次市场解读。

数据：
${JSON.stringify(facts)}

只输出 JSON，格式：
{
  "headline": "一句话（20 字以内）",
  "symbols": [{"symbol": "BTC/USDT", "view": "2-3 句：现在是什么市场、指标说明了什么", "watch": "接下来看什么信号会改变判断"}],
  "systemFit": "2-3 句：按现有规则，系统接下来大概率会怎么做（例如为什么不开仓/会用哪个策略）",
  "risks": ["1-3 条需要留意的风险"],
  "sentiment": "1 句：恐惧贪婪指数说明了什么"
}`
}

// ---------- 生成 ----------
async function save(row) {
  const { rows } = await dbQuery(
    `INSERT INTO trade_reviews (kind, day, created_at, trigger, status, facts, content, model, usage, cost_usd, news, news_credits, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      row.kind,
      row.day,
      Date.now(),
      row.trigger,
      row.status,
      JSON.stringify(row.facts ?? null),
      row.content ? JSON.stringify(row.content) : null,
      row.model ?? null,
      row.usage ? JSON.stringify(row.usage) : null,
      row.costUsd ?? null,
      row.news ? JSON.stringify(row.news) : null,
      row.newsCredits ?? null,
      row.error ?? null,
    ],
  )
  return rows[0].id
}

let busy = false
async function generateDaily(day, trigger = 'manual') {
  if (busy) return { ok: false, error: '正在生成中，请稍候' }
  busy = true
  try {
    const facts = await dailyFacts(day)
    let news = null
    let newsCredits = null
    let newsError = null
    if ((await getAiSettings()).newsEnabled) {
      try {
        const start = Date.parse(`${day}T00:00:00Z`)
        const r = await fetchNews(start, start + DAY)
        news = r
        newsCredits = r.credits
      } catch (e) {
        newsError = `新闻获取失败：${e.message}`
      }
    }
    const gate = await ai.canCall('daily')
    if (!gate.ok) {
      const id = await save({ kind: 'daily', day, trigger, status: 'no_ai', facts, error: gate.reason, news: news?.items, newsCredits })
      return { ok: true, id, status: 'no_ai', reason: gate.reason }
    }
    try {
      const r = await ai.chatJSON(BOUNDARY, dailyPrompt(facts, news))
      const id = await save({ kind: 'daily', day, trigger, status: 'ok', facts, content: r.json, model: r.model, usage: { ...r.usage, ms: r.ms }, costUsd: r.costUsd, news: news?.items, newsCredits, error: newsError })
      await feed.logEvent('info', 'review', `${day} 每日复盘已生成（AI 费用约 $${r.costUsd.toFixed(4)}${newsCredits ? `，新闻消耗 Surf ${newsCredits} 点` : ''}）`, { id })
      return { ok: true, id, status: 'ok' }
    } catch (e) {
      const id = await save({ kind: 'daily', day, trigger, status: 'error', facts, model: cfg.ai.model, error: e.message, news: news?.items, newsCredits })
      await feed.logEvent('warn', 'review', `${day} 每日复盘 AI 调用失败：${e.message}（数字部分已保存）`, { id })
      return { ok: false, id, status: 'error', error: e.message }
    }
  } finally {
    busy = false
  }
}

async function generateMarket() {
  const gate = await ai.canCall('market')
  if (!gate.ok) return { ok: false, error: gate.reason }
  const facts = await marketFacts()
  const day = ai.dayKey()
  try {
    const r = await ai.chatJSON(BOUNDARY, marketPrompt(facts))
    const id = await save({ kind: 'market', day, trigger: 'manual', status: 'ok', facts, content: r.json, model: r.model, usage: { ...r.usage, ms: r.ms }, costUsd: r.costUsd })
    return { ok: true, id }
  } catch (e) {
    await save({ kind: 'market', day, trigger: 'manual', status: 'error', facts, model: cfg.ai.model, error: e.message })
    return { ok: false, error: e.message }
  }
}

/** 昨天的复盘是否已生成；没有就补（UTC 00:10 之后、整个进程每天只检查一次） */
let checkedDay = null
async function ensureYesterday() {
  const t = Date.now()
  const today = ai.dayKey(t)
  if (checkedDay === today) return null
  if ((t % DAY) / 60_000 < 10) return null
  const y = ai.dayKey(t - DAY)
  const { rows } = await dbQuery(`SELECT 1 FROM trade_reviews WHERE kind='daily' AND day=$1 LIMIT 1`, [y])
  checkedDay = today
  if (rows.length) return null
  // 模拟盘还没开始的日期不补
  await paper.load()
  const snap = paper.snapshot()
  if (snap?.startedAt && snap.startedAt >= Date.parse(`${y}T00:00:00Z`) + DAY) return null
  console.log(`[review] 补生成 ${y} 的每日复盘`)
  return generateDaily(y, 'catchup')
}

module.exports = { dailyFacts, marketFacts, generateDaily, generateMarket, ensureYesterday, getAiSettings, setNewsEnabled, isBusy: () => busy }
