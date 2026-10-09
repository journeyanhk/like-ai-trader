// 验收清单：把设计文档的验收标准变成可自动计算、自动打勾的检查项
// 全部打勾之前，系统不开放实盘模式。全部本地计算，不调用付费接口。
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const paper = require('./paper')
const { runBacktest } = require('./backtest')
const { STRATEGIES } = require('./strategies')

const DAY = 86400_000
const H1 = 3600_000
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)

// ---------- 1. 回测（滚动样本外）----------
async function backtestPart(runId) {
  const runs = (
    await dbQuery(`SELECT id, created_at, summary FROM backtest_runs WHERE status='done' ORDER BY id DESC LIMIT 30`)
  ).rows.map((r) => ({ id: r.id, createdAt: r.created_at ? new Date(r.created_at).getTime() : null, summary: r.summary }))
  const chosenId = runId && runs.some((r) => r.id === runId) ? runId : runs[0]?.id
  if (!chosenId) return { runs, run: null, checks: null }
  const { rows } = await dbQuery(`SELECT id, summary, result->'checks' AS checks FROM backtest_runs WHERE id=$1`, [chosenId])
  const run = rows[0]
  const checks = Object.fromEntries((run.checks ?? []).map((c) => [c.key, c]))
  const s = run.summary ?? {}
  const warnings = []
  if (s.symbols && cfg.symbols.some((x) => !s.symbols.includes(x))) warnings.push(`这次回测只包含 ${s.symbols.join('、')}，模拟盘交易的是 ${cfg.symbols.join('、')}`)
  if (s.regimeFilter === false) warnings.push('这次回测没有开启市场状态过滤，和模拟盘规则不一致')
  if (!s.holdoutFrom || s.to > cfg.backtest.holdoutFrom) warnings.push(`这次回测用到了留出集（${new Date(cfg.backtest.holdoutFrom).toISOString().slice(0, 10)} 之后的最近 ${cfg.backtest.holdoutDays} 天），不能作为策略比较依据，请重新运行回测`)
  return { runs, run: { id: run.id, summary: s }, checks, warnings }
}

