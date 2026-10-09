import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { OctagonX, Play, Unlock, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info, Clock, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { type EventItem, REGIME_STYLE, coin, fmtPrice, fmtPct, fmtTime } from '@/lib/market'
import { type PaperStatus, type Cycle, type PaperOrder, type PaperTrade, type Decision, STATE_STYLE } from '@/lib/paper'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'
const usd = (v: number | null | undefined, d = 2) =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${usd(v, d)}`
const tone = (v: number) => (v > 0 ? 'text-[#10b981]' : v < 0 ? 'text-[#ef4444]' : 'text-fg-base')
const PAPER_EVENT_TYPES = 'order,trade,risk,auto_pause,auto_resume,control,system'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(api(path))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error ?? '加载失败')
  return j as T
}
async function post(path: string, body?: unknown) {
  const r = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j?.ok === false) throw new Error(j?.error ?? '操作失败')
  return j
}

export default function PaperPage() {
  const qc = useQueryClient()
  const status = useQuery<PaperStatus>({ queryKey: ['paper-status'], queryFn: () => getJson('paper/status'), refetchInterval: 10_000 })
  const cycles = useQuery<Cycle[]>({ queryKey: ['paper-cycles'], queryFn: () => getJson('paper/cycles?limit=6'), refetchInterval: 60_000 })
  const ordersQ = useQuery<PaperOrder[]>({ queryKey: ['paper-orders'], queryFn: () => getJson('paper/orders?limit=20'), refetchInterval: 30_000 })
  const trades = useQuery<PaperTrade[]>({ queryKey: ['paper-trades'], queryFn: () => getJson('paper/trades?limit=20'), refetchInterval: 30_000 })
  const events = useQuery<EventItem[]>({ queryKey: ['paper-events'], queryFn: () => getJson(`market/events?types=${PAPER_EVENT_TYPES}`), refetchInterval: 20_000 })
  const refreshAll = () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('paper') })

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; label: string }) => post(path, body),
    onSuccess: (d, v) => {
      const extra = d?.cycle?.skipped ? '风控巡检完成；这一小时的交易循环之前已执行过，不会重复下单' : d?.cycle ? '风控巡检和交易循环都已执行' : ''
      setMsg({ ok: true, text: `${v.label}：${extra || '已完成'}` })
      refreshAll()
    },
    onError: (e: Error, v) => setMsg({ ok: false, text: `${v.label}失败：${e.message}` }),
  })
  const [confirmStop, setConfirmStop] = useState(false)

  const s = status.data
  if (status.isLoading) return <div className={card}>正在加载模拟账户…</div>
  if (status.isError || !s) return <div className={card}>模拟账户加载失败：{(status.error as Error)?.message}（系统刚启动时可能需要几秒，请稍后刷新）</div>

  const st = STATE_STYLE[s.state]
  const totalRet = (s.equity / s.startingEquity - 1) * 100
  const dayPnl = s.equity - s.dayStartEquity

  return (
    <div className="space-y-4">
      {/* 顶部：状态 + 紧急停止 */}
      <div className={`${card} flex flex-wrap items-center justify-between gap-4`} style={{ borderColor: st.color }}>
        <div className="flex items-center gap-4 min-w-0">
          <span className="px-4 py-2 rounded-lg text-lg font-black whitespace-nowrap" style={{ color: st.color, background: st.bg }}>
            {st.label}
          </span>
          <div className="min-w-0">
            <div className="text-sm text-fg-base">{s.statusReason ?? st.hint}</div>
            {s.pauseKeys.length > 0 && (
              <div className="text-xs text-[#f59e0b] mt-0.5">暂停原因：{s.pauseKeys.map((k) => s.pauseDefs[k]?.label ?? k).join('；')}</div>
            )}
            <div className="text-[11px] text-fg-muted mt-1 flex flex-wrap gap-x-3">
              <span>模式：模拟（PAPER）</span>
              <span>上次每小时检查：{fmtTime(s.lastCycleAt)}</span>
              <span>下次：{fmtTime(s.nextCycleAt)}</span>
              <span>风控巡检：{s.lastMonitorAt ? `${Math.max(0, Math.round((s.serverTime - s.lastMonitorAt) / 1000))} 秒前` : '等待第一次'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => action.mutate({ path: 'paper/check-now', label: '立即检查' })}
            disabled={action.isPending}
            className="flex items-center gap-1 px-3 py-2 rounded-md border border-border-strong text-sm text-fg-subtle hover:text-fg-base disabled:opacity-50"
            title="马上跑一次风控巡检；如果这一小时还没处理，也会跑一次交易循环（同一根 K 线不会重复下单）"
          >
            <RefreshCw size={14} className={action.isPending ? 'animate-spin' : ''} /> 立即检查
          </button>
          {s.status === 'locked' ? (
            <button
              onClick={() => action.mutate({ path: 'paper/unlock', label: '解除锁定' })}
              disabled={action.isPending}
              className="flex items-center gap-1 px-4 py-2 rounded-md bg-[#f59e0b] text-black text-sm font-bold disabled:opacity-50"
            >
              <Unlock size={16} /> 解除锁定
            </button>
          ) : s.status === 'stopped' || s.pauseKeys.some((k) => !s.pauseDefs[k]?.auto) ? (
            <button
              onClick={() => action.mutate({ path: 'paper/resume', label: '恢复运行' })}
              disabled={action.isPending}
              className="flex items-center gap-1 px-4 py-2 rounded-md bg-[#10b981] text-black text-sm font-bold disabled:opacity-50"
            >
              <Play size={16} /> 恢复运行
            </button>
          ) : null}
          {s.status !== 'stopped' && (
            <button
              onClick={() => setConfirmStop(true)}
              className="flex items-center gap-2 px-5 py-3 rounded-lg bg-[#ef4444] hover:bg-[#dc2626] text-white text-base font-black shadow-lg"
            >
              <OctagonX size={20} /> 紧急停止
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={`text-sm px-3 py-2 rounded-md ${msg.ok ? 'bg-tag-cyan-10 text-tag-cyan-100' : 'bg-[rgba(239,68,68,0.12)] text-[#ef4444]'}`}>
          {msg.text}
          <button className="ml-3 text-xs underline" onClick={() => setMsg(null)}>
            关闭
          </button>
        </div>
      )}

      {confirmStop && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setConfirmStop(false)}>
          <div className={`${card} max-w-md w-full`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-lg font-black text-[#ef4444]">
              <ShieldAlert size={22} /> 确定紧急停止？
            </div>
            <ul className="text-sm text-fg-base mt-3 space-y-1 list-disc pl-5">
              <li>立刻按市价平掉全部 {s.positions.length} 个模拟持仓</li>
              <li>停止开新仓，直到你点「恢复运行」</li>
              <li>这是模拟账户，不涉及真钱</li>
            </ul>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-3 py-2 rounded-md border border-border-strong text-sm" onClick={() => setConfirmStop(false)}>
                取消
              </button>
              <button
                className="px-4 py-2 rounded-md bg-[#ef4444] text-white text-sm font-bold"
                onClick={() => {
                  setConfirmStop(false)
                  action.mutate({ path: 'paper/emergency-stop', label: '紧急停止', body: { note: '网页按钮' } })
                }}
              >
                确定停止
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 账户数字 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Big label="账户权益（USDT）" value={usd(s.equity)} sub={`起始 ${usd(s.startingEquity, 0)}`} />
        <Big label="累计收益" value={fmtPct(totalRet)} cls={tone(totalRet)} sub={`${signed(s.equity - s.startingEquity)} USDT`} />
        <Big label="今日盈亏（UTC）" value={`${signed(dayPnl)}`} cls={tone(dayPnl)} sub={fmtPct(s.gauges.dailyChangePct)} />
        <Big label="浮动盈亏" value={signed(s.unrealized)} cls={tone(s.unrealized)} sub={`${s.positions.length} 个持仓`} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <LatestCycle cycles={cycles.data ?? []} />
          <Positions s={s} />
        </div>
        <div className="space-y-4">
          <RiskGauges s={s} />
          <PauseConditions s={s} />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Strategies s={s} onToggle={(name, enabled, label) => action.mutate({ path: 'paper/strategy', body: { name, enabled }, label })} busy={action.isPending} />
        <div className="lg:col-span-2">
          <EventList events={events.data ?? []} />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <OrdersTable orders={ordersQ.data ?? []} />
        <TradesTable trades={trades.data ?? []} />
      </div>

      <HowItWorks />
    </div>
  )
}

function Big({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className={card}>
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-1 ${cls ?? 'text-fg-base'}`}>{value}</div>
      {sub && <div className="text-[11px] text-fg-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  )
}

