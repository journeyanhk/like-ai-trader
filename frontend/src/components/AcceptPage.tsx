import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactECharts from 'echarts-for-react'
import { CheckCircle2, XCircle, Clock, Lock, ShieldAlert, Siren, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime } from '@/lib/market'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'
const fgSubtle = '#aaaaaa'
const split = 'rgba(255,255,255,0.12)'

interface Item {
  key: string
  label: string
  status: 'pass' | 'fail' | 'pending'
  value: string | number
  target: string
  note?: string
  progress?: number
  pauseKey?: string
  auto?: boolean
  last?: { ts: number; drill: boolean; handled: boolean; handledBy: string | null; minutes: number | null } | null
}
interface Group { key: string; title: string; hint?: string; items: Item[] }
interface Accept {
  mode: string
  allPassed: boolean
  passCount: number
  total: number
  groups: Group[]
  backtest: { runs: { id: number; createdAt: number | null; oosSharpe: number | null; passCount: number | null; checkCount: number | null; symbols: string[] }[]; chosen: number | null; warnings: string[] }
  deviation: { from: number; strategies: string[]; paperReturnPct: number; backtestReturnPct: number; devPct: number; formula: string; curve: { ts: number; paper: number | null; backtest: number | null }[] } | null
  run: { startedAt: number | null; totalDays: number; continuousDays: number; outages: { ts: number; minutes: number }[] }
}

const ICON = {
  pass: <CheckCircle2 size={18} className="text-[#10b981] shrink-0" />,
  fail: <XCircle size={18} className="text-[#ef4444] shrink-0" />,
  pending: <Clock size={18} className="text-[#f59e0b] shrink-0" />,
}
const STATUS_TEXT = { pass: '通过', fail: '未通过', pending: '进行中' }

export default function AcceptPage() {
  const qc = useQueryClient()
  const [run, setRun] = useState<number | null>(null)
  const q = useQuery<Accept>({
    queryKey: ['accept', run],
    queryFn: async () => {
      const r = await fetch(api(`accept${run ? `?run=${run}` : ''}`))
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? '加载失败')
      return r.json()
    },
    refetchInterval: 30_000,
  })
  const drill = useMutation({
    mutationFn: async (key: string) => {
      const r = await fetch(api('accept/drill'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error ?? '演练失败')
      return j
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['accept'] })
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('paper') })
    },
  })

  if (q.isLoading) return <div className={card}>正在统计（首次需要跑一次同期回测，约 10 秒）…</div>
  if (!q.data) return <div className={card}>{(q.error as Error)?.message ?? '加载失败'}</div>
  const d = q.data
  const pct = Math.round((d.passCount / d.total) * 100)

  return (
    <div className="space-y-4">
      <div className={`${card} flex flex-wrap items-center gap-5`}>
        <div className="relative w-20 h-20">
          <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={d.allPassed ? '#10b981' : '#f59e0b'} strokeWidth="3" strokeDasharray={`${(pct / 100) * 97.4} 97.4`} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-lg font-black">
              {d.passCount}/{d.total}
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-[240px]">
          <h2 className="text-lg font-black">{d.allPassed ? '全部验收通过' : `验收进度：${d.passCount} / ${d.total} 项通过`}</h2>
          <p className="text-sm text-fg-subtle mt-1">
            这些标准来自设计文档，系统每 30 秒自动统计、自动打勾。<b className="text-fg-base">全部通过之前，系统不提供真钱模式。</b>
          </p>
        </div>
        <div className="rounded-lg border border-border-strong px-4 py-3 flex items-center gap-3">
          <Lock size={20} className="text-fg-muted" />
          <div>
            <div className="text-sm font-semibold">实盘模式：已锁定</div>
            <div className="text-[11px] text-fg-muted">
              当前：模拟（PAPER）· {d.allPassed ? '验收已全部通过，可以和开发者讨论小额实盘' : `还差 ${d.total - d.passCount} 项`}
            </div>
          </div>
          <button disabled className="ml-2 px-3 py-1.5 rounded-md border border-border-strong text-xs text-fg-disabled cursor-not-allowed">
            切换实盘
          </button>
        </div>
      </div>

      {d.groups.map((g) => (
        <div key={g.key} className={card}>
          <div className="mb-3">
            <h3 className="font-bold">{g.title}</h3>
            {g.hint && <p className="text-[11px] text-fg-muted mt-0.5">{g.hint}</p>}
          </div>

          {g.key === 'backtest' && d.backtest.runs.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-fg-muted">依据的回测：</span>
              <select
                value={d.backtest.chosen ?? ''}
                onChange={(e) => setRun(Number(e.target.value))}
                className="bg-bg-chat border border-border-strong rounded-md px-2 py-1"
              >
                {d.backtest.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} · {r.symbols.map((s) => s.split('/')[0]).join('+')} · 样本外夏普 {r.oosSharpe ?? '—'} · 通过 {r.passCount ?? 0}/{r.checkCount ?? 0}
                    {r.createdAt ? ` · ${fmtTime(r.createdAt)}` : ''}
                  </option>
                ))}
              </select>
              {d.backtest.warnings.map((w) => (
                <span key={w} className="text-[#f59e0b] flex items-center gap-1">
                  <Info size={12} />
                  {w}
                </span>
              ))}
            </div>
          )}

          <div className="divide-y divide-border-base">
            {g.items.map((it) => (
              <Row key={it.key} it={it}>
                {it.pauseKey && (
                  <button
                    onClick={() => drill.mutate(it.pauseKey!)}
                    disabled={drill.isPending}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border-strong text-xs text-fg-subtle hover:text-fg-base disabled:opacity-50 whitespace-nowrap"
                    title="人为触发这个暂停条件，检验系统能否正确暂停并恢复"
                  >
                    <Siren size={12} /> 故障演练
                  </button>
                )}
              </Row>
            ))}
          </div>

          {g.key === 'pause' && (
            <div className="mt-3 text-[11px] text-fg-muted space-y-0.5">
              {drill.isError && <div className="text-[#ef4444] text-xs">{(drill.error as Error).message}</div>}
              {drill.isSuccess && (
                <div className="text-[#10b981] text-xs">
                  {drill.data.auto
                    ? '演练已触发：系统已暂停开新仓。约 5 分钟后连续 5 次检查正常，会自动恢复并在这里打勾。'
                    : '演练已触发：系统已暂停开新仓。请到「模拟交易 · 风控」页点「恢复运行」完成人工处理，之后这里会打勾。'}
                </div>
              )}
              <div>演练规则：一次只演练一个条件；只能在每小时第 8–50 分钟进行（避开整点交易）；演练期间只暂停开新仓，已有持仓的止损照常执行。</div>
            </div>
          )}

          {g.key === 'paper' && d.deviation && <DevChart dev={d.deviation} />}
        </div>
      ))}

      <div className={`${card} text-xs text-fg-subtle flex gap-2`}>
        <ShieldAlert size={14} className="shrink-0 mt-0.5 text-fg-muted" />
        <div>
          通过验收只代表「可以开始讨论」实盘，不代表一定会赚钱。即使全部通过，实盘也会从不超过总资金 5% 的小额开始，并先接交易所测试网。目前系统只有模拟模式，代码里没有任何真实下单的功能。
        </div>
      </div>
    </div>
  )
}