// ---------- 2. 模拟盘 vs 同期回测偏差（缓存：同一根 K 线只算一次）----------
let devCache = { key: null, value: null }
let devRunning = null
async function paperVsBacktest(snap) {
  const repro = require('./repro')
  const bundle = await repro.latest(snap.startedAt)
  const key = `${snap.startedAt}|${snap.lastBarTs}|${bundle?.id ?? 'none'}`
  if (devCache.key === key) return devCache.value
  if (devRunning) return devRunning
  devRunning = (async () => {
    const start = cfg.paperStartingEquity
    const paperRet = (snap.equity / start - 1) * 100
    const eqRows = (await dbQuery(`SELECT ts::float8 AS ts, equity FROM paper_equity ORDER BY ts`)).rows.map((r) => ({ ts: Number(r.ts), equity: Number(r.equity) }))
    const { rows: tr } = await dbQuery(`SELECT COUNT(*)::int AS c FROM paper_trades`)
    const base0 = { paperReturnPct: r2(paperRet, 3), paperTrades: tr[0].c, formula: `|模拟收益 − 回测收益| ÷ max(|回测收益|, ${cfg.acceptance.devMinBaseReturnPct}%)`, computedAt: Date.now() }
    if (!bundle) {
      const value = { ...base0, missingBundle: true, devPct: null, curve: [], note: '没有找到这次模拟的复现包，无法重跑同期回测（重启后端会自动补建）' }
      devCache = { key, value }
      return value
    }
    let bt = null
    let ledgerDiff = null
    const check = await repro.verify(bundle)
    if (snap.lastBarTs != null && snap.lastBarTs >= bundle.params.from) {
      // 只用复现包里的参数、配置、策略参数重跑
      const { res } = await repro.rerun(bundle, snap.lastBarTs)
      const hourly = res.hourly.map((h) => ({ ts: h.ts + H1, equity: h.equity }))
      const btLedger = require('./simulate').ledger(res.state)
      bt = { returnPct: (btLedger.equity / start - 1) * 100, trades: res.trades.length, fills: res.state.fills.length, curve: hourly, ledger: btLedger }
      if (snap.ledger) ledgerDiff = Object.fromEntries(Object.keys(btLedger).map((k) => [k, r2(snap.ledger[k] - btLedger[k], 6)]))
    }
    const btRet = bt?.returnPct ?? 0
    const base = Math.max(Math.abs(btRet), cfg.acceptance.devMinBaseReturnPct)
    const devPct = (Math.abs(paperRet - btRet) / base) * 100
    const btMap = new Map((bt?.curve ?? []).map((p) => [p.ts, p.equity]))
    const curve = eqRows.filter((p) => p.ts >= bundle.params.from).map((p) => ({ ts: p.ts, paper: r2(p.equity), backtest: r2(btMap.get(p.ts) ?? null) }))
    const value = {
      ...base0,
      from: bundle.params.from,
      to: snap.lastBarTs,
      strategies: bundle.params.strategies.map((n) => STRATEGIES[n]?.label ?? n),
      backtestReturnPct: r2(btRet, 3),
      backtestTrades: bt?.trades ?? 0,
      devPct: r2(devPct, 1),
      ledgerDiff, // 模拟盘账本 − 复现回测账本（六个字段）
      repro: {
        id: bundle.id,
        createdAt: bundle.created_at,
        configHash: bundle.config_hash,
        codeHash: bundle.code_hash,
        gitCommit: bundle.git_commit,
        gitDirty: bundle.git_dirty,
        anchorTs: bundle.params.anchorTs,
        dataOk: check.dataOk,
        dataDiffs: check.diffs,
        configSame: check.configSame,
        codeSame: check.codeSame,
      },
      curve,
    }
    devCache = { key, value }
    return value
  })()
  try {
    return await devRunning
  } finally {
    devRunning = null
  }
}

// ---------- 3. 自动暂停条件：每个都触发过并被正确处理 ----------
async function pausePart() {
  const { rows } = await dbQuery(
    `SELECT id, ts::float8 AS ts, type, message, detail FROM events
     WHERE type IN ('auto_pause','auto_resume') OR (type='control' AND message LIKE '人工恢复%')
     ORDER BY ts`,
  )
  const ev = rows.map((r) => ({ ...r, ts: Number(r.ts) }))
  return Object.entries(paper.PAUSE).map(([key, def]) => {
    const triggers = ev.filter((e) => e.type === 'auto_pause' && e.detail?.key === key)
    const list = triggers.map((t) => {
      const fix = ev.find(
        (e) => e.ts >= t.ts && e.id !== t.id && (def.auto ? e.type === 'auto_resume' && e.detail?.key === key : e.type === 'control'),
      )
      return { ts: t.ts, drill: !!t.detail?.drill, handled: !!fix, handledAt: fix?.ts ?? null, handledBy: fix ? (fix.type === 'control' ? '人工恢复' : '自动恢复') : null, minutes: fix ? r2((fix.ts - t.ts) / 60_000, 1) : null }
    })
    const handled = list.filter((x) => x.handled)
    return {
      key,
      label: def.label,
      auto: def.auto,
      recovery: def.auto ? `连续 ${cfg.paper.autoResumeHealthyChecks} 次检查正常后自动恢复` : '人工点「恢复运行」',
      triggers: list.length,
      realTriggers: list.filter((x) => !x.drill).length,
      handled: handled.length,
      last: list[list.length - 1] ?? null,
      pass: handled.length > 0,
      pending: list.length > 0 && !list[list.length - 1].handled,
    }
  })
}

