import ReactECharts from 'echarts-for-react'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, XCircle, Play, Loader2, FlaskConical, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtDate, fmtTime, coin, STRATEGY_NAME } from '@/lib/market'
import { type RunRow, type LabResult, type Metrics, type Point, type Group, REGIME_NAME } from '@/lib/backtest'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'
const UP = '#10b981'
const DOWN = '#ef4444'
const fgSubtle = '#aaaaaa'
const split = 'rgba(255,255,255,0.12)'
const tip = {
  backgroundColor: '#171717',
  borderColor: 'rgba(255,255,255,0.12)',
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: '#e7e7e7', fontSize: 12 },
  extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);',
}
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`)
const usd = (v: number | null | undefined) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const tone = (v: number | null | undefined) => (v == null ? 'text-fg-base' : v > 0 ? 'text-[#10b981]' : v < 0 ? 'text-[#ef4444]' : 'text-fg-base')

const ALL_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT']

export default function BacktestPage() {
  const qc = useQueryClient()
  const [strategies, setStrategies] = useState<string[]>(['breakout'])
  const [symbols, setSymbols] = useState<string[]>(ALL_SYMBOLS)
  const [regimeFilter, setRegimeFilter] = useState(true)
  const [ddLock, setDdLock] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)

  const runs = useQuery<RunRow[]>({
    queryKey: ['bt-runs'],
    queryFn: () => fetch(api('backtest/runs')).then((r) => r.json()),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3000 : false),
  })
  const list = useMemo(() => (Array.isArray(runs.data) ? runs.data : []), [runs.data])
  const running = list.find((r) => r.status === 'running')
  const activeId = selected ?? list.find((r) => r.status === 'done')?.id ?? null

  const detail = useQuery<RunRow>({
    queryKey: ['bt-run', activeId],
    enabled: activeId != null,
    queryFn: () => fetch(api(`backtest/runs/${activeId}`)).then((r) => r.json()),
    staleTime: Infinity,
  })

  const start = useMutation({
    mutationFn: () =>
      fetch(api('backtest/run'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategies, symbols, regimeFilter, ddLock }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setSelected(null)
      qc.invalidateQueries({ queryKey: ['bt-runs'] })
    },
  })

  // 跑完后自动切到最新结果
  const [wasRunning, setWasRunning] = useState(false)
  useEffect(() => {
    if (running) setWasRunning(true)
    else if (wasRunning) {
      setWasRunning(false)
      setSelected(null)
    }
  }, [running, wasRunning])

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? (arr.length > 1 ? arr.filter((x) => x !== v) : arr) : [...arr, v])

  const r = detail.data?.status === 'done' ? detail.data.result : undefined

  return (
    <div className="space-y-4">
      {/* 控制区 */}
      <div className={card}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-black flex items-center gap-2"><FlaskConical size={18} /> 回测实验室</h2>
            <p className="text-sm text-fg-subtle mt-1">
              回答一个问题：<b className="text-fg-base">如果过去两年一直按这套规则自动交易，会怎么样？</b>
              用 1 万 USDT 模拟资金，计入手续费、滑点和资金费率，信号只用当时已经能看到的数据，下一根 K 线才成交。
            </p>
            <p className="text-[11px] text-fg-muted mt-1">纯本地计算，不消耗 Surf 点数。每次约 10~20 秒。</p>
          </div>
          <div className="flex flex-col gap-2 min-w-[300px]">
            <Row label="策略">
              {[
                ['breakout', '趋势突破'],
                ['trend_following', '趋势跟随（旧）'],
                ['mean_reversion', '均值回归（旧）'],
              ].map(([k, l]) => (
                <Chip key={k} on={strategies.includes(k)} onClick={() => toggle(strategies, k, setStrategies)}>{l}</Chip>
              ))}
            </Row>
            <Row label="币种">
              {ALL_SYMBOLS.map((s) => (
                <Chip key={s} on={symbols.includes(s)} onClick={() => toggle(symbols, s, setSymbols)}>{coin(s)}</Chip>
              ))}
            </Row>
            <Row label="市场状态过滤">
              <Chip on={regimeFilter} onClick={() => setRegimeFilter(true)}>开（只在合适的状态下交易）</Chip>
              <Chip on={!regimeFilter} onClick={() => setRegimeFilter(false)}>关（对照组）</Chip>
            </Row>
            <Row label="10% 回撤锁定">
              <Chip on={ddLock} onClick={() => setDdLock(true)}>模拟</Chip>
              <Chip on={!ddLock} onClick={() => setDdLock(false)}>不模拟（看策略全貌）</Chip>
            </Row>
            <button
              onClick={() => start.mutate()}
              disabled={!!running || start.isPending}
              className="mt-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-brand-100 text-white font-semibold disabled:opacity-60"
            >
              {running || start.isPending ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {running ? `回测 #${running.id} 计算中…` : '开始回测'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          {!activeId && !running && <div className={`${card} text-sm text-fg-subtle`}>还没有回测记录，点「开始回测」跑第一次。</div>}
          {detail.isLoading && <div className="h-[400px] rounded-lg bg-bg-subtle animate-pulse" />}
          {detail.data?.status === 'error' && <div className={`${card} text-[#ef4444] text-sm`}>回测失败：{detail.data.error}</div>}
          {r && detail.data && <Report run={detail.data} r={r} />}
        </div>
        <History list={list} activeId={activeId} onSelect={setSelected} />
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-fg-muted w-24 shrink-0">{label}</span>
      {children}
    </div>
  )
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-xs border ${on ? 'border-brand-100 bg-brand-10 text-fg-base' : 'border-border-strong text-fg-subtle hover:text-fg-base'}`}
    >
      {children}
    </button>
  )
}

function History({ list, activeId, onSelect }: { list: RunRow[]; activeId: number | null; onSelect: (id: number) => void }) {
  return (
    <div className={card}>
      <h3 className="font-bold text-sm">历史回测</h3>
      <div className="mt-2 space-y-1.5 max-h-[600px] overflow-auto">
        {list.length === 0 && <div className="text-xs text-fg-muted">暂无</div>}
        {list.map((x) => {
          const s = x.summary
          return (
            <button
              key={x.id}
              onClick={() => x.status === 'done' && onSelect(x.id)}
              className={`w-full text-left rounded-md p-2 border ${x.id === activeId ? 'border-brand-100 bg-brand-10' : 'border-border-base hover:bg-bg-subtle'}`}
            >
              <div className="flex justify-between text-xs">
                <span className="font-semibold">#{x.id}</span>
                <span className="text-fg-muted">{fmtTime(new Date(x.created_at).getTime())}</span>
              </div>
              {x.status === 'running' && <div className="text-xs text-fg-subtle mt-0.5">计算中…</div>}
              {x.status === 'error' && <div className="text-xs text-[#ef4444] mt-0.5">失败</div>}
              {s && (
                <>
                  <div className="text-[11px] text-fg-subtle mt-0.5">
                    {s.strategies.map((k) => STRATEGY_NAME[k] ?? k).join('+')} · {s.symbols.map(coin).join('/')} · 过滤{s.regimeFilter ? '开' : '关'}
                  </div>
                  <div className="flex justify-between text-xs mt-0.5">
                    <span className={tone(s.totalReturnPct)}>{pct(s.totalReturnPct)}</span>
                    <span className={s.passed ? 'text-[#10b981]' : 'text-fg-muted'}>验收 {s.passCount}/{s.checkCount}</span>
                  </div>
                </>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Report({ run, r }: { run: RunRow; r: LabResult }) {
  const s = run.summary!
  const m = r.main.metrics
  const wf = r.walkforward
  return (
    <>
      <Verdict r={r} />

      <div className={card}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-bold">全周期回测结果（默认参数）</h3>
          <span className="text-xs text-fg-muted">
            {fmtDate(s.from)} → {fmtDate(s.to)} · {s.symbols.map(coin).join(' + ')} · {s.strategies.map((k) => STRATEGY_NAME[k] ?? k).join(' + ')} · 市场状态过滤{s.regimeFilter ? '开' : '关'}
          </span>
        </div>
        <MetricGrid m={m} bench={r.main.benchmarkReturnPct} />
        {r.main.locked && (
          <div className="mt-3 text-sm text-[#f59e0b]">⚠ {fmtDate(r.main.locked.ts)} 回撤达到 10%，触发风控锁定，之后停止交易。</div>
        )}
        <EquityChart main={r.main.curve} bench={r.main.benchmark} oos={wf?.curve ?? []} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostCard r={r} />
        <BreakdownCard r={r} />
      </div>

      {wf && <WalkForward r={r} />}
      <Sensitivity r={r} />
      <Trades r={r} />
      <Assumptions r={r} />
    </>
  )
}

function Verdict({ r }: { r: LabResult }) {
  const passed = r.checks.length > 0 && r.checks.every((c) => c.pass)
  const n = r.checks.filter((c) => c.pass).length
  return (
    <div className={card} style={{ borderColor: passed ? UP + '66' : DOWN + '55' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs text-fg-muted">对照设计文档的验收标准（以「滚动样本外」结果为准）</div>
          <div className="text-xl font-black mt-0.5" style={{ color: passed ? UP : DOWN }}>
            {passed ? '✅ 全部通过，可以进入模拟交易验证' : `❌ ${n}/${r.checks.length} 项通过 —— 这套策略还不能用`}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2 mt-3">
        {r.checks.map((c) => (
          <div key={c.key} className="rounded-md border border-border-base p-2.5">
            <div className="flex items-center gap-1.5 text-xs">
              {c.pass ? <CheckCircle2 size={14} className="text-[#10b981]" /> : <XCircle size={14} className="text-[#ef4444]" />}
              <span className="text-fg-subtle">{c.label}</span>
            </div>
            <div className="font-mono text-sm mt-1">{String(c.value)}</div>
          </div>
        ))}
      </div>
      {!passed && (
        <p className="text-xs text-fg-subtle mt-3">
          这是正常的：两个「入门策略」本来就只是用来检验整套流程是否正确，文档里也说明它们不代表最终策略。
          回测实验室的价值就在于——<b className="text-fg-base">不赚钱的策略在这里被拦下，而不是在真钱里被发现</b>。
        </p>
      )}
    </div>
  )
}

function MetricGrid({ m, bench }: { m: Metrics; bench: number | null }) {
  const items: [string, string, string, string?][] = [
    ['总收益', pct(m.totalReturnPct), tone(m.totalReturnPct), `同期买入持有：${pct(bench)}`],
    ['年化收益', pct(m.annualReturnPct), tone(m.annualReturnPct)],
    ['夏普比率', m.sharpe.toFixed(2), m.sharpe > 1 ? 'text-[#10b981]' : m.sharpe < 0 ? 'text-[#ef4444]' : 'text-fg-base', '收益相对波动的性价比，> 1 算合格'],
    ['最大回撤', `-${m.maxDrawdownPct.toFixed(1)}%`, m.maxDrawdownPct < 15 ? 'text-fg-base' : 'text-[#ef4444]', '从最高点最多亏了多少'],
    ['交易笔数', String(m.trades), 'text-fg-base'],
    ['胜率', `${m.winRatePct.toFixed(0)}%`, 'text-fg-base'],
    ['盈亏比', m.profitFactor.toFixed(2), m.profitFactor > 1 ? 'text-[#10b981]' : 'text-[#ef4444]', '总盈利 ÷ 总亏损，> 1 才赚钱'],
    ['平均持仓', `${m.avgHoldHours.toFixed(0)} 小时`, 'text-fg-base'],
    ['索提诺比率', m.sortino.toFixed(2), 'text-fg-base', '只算下跌波动的夏普'],
    ['期末资金', usd(m.endEquity), tone(m.endEquity - 10000)],
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3">
      {items.map(([l, v, c, h]) => (
        <div key={l} className="rounded-md bg-bg-subtle/40 p-2.5" title={h}>
          <div className="text-[11px] text-fg-muted">{l}</div>
          <div className={`font-mono text-lg font-bold ${c}`}>{v}</div>
          {h && <div className="text-[10px] text-fg-muted leading-tight">{h}</div>}
        </div>
      ))}
    </div>
  )
}

function EquityChart({ main, bench, oos }: { main: Point[]; bench: Point[]; oos: Point[] }) {
  const labels = main.map((p) => fmtDate(p.ts))
  const oosMap = new Map(oos.map((p) => [p.ts, p.equity]))
  const dd: number[] = []
  let peak = 0
  for (const p of main) {
    peak = Math.max(peak, p.equity)
    dd.push(Math.round(((p.equity - peak) / peak) * 1000) / 10)
  }
  const option = {
    animation: false,
    grid: [
      { left: 64, right: 16, top: 30, height: '58%' },
      { left: 64, right: 16, top: '76%', bottom: 28 },
    ],
    legend: { top: 0, textStyle: { color: fgSubtle, fontSize: 11 }, itemHeight: 3, itemWidth: 14 },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [0, 1].map((i) => ({
      type: 'category',
      data: labels,
      gridIndex: i,
      axisLine: { lineStyle: { color: fgSubtle } },
      axisLabel: { color: fgSubtle, show: i === 1, hideOverlap: true },
      axisTick: { show: false },
    })),
    yAxis: [
      { scale: true, gridIndex: 0, axisLabel: { color: fgSubtle, formatter: (v: number) => `$${(v / 1000).toFixed(1)}k` }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
      { gridIndex: 1, max: 0, splitNumber: 2, axisLabel: { color: fgSubtle, formatter: '{value}%' }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
    ],
    tooltip: { trigger: 'axis', ...tip, valueFormatter: (v: number) => (v == null ? '—' : Math.abs(v) < 100 ? `${v}%` : `$${Math.round(v).toLocaleString()}`) },
    series: [
      { name: '策略（默认参数）', type: 'line', data: main.map((p) => p.equity), symbol: 'none', lineStyle: { width: 1.5, color: '#fd4b96' } },
      { name: '滚动样本外', type: 'line', data: main.map((p) => oosMap.get(p.ts) ?? null), symbol: 'none', lineStyle: { width: 1.5, color: '#6366f1' } },
      { name: '买入持有 BTC/ETH', type: 'line', data: bench.map((p) => p.equity), symbol: 'none', lineStyle: { width: 1.5, color: '#888', type: 'dashed' } },
      { name: '回撤', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: dd, symbol: 'none', lineStyle: { width: 1, color: DOWN }, areaStyle: { color: DOWN, opacity: 0.15 } },
    ],
  }
  return (
    <div className="mt-4">
      <div className="text-xs text-fg-muted mb-1">资金曲线（起始 $10,000）与回撤</div>
      <ReactECharts option={option} style={{ height: 380 }} notMerge />
    </div>
  )
}

function CostCard({ r }: { r: LabResult }) {
  const t = r.main.totals
  const total = t.fees + t.slippage + t.funding
  const rows: [string, number, string][] = [
    ['手续费', t.fees, `每次买卖 ${r.assumptions.costs.takerPct}%`],
    ['滑点', t.slippage, `每次成交比报价差 ${r.assumptions.costs.slippageBps / 100}%`],
    ['资金费率', t.funding, `其中 ${usd(t.fundingAssumed)} 为保守假设（无历史数据时段）`],
  ]
  return (
    <div className={card}>
      <h3 className="font-bold">交易成本</h3>
      <p className="text-xs text-fg-muted mt-1">回测里最容易被忽略、也最伤收益的部分。</p>
      <div className="mt-3 space-y-2">
        {rows.map(([l, v, h]) => (
          <div key={l}>
            <div className="flex justify-between text-sm">
              <span>{l}</span>
              <span className="font-mono">{usd(v)}</span>
            </div>
            <div className="h-1.5 rounded bg-bg-subtle mt-1">
              <div className="h-1.5 rounded bg-[#f59e0b]" style={{ width: `${total ? Math.max(2, (Math.abs(v) / total) * 100) : 0}%` }} />
            </div>
            <div className="text-[11px] text-fg-muted mt-0.5">{h}</div>
          </div>
        ))}
        <div className="flex justify-between text-sm pt-2 border-t border-border-base">
          <span className="font-semibold">合计</span>
          <span className="font-mono font-semibold">{usd(total)} <span className="text-fg-muted text-xs">（占本金 {((total / r.assumptions.startEquity) * 100).toFixed(1)}%）</span></span>
        </div>
        {r.main.dailyLossDays > 0 && <div className="text-xs text-fg-subtle">「单日亏损 2% 停止开仓」规则共触发 {r.main.dailyLossDays} 天。</div>}
      </div>
    </div>
  )
}

function GroupTable({ title, rows, name }: { title: string; rows: Group[]; name: (k: string) => string }) {
  return (
    <div>
      <div className="text-xs text-fg-muted mb-1">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className="border-t border-border-base">
              <td className="py-1">{name(g.key)}</td>
              <td className="py-1 text-right text-fg-subtle">{g.trades} 笔</td>
              <td className="py-1 text-right text-fg-subtle">胜率 {g.winRatePct.toFixed(0)}%</td>
              <td className={`py-1 text-right font-mono ${tone(g.pnl)}`}>{usd(g.pnl)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="py-1 text-fg-muted text-xs">无交易</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function BreakdownCard({ r }: { r: LabResult }) {
  return (
    <div className={card}>
      <h3 className="font-bold">钱是在哪里赚的 / 亏的？</h3>
      <div className="mt-3 space-y-3">
        <GroupTable title="按策略" rows={r.main.byStrategy} name={(k) => STRATEGY_NAME[k] ?? k} />
        <GroupTable title="按开仓时的市场状态" rows={r.main.byRegime} name={(k) => REGIME_NAME[k] ?? k} />
        <GroupTable title="按币种" rows={r.main.bySymbol} name={coin} />
        <div>
          <div className="text-xs text-fg-muted mb-1">两年里各市场状态的时间占比</div>
          <div className="flex h-3 rounded overflow-hidden">
            {r.main.regimeShare.map((x) => (
              <div key={x.regime} title={`${REGIME_NAME[x.regime]} ${x.pct}%`} style={{ width: `${x.pct}%`, background: REGIME_COLOR[x.regime] }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
            {r.main.regimeShare.map((x) => (
              <span key={x.regime} className="text-[11px] text-fg-subtle">
                <span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: REGIME_COLOR[x.regime] }} />
                {REGIME_NAME[x.regime]} {x.pct}%
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
const REGIME_COLOR: Record<string, string> = {
  trend_up: '#10b981',
  trend_down: '#ef4444',
  range: '#6366f1',
  high_vol: '#f59e0b',
  low_liquidity: '#06b6d4',
  unclear: '#666',
}

function paramText(p: Record<string, Record<string, number>>) {
  return Object.entries(p)
    .map(([k, v]) =>
      k === 'breakout'
        ? `突破 ${v.lookback}h ${v.atrMult}×ATR`
        : k === 'trend_following'
          ? `趋势 ${v.fast}/${v.slow}均线 ${v.atrMult}×ATR`
          : `回归 ${v.bbMult}σ RSI${v.rsiLow} ${v.atrMult}×ATR`,
    )
    .join('；')
}

function WalkForward({ r }: { r: LabResult }) {
  const wf = r.walkforward!
  const a = r.assumptions.walkforward
  return (
    <div className={card}>
      <h3 className="font-bold">滚动样本外验证</h3>
      <p className="text-xs text-fg-subtle mt-1 max-w-3xl">
        防止「事后挑参数」的考试：每次只用过去 {a.trainDays} 天的数据挑出最好的参数（训练期），然后在之后 {a.testDays} 天它从没见过的行情里检验（测试期），再整体往后挪 {a.stepDays} 天重复。
        <b className="text-fg-base">测试期的成绩才算数。</b>如果训练期很好看、测试期很差，说明是「过拟合」——只是碰巧拟合了历史。
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
        <Mini label="样本外总收益" value={pct(wf.metrics.totalReturnPct)} c={tone(wf.metrics.totalReturnPct)} />
        <Mini label="样本外夏普" value={wf.metrics.sharpe.toFixed(2)} c={tone(wf.metrics.sharpe)} />
        <Mini label="训练期平均夏普" value={wf.avgInSampleSharpe.toFixed(2)} c="text-fg-base" />
        <Mini label="样本外最大回撤" value={`-${wf.metrics.maxDrawdownPct.toFixed(1)}%`} c="text-fg-base" />
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="py-1 pr-2 font-normal">#</th>
              <th className="py-1 pr-2 font-normal">测试期</th>
              <th className="py-1 pr-2 font-normal">BTC 行情</th>
              <th className="py-1 pr-2 font-normal">训练期选出的参数</th>
              <th className="py-1 pr-2 font-normal text-right">训练期夏普</th>
              <th className="py-1 pr-2 font-normal text-right">测试期夏普</th>
              <th className="py-1 pr-2 font-normal text-right">测试期收益</th>
              <th className="py-1 font-normal text-right">交易</th>
            </tr>
          </thead>
          <tbody>
            {wf.folds.map((f, k) => (
              <tr key={k} className="border-t border-border-base">
                <td className="py-1 pr-2 text-fg-muted">{k + 1}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(f.trainEnd)} ~ {fmtDate(f.testEnd)}</td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {f.market.label} <span className="text-fg-muted">{pct(f.market.changePct, 0)}</span>
                </td>
                <td className="py-1 pr-2 text-fg-subtle">{paramText(f.params)}</td>
                <td className={`py-1 pr-2 text-right font-mono ${tone(f.inSample.sharpe)}`}>{f.inSample.sharpe.toFixed(2)}</td>
                <td className={`py-1 pr-2 text-right font-mono ${tone(f.outOfSample.sharpe)}`}>{f.outOfSample.sharpe.toFixed(2)}</td>
                <td className={`py-1 pr-2 text-right font-mono ${tone(f.outOfSample.totalReturnPct)}`}>{pct(f.outOfSample.totalReturnPct)}</td>
                <td className="py-1 text-right text-fg-subtle">{f.outOfSample.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
function Mini({ label, value, c }: { label: string; value: string; c: string }) {
  return (
    <div className="rounded-md bg-bg-subtle/40 p-2.5">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className={`font-mono text-lg font-bold ${c}`}>{value}</div>
    </div>
  )
}

function Sensitivity({ r }: { r: LabResult }) {
  const s = r.sensitivity
  return (
    <div className={card}>
      <h3 className="font-bold">参数敏感性（±20% 扰动）</h3>
      <p className="text-xs text-fg-subtle mt-1">
        把每个参数调大或调小 20%，看结果会不会「一碰就碎」。好的策略换个相近的参数也应该差不多。基准夏普：
        <span className={`font-mono ${tone(s.baseSharpe)}`}> {s.baseSharpe.toFixed(2)}</span>
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="py-1 pr-2 font-normal">策略</th>
              <th className="py-1 pr-2 font-normal">参数</th>
              <th className="py-1 pr-2 font-normal">调整</th>
              <th className="py-1 pr-2 font-normal text-right">夏普</th>
              <th className="py-1 pr-2 font-normal text-right">总收益</th>
              <th className="py-1 pr-2 font-normal text-right">最大回撤</th>
              <th className="py-1 font-normal text-right">交易</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((x, k) => (
              <tr key={k} className="border-t border-border-base">
                <td className="py-1 pr-2">{STRATEGY_NAME[x.strategy] ?? x.strategy}</td>
                <td className="py-1 pr-2 text-fg-subtle">{x.label}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{x.factor < 1 ? '-20%' : '+20%'} → {x.value}</td>
                <td className={`py-1 pr-2 text-right font-mono ${tone(x.sharpe)}`}>{x.sharpe.toFixed(2)}</td>
                <td className={`py-1 pr-2 text-right font-mono ${tone(x.totalReturnPct)}`}>{pct(x.totalReturnPct)}</td>
                <td className="py-1 pr-2 text-right font-mono">-{x.maxDrawdownPct.toFixed(1)}%</td>
                <td className="py-1 text-right text-fg-subtle">{x.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Trades({ r }: { r: LabResult }) {
  const [n, setN] = useState(30)
  const list = [...r.main.trades].reverse()
  return (
    <div className={card}>
      <div className="flex justify-between items-baseline">
        <h3 className="font-bold">交易明细</h3>
        <span className="text-xs text-fg-muted">共 {r.main.tradeCount} 笔{r.main.tradeCount > list.length ? `，显示最近 ${list.length} 笔` : ''}</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-muted">
              <th className="py-1 pr-2 font-normal">开仓</th>
              <th className="py-1 pr-2 font-normal">币种</th>
              <th className="py-1 pr-2 font-normal">方向</th>
              <th className="py-1 pr-2 font-normal">策略 / 状态</th>
              <th className="py-1 pr-2 font-normal text-right">开仓价</th>
              <th className="py-1 pr-2 font-normal text-right">平仓价</th>
              <th className="py-1 pr-2 font-normal">平仓原因</th>
              <th className="py-1 pr-2 font-normal text-right">成本</th>
              <th className="py-1 font-normal text-right">净盈亏</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, n).map((t, k) => (
              <tr key={k} className="border-t border-border-base">
                <td className="py-1 pr-2 whitespace-nowrap text-fg-subtle">{fmtTime(t.entryTs)}</td>
                <td className="py-1 pr-2">{coin(t.symbol)}</td>
                <td className={`py-1 pr-2 ${t.side === 'long' ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{t.side === 'long' ? '做多' : '做空'}</td>
                <td className="py-1 pr-2 text-fg-subtle whitespace-nowrap">{STRATEGY_NAME[t.strategy]} · {REGIME_NAME[t.regime] ?? t.regime}</td>
                <td className="py-1 pr-2 text-right font-mono">{t.entryPx.toLocaleString()}</td>
                <td className="py-1 pr-2 text-right font-mono">{t.exitPx.toLocaleString()}</td>
                <td className="py-1 pr-2 text-fg-subtle">{t.reason}</td>
                <td className="py-1 pr-2 text-right font-mono text-fg-subtle">{usd(t.fees + t.slippage + t.funding)}</td>
                <td className={`py-1 text-right font-mono ${tone(t.pnl)}`}>{usd(t.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {n < list.length && (
        <button onClick={() => setN(n + 50)} className="mt-2 text-xs text-fg-subtle hover:text-fg-base">显示更多</button>
      )}
    </div>
  )
}

function Assumptions({ r }: { r: LabResult }) {
  const a = r.assumptions
  return (
    <div className={`${card} text-xs text-fg-subtle`}>
      <h3 className="font-bold text-sm text-fg-base flex items-center gap-1.5"><Info size={14} /> 回测假设</h3>
      <ul className="mt-2 space-y-1 list-disc pl-4">
        <li>起始资金 ${a.startEquity.toLocaleString()}；每笔最多亏账户的 {a.risk.riskPerTradePct}%（按止损距离自动算仓位）；单币种仓位 ≤ {a.risk.maxSymbolExposurePct}%，总仓位 ≤ {a.risk.maxGrossExposurePct}%。</li>
        <li>单日亏损 ≥ {a.risk.dailyLossLimitPct}% 当天停止开新仓；回撤 {a.risk.maxDrawdownPct}% 锁定（可选模拟）。</li>
        <li>信号在 1 小时 K 线收盘后产生，下一根 K 线开盘价成交；止损在之后的 K 线内按最高/最低价触发，跳空时按开盘价。</li>
        <li>手续费 {a.costs.takerPct}%/次，滑点 {a.costs.slippageBps / 100}%/次。资金费率：{a.fundingHistoryFrom ? `${fmtDate(a.fundingHistoryFrom)} 起使用 OKX 真实历史` : '暂无历史'}；更早的时段保守假设每 8 小时付 {a.costs.assumedFundingPct8h}%（多空都算成本）。</li>
        <li>前 {a.walkforward.warmupDays} 天只用于计算指标，不计入结果。数据来源：OKX 永续合约 1 小时 / 4 小时 K 线。</li>
      </ul>
    </div>
  )
}