function Row({ it, children }: { it: Item; children?: ReactNode }) {
  return (
    <div className="py-2.5 flex flex-wrap items-center gap-3">
      {ICON[it.status]}
      <div className="flex-1 min-w-[220px]">
        <div className="text-sm font-semibold">{it.label}</div>
        {it.note && <div className="text-[11px] text-fg-muted mt-0.5">{it.note}</div>}
        {it.last && (
          <div className="text-[11px] text-fg-muted mt-0.5">
            最近一次：{fmtTime(it.last.ts)}
            {it.last.drill ? '（演练）' : '（真实）'} ·{' '}
            {it.last.handled ? `${it.last.handledBy}，用时 ${it.last.minutes} 分钟` : <span className="text-[#f59e0b]">等待处理{it.auto ? '（约 5 分钟后自动恢复）' : '（请到模拟交易页点「恢复运行」）'}</span>}
          </div>
        )}
        {it.progress != null && (
          <div className="h-1.5 rounded bg-bg-chat mt-1.5 overflow-hidden max-w-sm">
            <div className="h-full bg-brand-100" style={{ width: `${Math.max(1, it.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="text-right min-w-[140px]">
        <div className="text-sm font-mono">{String(it.value)}</div>
        <div className="text-[11px] text-fg-muted">要求：{it.target}</div>
      </div>
      <span
        className={`text-[11px] px-2 py-0.5 rounded-full w-14 text-center ${
          it.status === 'pass' ? 'bg-[#10b981]/15 text-[#10b981]' : it.status === 'pending' ? 'bg-[#f59e0b]/15 text-[#f59e0b]' : 'bg-[#ef4444]/15 text-[#ef4444]'
        }`}
      >
        {STATUS_TEXT[it.status]}
      </span>
      {children}
    </div>
  )
}

function DevChart({ dev }: { dev: NonNullable<Accept['deviation']> }) {
  if (dev.curve.length < 2) return null
  const option = {
    animation: false,
    grid: { left: 70, right: 16, top: 30, bottom: 26 },
    legend: { top: 0, textStyle: { color: fgSubtle } },
    xAxis: { type: 'category', data: dev.curve.map((p) => fmtTime(p.ts)), boundaryGap: false, axisLabel: { color: fgSubtle, hideOverlap: true }, axisLine: { lineStyle: { color: fgSubtle } } },
    yAxis: { scale: true, axisLabel: { color: fgSubtle }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
    tooltip: { trigger: 'axis', backgroundColor: '#171717', borderColor: split, textStyle: { color: '#e7e7e7', fontSize: 12 } },
    series: [
      { name: '模拟盘', type: 'line', data: dev.curve.map((p) => p.paper), symbol: 'none', lineStyle: { width: 1.8, color: '#fd4b96' } },
      { name: '同期回测', type: 'line', data: dev.curve.map((p) => p.backtest), symbol: 'none', lineStyle: { width: 1.5, color: '#3b82f6', type: 'dashed' } },
    ],
  }
  return (
    <div className="mt-3">
      <div className="text-xs text-fg-muted mb-1">
        模拟盘 vs 同期回测（相同策略：{dev.strategies.join('、')}；相同风控与成本）。偏差 = {dev.formula}
      </div>
      <ReactECharts option={option} style={{ height: 220 }} notMerge />
    </div>
  )
}