// ---------- 4. 连续运行 & 异常 ----------
async function runPart(snap) {
  const t = Date.now()
  const gapLimit = cfg.paper.heartbeatEveryMs * cfg.paper.heartbeatMissing
  const { rows } = await dbQuery(
    `SELECT ts::float8 AS ts, (detail->>'gapMs')::float8 AS gap FROM events WHERE type='system' AND message LIKE '系统启动%' AND ts >= $1 ORDER BY ts`,
    [snap.startedAt ?? 0],
  )
  const outages = rows.filter((r) => Number(r.gap) > gapLimit).map((r) => ({ ts: Number(r.ts), minutes: Math.round(Number(r.gap) / 60_000) }))
  const since = Math.max(snap.startedAt ?? t, ...outages.map((o) => o.ts))
  const { rows: unk } = await dbQuery(`SELECT COUNT(*)::int AS c FROM paper_orders WHERE status='UNKNOWN'`)
  const issues = []
  if (snap.state === 'stopped') issues.push('系统处于紧急停止状态')
  if (snap.state === 'locked') issues.push('系统处于回撤锁定状态')
  if (snap.pauseKeys.length) issues.push(`有暂停条件未解除：${snap.pauseKeys.map((k) => paper.PAUSE[k]?.label ?? k).join('、')}`)
  if (unk[0].c) issues.push(`${unk[0].c} 笔订单状态未知`)
  if (snap.reconcile && !snap.reconcile.ok) issues.push('最近一次对账不一致')
  const hbAge = snap.lastHeartbeat ? t - snap.lastHeartbeat : null
  if (hbAge != null && hbAge > gapLimit) issues.push(`心跳已中断 ${Math.round(hbAge / 60_000)} 分钟`)
  return {
    startedAt: snap.startedAt,
    totalDays: snap.startedAt ? r2((t - snap.startedAt) / DAY, 2) : 0,
    continuousDays: r2((t - since) / DAY, 2),
    continuousSince: since,
    outages,
    issues,
  }
}