function Title({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h3 className="font-bold text-fg-base">{children}</h3>
      {hint && <p className="text-[11px] text-fg-muted mt-0.5">{hint}</p>}
    </div>
  )
}

function LatestCycle({ cycles }: { cycles: Cycle[] }) {
  const [idx, setIdx] = useState(0)
  const c = cycles[idx]
  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <Title hint="每小时 K 线收盘后，系统对每个币走一遍：看市场状态 → 允许的策略有没有信号 → 风控逐项审核 → 模拟下单。">
          系统这一小时是怎么决定的
        </Title>
        {cycles.length > 1 && (
          <select className="text-xs bg-transparent border border-border-strong rounded px-2 py-1" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {cycles.map((x, i) => (
              <option key={x.id} value={i} className="bg-bg-base-opaque">
                {fmtTime(x.ts)}
              </option>
            ))}
          </select>
        )}
      </div>
      {!c && <div className="text-sm text-fg-muted">还没有运行记录。系统会在每小时第 2 分钟自动运行。</div>}
      {c && (
        <div className="grid md:grid-cols-2 gap-3">
          {c.summary.decisions.map((d) => (
            <DecisionCard key={d.symbol} d={d} />
          ))}
        </div>
      )}
    </div>
  )
}

function DecisionCard({ d }: { d: Decision }) {
  const rs = REGIME_STYLE[d.regime] ?? REGIME_STYLE.unclear
  return (
    <div className="border border-border-base rounded-md p-3">
      <div className="flex items-center justify-between">
        <div className="font-bold">{coin(d.symbol)}</div>
        <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ color: rs.color, background: rs.bg }}>
          {d.regimeLabel}
        </span>
      </div>
      <div className="text-[11px] text-fg-muted mt-1">
        收盘价 {fmtPrice(d.close)} · K 线 {fmtTime(d.barTs)}
      </div>
      {d.signal && (
        <div className="mt-2 text-sm">
          信号：<b>{d.signal.strategyLabel}</b> {d.signal.side > 0 ? '做多' : '做空'}，止损 {fmtPrice(d.signal.stop)}
        </div>
      )}
      {d.risk && (
        <div className="mt-2 space-y-0.5">
          <div className={`text-xs font-bold ${d.risk.approved ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>风控审核：{d.risk.approved ? '通过' : '拒绝'}</div>
          {d.risk.checks.map((k) => (
            <div key={k.key} className="flex items-start gap-1.5 text-[11px]" title={k.detail}>
              {k.ok ? <CheckCircle2 size={12} className="text-[#10b981] mt-0.5 shrink-0" /> : <XCircle size={12} className="text-[#ef4444] mt-0.5 shrink-0" />}
              <span className={k.ok ? 'text-fg-subtle' : 'text-fg-base'}>
                {k.label}
                <span className="text-fg-muted"> · {k.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {[...d.actions, ...d.notes].length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {d.actions.map((a, i) => (
            <li key={`a${i}`} className="text-sm text-fg-base">
              → {a}
            </li>
          ))}
          {d.notes.map((a, i) => (
            <li key={`n${i}`} className="text-xs text-fg-muted">
              · {a}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Bar({ label, value, limit, fmt, hint }: { label: string; value: number; limit: number; fmt: (v: number) => string; hint: string }) {
  const ratio = Math.max(0, Math.min(1, value / limit))
  const color = ratio >= 1 ? '#ef4444' : ratio >= 0.7 ? '#f59e0b' : '#10b981'
  return (
    <div title={hint}>
      <div className="flex justify-between text-xs">
        <span className="text-fg-subtle">{label}</span>
        <span className="font-mono">
          {fmt(value)} <span className="text-fg-muted">/ {fmt(limit)}</span>
        </span>
      </div>
      <div className="h-2 rounded bg-border-base mt-1 overflow-hidden">
        <div className="h-full rounded" style={{ width: `${ratio * 100}%`, background: color }} />
      </div>
    </div>
  )
}

function RiskGauges({ s }: { s: PaperStatus }) {
  const g = s.gauges
  const p1 = (v: number) => `${v.toFixed(2)}%`
  return (
    <div className={card}>
      <Title hint="红线写死在程序里，策略无法绕过。条越满越接近红线。">风控红线</Title>
      <div className="space-y-3">
        <Bar label={`今日亏损（到 ${g.dailyLimitPct}% 当天停手）`} value={Math.max(0, -g.dailyChangePct)} limit={g.dailyLimitPct} fmt={p1} hint="今天（UTC）权益相对今天开始时的跌幅" />
        <Bar label={`从最高点回撤（到 ${g.drawdownLimitPct}% 全平锁定）`} value={g.drawdownPct} limit={g.drawdownLimitPct} fmt={p1} hint={`最高权益 ${usd(s.peakEquity)}`} />
        <Bar label="总仓位 / 权益" value={g.grossPct} limit={g.grossLimitPct} fmt={(v) => `${v.toFixed(0)}%`} hint="5 个币走势相关，所有仓位合并计算" />
        <Bar label="杠杆" value={g.leverage} limit={g.maxLeverage} fmt={(v) => `${v.toFixed(2)}x`} hint="总仓位 ÷ 权益" />
      </div>
      <div className="text-[11px] text-fg-muted mt-3 space-y-0.5">
        <div>· 每笔最多亏权益的 {g.riskPerTradePct}%（仓位 = 可亏金额 ÷ 止损距离）</div>
        <div>· 单个币仓位不超过权益的 {g.symbolLimitPct}%</div>
      </div>
    </div>
  )
}

function PauseConditions({ s }: { s: PaperStatus }) {
  const per = s.checks?.per ?? {}
  const syms = Object.keys(per)
  const current: Record<string, { ok: boolean; detail: string }> = {
    stale: { ok: syms.every((x) => per[x].stale.ok), detail: syms.map((x) => `${coin(x)} ${per[x].stale.detail}`).join('，') },
    deviation: { ok: syms.every((x) => per[x].deviation.ok), detail: syms.map((x) => `${coin(x)} ${per[x].deviation.detail}`).join('，') },
    api_errors: { ok: s.apiErrors < 5, detail: `当前连续 ${s.apiErrors} 次` },
    order_unknown: { ok: !(s.checks?.unknown ?? 0), detail: `${s.checks?.unknown ?? 0} 笔未知` },
    reconcile: { ok: s.reconcile?.ok ?? true, detail: s.reconcile ? `${fmtTime(s.reconcile.at)} 对账${s.reconcile.ok ? '一致' : '不一致'}` : '等待对账' },
  }
  return (
    <div className={card}>
      <Title hint="任何一项异常都会自动暂停开新仓（止损照常）。数据类问题恢复正常 5 分钟后自动解除；订单/对账类问题需要你手动恢复。">
        自动暂停条件
      </Title>
      <div className="space-y-2">
        {Object.entries(s.pauseDefs).map(([k, def]) => {
          const active = s.pauseKeys.includes(k)
          const c = current[k]
          const ok = !active && (c?.ok ?? true)
          const stat = s.pauseStats?.[k]
          return (
            <div key={k} className="flex items-start gap-2">
              {active ? <XCircle size={14} className="text-[#ef4444] mt-0.5 shrink-0" /> : ok ? <CheckCircle2 size={14} className="text-[#10b981] mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="text-[#f59e0b] mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <div className="text-sm">{def.label}</div>
                <div className="text-[11px] text-fg-muted">
                  {active ? '正在暂停 · ' : ''}
                  {c?.detail || '—'} · {def.auto ? '自动恢复' : '需手动恢复'}
                  {stat ? ` · 已触发 ${stat.count} 次（最近 ${fmtTime(stat.lastTs)}）` : ' · 尚未触发过'}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="text-[11px] text-fg-muted mt-3 flex items-center gap-1">
        <Clock size={11} /> 心跳：{fmtTime(s.lastHeartbeat)}（每 5 分钟一次，连续缺 3 次视为宕机）
      </div>
    </div>
  )
}

export function Positions({ s }: { s: PaperStatus }) {
  return (
    <div className={card}>
      <Title hint="止损由系统每分钟看守；碰到止损立即按市价平仓。">当前持仓</Title>
      {s.positions.length === 0 ? (
        <div className="text-sm text-fg-muted">目前空仓。市场状态合适且出现信号时，系统会自动开仓。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="py-1 pr-3">币种</th>
                <th className="pr-3">方向</th>
                <th className="pr-3">数量</th>
                <th className="pr-3">开仓价</th>
                <th className="pr-3">现价</th>
                <th className="pr-3">止损价</th>
                <th className="pr-3">浮动盈亏</th>
                <th className="pr-3">止损时最多亏</th>
                <th>策略</th>
              </tr>
            </thead>
            <tbody>
              {s.positions.map((p) => (
                <tr key={p.symbol} className="border-t border-border-base font-mono">
                  <td className="py-1.5 pr-3 font-sans font-bold">{coin(p.symbol)}</td>
                  <td className={`pr-3 font-sans ${p.side > 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{p.side > 0 ? '做多' : '做空'}</td>
                  <td className="pr-3">{p.qty.toPrecision(4)}</td>
                  <td className="pr-3">{fmtPrice(p.entry_px)}</td>
                  <td className="pr-3">{fmtPrice(p.mark)}</td>
                  <td className="pr-3">
                    {fmtPrice(p.stop)} <span className="text-[10px] text-fg-muted">({p.stopDistancePct.toFixed(2)}%)</span>
                  </td>
                  <td className={`pr-3 ${tone(p.unrealized)}`}>{signed(p.unrealized)}</td>
                  <td className={`pr-3 ${tone(p.riskAtStop)}`}>{signed(p.riskAtStop)}</td>
                  <td className="font-sans text-xs">{p.strategyLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Strategies({ s, onToggle, busy }: { s: PaperStatus; onToggle: (name: string, enabled: boolean, label: string) => void; busy: boolean }) {
  return (
    <div className={card}>
      <Title hint="模拟盘用策略默认参数。主力是「趋势突破」（回测验收已通过）；两个旧策略回测亏损，默认关闭，仅保留作对照。">策略开关</Title>
      <div className="space-y-3">
        {s.strategies.map((st) => (
          <div key={st.name} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-bold">{st.label}</div>
              <div className="text-[11px] text-fg-muted">
                只在「{st.allowedRegimes.map((r) => (r === 'trend_up' ? '上涨趋势' : r === 'trend_down' ? '下跌趋势' : '震荡')).join(' / ')}」时开仓 · {st.invalidation}
              </div>
              {st.disabledReason && <div className="text-[11px] text-[#ef4444]">{st.disabledReason}</div>}
            </div>
            <button
              disabled={busy}
              onClick={() => onToggle(st.name, !(st.enabled && !st.disabledReason), `${st.enabled && !st.disabledReason ? '停用' : '启用'}${st.label}`)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold disabled:opacity-50 ${
                st.enabled && !st.disabledReason ? 'bg-[rgba(16,185,129,0.15)] text-[#10b981]' : 'bg-border-base text-fg-muted'
              }`}
            >
              {st.enabled && !st.disabledReason ? '已启用' : '已停用'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function EventList({ events }: { events: EventItem[] }) {
  const icon = (lv: string) =>
    lv === 'error' ? <XCircle size={14} className="text-[#ef4444]" /> : lv === 'warn' ? <AlertTriangle size={14} className="text-[#f59e0b]" /> : <Info size={14} className="text-[#6366f1]" />
  return (
    <div className={card}>
      <Title hint="开平仓、风控触发、自动暂停/恢复、你的操作、系统启动，全部记录在这里。">交易与风控事件</Title>
      <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
        {events.length === 0 && <div className="text-xs text-fg-muted">暂无事件</div>}
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(e.level)}</span>
            <div className="min-w-0">
              <div className="text-sm break-words">{e.message}</div>
              <div className="text-[11px] text-fg-muted">{fmtTime(e.ts)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function OrdersTable({ orders }: { orders: PaperOrder[] }) {
  const color = (st: string) => (st === 'FILLED' ? 'text-[#10b981]' : st === 'UNKNOWN' || st === 'REJECTED' ? 'text-[#ef4444]' : 'text-fg-subtle')
  return (
    <div className={card}>
      <Title hint="每个订单都有唯一编号，同一个信号重复执行也只会下一次单。">最近订单</Title>
      {orders.length === 0 ? (
        <div className="text-sm text-fg-muted">还没有订单</div>
      ) : (
        <div className="overflow-x-auto max-h-[320px]">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="py-1 pr-2">时间</th>
                <th className="pr-2">币种</th>
                <th className="pr-2">动作</th>
                <th className="pr-2">成交价</th>
                <th className="pr-2">状态</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border-base" title={o.client_order_id}>
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(o.created_at)}</td>
                  <td className="pr-2">{coin(o.symbol)}</td>
                  <td className="pr-2 whitespace-nowrap">
                    {o.side > 0 ? '买入' : '卖出'}
                    {o.intent === 'open' ? '开仓' : '平仓'}
                  </td>
                  <td className="pr-2 font-mono">{fmtPrice(o.fill_px)}</td>
                  <td className={`pr-2 whitespace-nowrap ${color(o.status)}`}>{o.statusLabel}</td>
                  <td className="text-fg-muted">{o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TradesTable({ trades }: { trades: PaperTrade[] }) {
  return (
    <div className={card}>
      <Title hint="净盈亏已扣手续费、滑点、资金费。">已平仓交易</Title>
      {trades.length === 0 ? (
        <div className="text-sm text-fg-muted">还没有平仓记录</div>
      ) : (
        <div className="overflow-x-auto max-h-[320px]">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="py-1 pr-2">平仓时间</th>
                <th className="pr-2">币种</th>
                <th className="pr-2">方向</th>
                <th className="pr-2">开 → 平</th>
                <th className="pr-2">净盈亏</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-border-base">
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(t.exit_ts)}</td>
                  <td className="pr-2">{coin(t.symbol)}</td>
                  <td className={`pr-2 ${t.side === 'long' ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{t.side === 'long' ? '多' : '空'}</td>
                  <td className="pr-2 font-mono whitespace-nowrap">
                    {fmtPrice(t.entry_px)} → {fmtPrice(t.exit_px)}
                  </td>
                  <td className={`pr-2 font-mono ${tone(t.pnl)}`}>{signed(t.pnl)}</td>
                  <td className="text-fg-muted">{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function HowItWorks() {
  const steps = [
    ['每小时第 2 分钟', 'K 线收盘后同步行情，判定每个币的市场状态'],
    ['选策略', '只运行当前市场状态允许的策略；状态不明确就不开新仓'],
    ['风控审核', '逐项检查：运行状态、自动暂停、日亏、数据新鲜度、策略是否失效、止损位置、仓位上限'],
    ['模拟成交', '按这一小时 K 线的开盘价 + 滑点成交（与回测规则一致），扣手续费'],
    ['每分钟巡检', '看守止损、回撤 10% 锁定、日亏 2% 停手、5 个自动暂停条件；每 5 分钟心跳与对账'],
  ]
  return (
    <div className={card}>
      <Title>模拟交易是怎么运转的</Title>
      <ol className="grid md:grid-cols-5 gap-3">
        {steps.map(([t, d], i) => (
          <li key={t} className="border border-border-base rounded-md p-3">
            <div className="text-xs text-fg-muted">第 {i + 1} 步</div>
            <div className="font-bold text-sm mt-0.5">{t}</div>
            <div className="text-[11px] text-fg-subtle mt-1">{d}</div>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-fg-muted mt-3">AI 不参与任何下单决定。行情来自 OKX 免费公共接口，不消耗 Surf 点数。</p>
    </div>
  )
}