// ---------- 汇总 ----------
async function evaluate({ runId } = {}) {
  await paper.load()
  const snap = paper.snapshot()
  const A = cfg.acceptance
  const [bt, run, pauses] = await Promise.all([backtestPart(runId), runPart(snap), pausePart()])
  let dev = null
  let devError = null
  try {
    dev = await paperVsBacktest(snap)
  } catch (e) {
    devError = e.message
  }

  const c = bt.checks ?? {}
  const item = (o) => ({ status: o.pass ? 'pass' : o.pending ? 'pending' : 'fail', ...o })
  const groups = [
    {
      key: 'backtest',
      title: '一、回测（滚动样本外验证）',
      hint: bt.run ? `依据回测 #${bt.run.id}，可在下方切换` : '还没有完成的回测，请先去「回测实验室」跑一次',
      items: [
        item({ key: 'oos_sharpe', label: `样本外夏普比率 > ${A.oosSharpe}`, value: c.sharpe?.value ?? '—', target: `> ${A.oosSharpe}`, pass: !!c.sharpe?.pass, pending: !bt.run }),
        item({ key: 'oos_mdd', label: `样本外最大回撤 < ${A.oosMaxDrawdownPct}%`, value: c.mdd?.value ?? '—', target: `< ${A.oosMaxDrawdownPct}%`, pass: !!c.mdd?.pass, pending: !bt.run }),
        item({ key: 'oos_trades', label: `样本外交易笔数 > ${A.oosTrades}`, value: c.trades?.value ?? '—', target: `> ${A.oosTrades}`, pass: !!c.trades?.pass, pending: !bt.run }),
        item({ key: 'coverage', label: '验证期覆盖上涨、下跌、震荡行情', value: c.coverage?.value ?? '—', target: '三种都有', pass: !!c.coverage?.pass, pending: !bt.run }),
        item({ key: 'stable', label: '关键参数 ±20% 扰动后不崩塌', value: c.stable?.value ?? '—', target: '稳定', pass: !!c.stable?.pass, pending: !bt.run }),
      ],
    },
    {
      key: 'paper',
      title: '二、模拟交易',
      hint: '模拟盘需要真实时间积累，30 天无法压缩',
      items: [
        item({
          key: 'paper_days',
          label: `模拟交易连续运行 ≥ ${A.paperDays} 天`,
          value: `${run.continuousDays} 天`,
          target: `≥ ${A.paperDays} 天`,
          progress: Math.min(1, run.continuousDays / A.paperDays),
          note: run.outages.length ? `期间中断 ${run.outages.length} 次，从最近一次中断后重新计算` : '没有中断（心跳连续缺失 15 分钟以上才算中断）',
          pass: run.continuousDays >= A.paperDays,
          pending: run.continuousDays < A.paperDays,
        }),
        item({
          key: 'no_issues',
          label: '无未处理异常',
          value: run.issues.length ? run.issues.join('；') : '无',
          target: '无',
          pass: run.issues.length === 0,
        }),
        item({
          key: 'paper_dev',
          label: `模拟净值与同期回测偏差 < ${A.paperVsBacktestDevPct}%`,
          value: dev ? `${dev.devPct}%` : '—',
          target: `< ${A.paperVsBacktestDevPct}%`,
          note: dev
            ? `模拟 ${dev.paperReturnPct >= 0 ? '+' : ''}${dev.paperReturnPct}%（${dev.paperTrades} 笔） vs 同期回测 ${dev.backtestReturnPct >= 0 ? '+' : ''}${dev.backtestReturnPct}%（${dev.backtestTrades} 笔）。按复现包 #${dev.repro?.id ?? "—"}（配置 ${dev.repro?.configHash?.slice(0, 8) ?? "—"}，commit ${dev.repro?.gitCommit?.slice(0, 8) ?? "—"}）重跑${dev.repro && !dev.repro.dataOk ? "；⚠ 启动前历史数据与复现包记录不一致" : ""}${dev.repro && !dev.repro.configSame ? "；当前配置已与启动时不同，回测仍按启动时配置" : ""}。须运行满 ${A.paperDays} 天才计入验收。`
            : devError ?? '计算中',
          pass: !!dev && dev.devPct < A.paperVsBacktestDevPct && run.continuousDays >= A.paperDays,
          pending: !!dev && run.continuousDays < A.paperDays,
        }),
      ],
    },
    {
      key: 'pause',
      title: '三、自动暂停条件（每个都要触发过一次并被正确处理）',
      hint: '真实触发或「故障演练」都算；演练会让系统暂停开新仓几分钟，不影响已有持仓的止损',
      items: pauses.map((p) =>
        item({
          key: `pause_${p.key}`,
          label: p.label,
          value: p.triggers ? `触发 ${p.triggers} 次（真实 ${p.realTriggers}），已处理 ${p.handled} 次` : '还没触发过',
          target: p.recovery,
          pauseKey: p.key,
          auto: p.auto,
          last: p.last,
          pass: p.pass,
          pending: p.pending,
        }),
      ),
    },
    {
      key: 'live',
      title: '四、实盘前置',
      items: [
        item({
          key: 'live_cap',
          label: `实盘首期资金不超过总资金的 ${cfg.live.maxInitialCapitalPct}%`,
          value: `已写入配置：上限 ${cfg.live.maxInitialCapitalPct}%`,
          target: '≤ 5%',
          pass: cfg.live.maxInitialCapitalPct <= 5,
        }),
      ],
    },
  ]
  const all = groups.flatMap((g) => g.items)
  const passCount = all.filter((i) => i.status === 'pass').length
  return {
    mode: cfg.mode,
    allPassed: passCount === all.length,
    passCount,
    total: all.length,
    liveUnlocked: false, // 本阶段始终不开放实盘；全部通过后再单独讨论
    groups,
    backtest: { runs: bt.runs.map((r) => ({ id: r.id, createdAt: r.createdAt, oosSharpe: r.summary?.oosSharpe ?? null, passCount: r.summary?.passCount ?? null, checkCount: r.summary?.checkCount ?? null, symbols: r.summary?.symbols ?? [], strategies: r.summary?.strategies ?? [] })), chosen: bt.run?.id ?? null, warnings: bt.warnings ?? [] },
    deviation: dev,
    run,
    serverTime: Date.now(),
  }
}

module.exports = { evaluate }
