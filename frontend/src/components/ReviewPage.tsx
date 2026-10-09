import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Sparkles, RefreshCw, AlertTriangle, FlaskConical, Eye, Newspaper, Wallet, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime } from '@/lib/market'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'
const pnlColor = (v: number | null | undefined) => (v == null || v === 0 ? 'text-fg-base' : v > 0 ? 'text-[#10b981]' : 'text-[#ef4444]')
const signed = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`)
const usd4 = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(4)}`)

// ---------- 类型 ----------
interface AiStatus {
  provider: string
  model: string
  hasKey: boolean
  key: { masked: string | null; source: 'web' | 'file' | null }
  usage: { callsToday: number; marketToday: number; callsMonth: number; costMonthUsd: number; newsCreditsMonth: number; limits: { maxCallsPerDay: number; marketCallsPerDay: number; monthlyBudgetUsd: number } }
  balance: { currency: string; total: number; available: boolean } | null
  settings: { newsEnabled: boolean }
  busy: boolean
  schedule: string
}
interface ModelOpt { id: string; label: string; price: { inputMiss: number; output: number }; knownPrice: boolean }
interface DailyItem { id: number; day: string; created_at: number; status: string; trigger: string; cost_usd: number | null; headline: string | null; day_pnl: number | null; closed: number | null }
interface Trade { symbol: string; strategy: string; side: string; entryPx: number; exitPx: number; pnl: number; r: number | null; holdHours: number; exitReason: string; regimeAtEntry: string }
interface StratFact { name: string; enabled: boolean; disabledReason: string | null; today: { trades: number; pnl: number; winRatePct: number | null }; cumulative: { trades: number; pnl: number; winRatePct: number | null; profitFactor: number | null } }
interface DailyFacts {
  day: string
  account: { state: string; startEquity: number; endEquity: number; dayPnl: number; dayReturnPct: number; intradayMaxDrawdownPct: number; totalReturnPct: number; runningDays: number | null; note: string | null }
  trading: { opened: number; closed: number; trades: Trade[] }
  strategies: StratFact[]
  whyNoTrade: string[]
  hourlyCycles: { ran: number; expected: number }
  market: Record<string, { endRegime: string | null; changes: number; price: { open: number; close: number; high: number; low: number; changePct: number } | null }>
  events: { countByLevel: Record<string, number>; important: { time: string; level: string; type: string; message: string }[] }
}
interface DailyContent {
  headline?: string
  summary?: string
  market?: string
  strategies?: { name?: string; comment?: string }[]
  anomalies?: { title?: string; comment?: string }[]
  improvements?: { idea?: string; why?: string; howToVerify?: string }[]
  watch?: string[]
  news?: string
}
interface NewsItem { title: string; summary: string | null; source: string | null; ts: number | null; url: string | null }
interface Report<F, C> { id: number; day: string; created_at: number; status: string; trigger: string; facts: F; content: C | null; model: string | null; cost_usd: number | null; error: string | null; news: NewsItem[] | null; news_credits: number | null; usage: { ms?: number } | null }
interface MarketContent { headline?: string; symbols?: { symbol?: string; view?: string; watch?: string }[]; systemFit?: string; risks?: string[]; sentiment?: string }

const TRIGGER: Record<string, string> = { cron: '定时生成', catchup: '补生成', manual: '手动生成' }

async function postJSON(path: string, body?: unknown) {
  const r = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) throw new Error(j.error ?? j.reason ?? '操作失败')
  return j
}

// ---------- 页面 ----------
export default function ReviewPage() {
  const qc = useQueryClient()
  const status = useQuery<AiStatus>({ queryKey: ['review-status'], queryFn: () => fetch(api('review/status')).then((r) => r.json()), refetchInterval: 60_000 })
  const list = useQuery<DailyItem[]>({ queryKey: ['review-daily'], queryFn: () => fetch(api('review/daily')).then((r) => r.json()) })
  const [day, setDay] = useState<string | null>(null)
  useEffect(() => {
    if (!day && list.data?.length) setDay(list.data[0].day)
  }, [list.data, day])

  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const gen = useMutation({
    mutationFn: (d: string) => postJSON('review/daily/generate', { day: d }),
    onSuccess: (_r, d) => {
      setDay(d)
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('review') })
    },
    onError: () => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('review') }),
  })

  const s = status.data
  return (
    <div className="space-y-4">
      <Boundary />
      {s && <StatusBar s={s} />}

      <div className="grid lg:grid-cols-[260px_1fr] gap-4">
        <div className={`${card} h-fit`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold">每日复盘</h3>
          </div>
          <div className="space-y-1.5 mb-3">
            <button
              onClick={() => gen.mutate(yesterday)}
              disabled={gen.isPending}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-100 text-white text-sm font-semibold disabled:opacity-50"
            >
              <Sparkles size={14} className={gen.isPending ? 'animate-pulse' : ''} />
              {gen.isPending ? 'AI 正在写…（约 20 秒）' : '生成昨天的复盘'}
            </button>
            <button
              onClick={() => gen.mutate(today)}
              disabled={gen.isPending}
              className="w-full px-3 py-1.5 rounded-md border border-border-strong text-xs text-fg-subtle hover:text-fg-base disabled:opacity-50"
            >
              生成今天到目前为止的复盘
            </button>
            {gen.isError && <div className="text-xs text-[#ef4444]">{(gen.error as Error).message}</div>}
            <p className="text-[11px] text-fg-muted">每次手动生成会调用一次 AI（约 $0.004）。{s?.schedule}。</p>
          </div>
          {list.isLoading ? (
            <div className="text-sm text-fg-muted">加载中…</div>
          ) : !list.data?.length ? (
            <div className="text-sm text-fg-muted">还没有复盘。第一份会在明天北京时间 08:05 自动生成，也可以点上面的按钮立即生成。</div>
          ) : (
            <div className="space-y-1 max-h-[560px] overflow-y-auto">
              {list.data.map((it) => (
                <button
                  key={it.day}
                  onClick={() => setDay(it.day)}
                  className={`w-full text-left px-2.5 py-2 rounded-md border ${day === it.day ? 'border-brand-100 bg-bg-chat' : 'border-transparent hover:bg-bg-chat'}`}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">{it.day}</span>
                    <span className={`font-mono text-xs ${pnlColor(it.day_pnl)}`}>{signed(it.day_pnl)}</span>
                  </div>
                  <div className="text-[11px] text-fg-muted truncate">
                    {it.status === 'ok' ? it.headline ?? '—' : it.status === 'no_ai' ? '仅数字（未调用 AI）' : 'AI 调用失败，仅数字'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 min-w-0">
          {day ? <DailyReport day={day} onRegenerate={() => gen.mutate(day)} regenerating={gen.isPending} /> : <div className={card}>请选择或生成一份复盘。</div>}
        </div>
      </div>

      <MarketInsight s={s} />
    </div>
  )
}

function Boundary() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-tag-cyan-100/40 bg-tag-cyan-10 px-3 py-2 text-xs text-fg-subtle">
      <ShieldCheck size={14} className="text-tag-cyan-100 mt-0.5 shrink-0" />
      <div>
        <b className="text-fg-base">AI 只写文字，不碰交易。</b> 所有数字由代码计算；AI 只负责把数字写成点评和建议。AI 的输出只存档给你看，
        <b className="text-fg-base">不会进入下单流程</b>，系统开仓、平仓、仓位全部由规则和风控决定。AI 的改进建议都要先在回测实验室验证。
      </div>
    </div>
  )
}

function StatusBar({ s }: { s: AiStatus }) {
  const u = s.usage
  const budgetPct = Math.min(100, (u.costMonthUsd / u.limits.monthlyBudgetUsd) * 100)
  return (
    <div className={`${card} grid grid-cols-2 md:grid-cols-5 gap-3 text-sm`}>
      <Stat label="AI 模型" icon={<Bot size={13} />}>
        {s.provider} · <span className="font-mono text-xs">{s.model}</span>
        <div className={`text-[11px] ${s.hasKey ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{s.hasKey ? '已配置 API Key' : '未配置 API Key'}</div>
      </Stat>
      <Stat label="今天 AI 调用" icon={<Sparkles size={13} />}>
        <span className="font-mono">
          {u.callsToday} / {u.limits.maxCallsPerDay}
        </span>
        <div className="text-[11px] text-fg-muted">
          市场解读 {u.marketToday} / {u.limits.marketCallsPerDay}
        </div>
      </Stat>
      <Stat label="本月估算花费" icon={<Wallet size={13} />}>
        <span className="font-mono">{usd4(u.costMonthUsd)}</span>
        <span className="text-[11px] text-fg-muted"> / 预算 ${u.limits.monthlyBudgetUsd}</span>
        <div className="h-1 rounded bg-bg-chat mt-1 overflow-hidden">
          <div className="h-full bg-brand-100" style={{ width: `${budgetPct}%` }} />
        </div>
      </Stat>
      <Stat label="DeepSeek 余额" icon={<Wallet size={13} />}>
        <span className="font-mono">{s.balance ? `${s.balance.total.toFixed(2)} ${s.balance.currency === 'CNY' ? '元' : s.balance.currency}` : '—'}</span>
        <div className="text-[11px] text-fg-muted">费用走你的 DeepSeek 账户</div>
      </Stat>
      <Stat label="参考新闻" icon={<Newspaper size={13} />}>
        <span className={s.settings.newsEnabled ? 'text-[#f59e0b]' : ''}>{s.settings.newsEnabled ? '已开启' : '关闭'}</span>
        <div className="text-[11px] text-fg-muted">
          {s.settings.newsEnabled ? `本月消耗 Surf ${u.newsCreditsMonth} 点` : '不消耗 Surf 点数'} · 在「设置」页修改
        </div>
      </Stat>
    </div>
  )
}

function Stat({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-fg-muted flex items-center gap-1 mb-0.5">
        {icon}
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

// ---------- 单日复盘 ----------
function DailyReport({ day, onRegenerate, regenerating }: { day: string; onRegenerate: () => void; regenerating: boolean }) {
  const q = useQuery<{ latest: Report<DailyFacts, DailyContent>; versions: { id: number }[] }>({
    queryKey: ['review-day', day],
    queryFn: async () => {
      const r = await fetch(api(`review/daily/${day}`))
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? '加载失败')
      return r.json()
    },
  })
  if (q.isLoading) return <div className={card}>加载中…</div>
  if (!q.data) return <div className={card}>{(q.error as Error)?.message ?? '加载失败'}</div>
  const r = q.data.latest
  const f = r.facts
  const c = r.content
  const a = f.account

  return (
    <>
      <div className={card}>
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div>
            <h2 className="text-lg font-black">{c?.headline ?? `${day} 复盘`}</h2>
            <div className="text-[11px] text-fg-muted mt-0.5">
              {day}（UTC） · {TRIGGER[r.trigger] ?? r.trigger}于 {fmtTime(r.created_at)}
              {r.model && r.status === 'ok' && ` · ${r.model} · 费用 ${usd4(r.cost_usd)}`}
              {r.news_credits ? ` · 新闻消耗 Surf ${r.news_credits} 点` : ''}
              {q.data.versions.length > 1 && ` · 共 ${q.data.versions.length} 个版本，显示最新`}
            </div>
          </div>
          <button
            onClick={onRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border-strong text-xs text-fg-subtle hover:text-fg-base disabled:opacity-50"
          >
            <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} /> 重新生成
          </button>
        </div>
        {a.note && <div className="text-xs text-[#f59e0b] mb-2">注：{a.note}</div>}

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
          <Kpi label="当日盈亏" value={<span className={pnlColor(a.dayPnl)}>{signed(a.dayPnl)} U</span>} sub={`${signed(a.dayReturnPct, 3)}%`} />
          <Kpi label="日终权益" value={a.endEquity.toLocaleString()} sub={`累计 ${signed(a.totalReturnPct, 2)}%`} />
          <Kpi label="日内最大回撤" value={`${a.intradayMaxDrawdownPct.toFixed(2)}%`} />
          <Kpi label="开仓 / 平仓" value={`${f.trading.opened} / ${f.trading.closed}`} />
          <Kpi label="整点循环" value={`${f.hourlyCycles.ran} / ${f.hourlyCycles.expected}`} sub="实际 / 应跑" />
          <Kpi
            label="告警"
            value={
              <span>
                <span className="text-[#ef4444]">{f.events.countByLevel.error ?? 0}</span> · <span className="text-[#f59e0b]">{f.events.countByLevel.warn ?? 0}</span>
              </span>
            }
            sub="严重 · 警告"
          />
        </div>

        <div className="grid md:grid-cols-2 gap-2">
          {Object.entries(f.market).map(([sym, m]) => (
            <div key={sym} className="rounded-md bg-bg-chat px-3 py-2 text-sm flex items-center justify-between">
              <span className="font-semibold">{sym.split('/')[0]}</span>
              {m.price ? (
                <span className="font-mono text-xs">
                  {m.price.open.toLocaleString()} → {m.price.close.toLocaleString()} <span className={pnlColor(m.price.changePct)}>({signed(m.price.changePct)}%)</span>
                </span>
              ) : (
                <span className="text-xs text-fg-muted">无数据</span>
              )}
              <span className="text-xs text-fg-muted">
                日终：{m.endRegime ?? '—'}
                {m.changes ? ` · 切换 ${m.changes} 次` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      {r.status !== 'ok' ? (
        <div className={`${card} flex items-start gap-2 text-sm`}>
          <AlertTriangle size={16} className="text-[#f59e0b] mt-0.5 shrink-0" />
          <div>
            <b>这份复盘没有 AI 点评</b>
            <div className="text-fg-subtle text-xs mt-0.5">原因：{r.error ?? '未知'}。上面的数字部分不受影响。</div>
          </div>
        </div>
      ) : (
        c && <AiDaily c={c} />
      )}

      {f.trading.trades.length > 0 && (
        <div className={card}>
          <h3 className="font-bold mb-2">当天平仓明细</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-fg-muted">
                  <th className="py-1 pr-3">标的</th>
                  <th className="pr-3">策略</th>
                  <th className="pr-3">方向</th>
                  <th className="pr-3">开 → 平</th>
                  <th className="pr-3">持有</th>
                  <th className="pr-3">盈亏</th>
                  <th className="pr-3">R</th>
                  <th>平仓原因</th>
                </tr>
              </thead>
              <tbody>
                {f.trading.trades.map((t, i) => (
                  <tr key={i} className="border-t border-border-base">
                    <td className="py-1.5 pr-3">{t.symbol.split('/')[0]}</td>
                    <td className="pr-3">{t.strategy}</td>
                    <td className="pr-3">{t.side}</td>
                    <td className="pr-3 font-mono text-xs">
                      {t.entryPx} → {t.exitPx}
                    </td>
                    <td className="pr-3">{t.holdHours}h</td>
                    <td className={`pr-3 font-mono ${pnlColor(t.pnl)}`}>{signed(t.pnl)}</td>
                    <td className="pr-3 font-mono">{t.r == null ? '—' : signed(t.r)}</td>
                    <td className="text-xs text-fg-subtle">{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div className={card}>
          <h3 className="font-bold mb-2">没有开仓的原因（代码记录）</h3>
          {f.whyNoTrade.length ? (
            <ul className="text-xs text-fg-subtle space-y-1 list-disc pl-4">
              {f.whyNoTrade.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-fg-muted">当天没有记录。</div>
          )}
        </div>
        <div className={card}>
          <h3 className="font-bold mb-2">重要事件</h3>
          {f.events.important.length ? (
            <ul className="text-xs space-y-1 max-h-48 overflow-y-auto">
              {f.events.important.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-fg-muted font-mono shrink-0">{e.time.slice(0, 5)}</span>
                  <span className={e.level === 'error' ? 'text-[#ef4444]' : e.level === 'warn' ? 'text-[#f59e0b]' : 'text-fg-subtle'}>{e.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-fg-muted">当天没有重要事件。</div>
          )}
        </div>
      </div>

      {r.news && r.news.length > 0 && (
        <div className={card}>
          <h3 className="font-bold mb-2 flex items-center gap-1.5">
            <Newspaper size={15} /> 当天新闻（AI 参考用）
          </h3>
          <ul className="text-xs space-y-1.5">
            {r.news.map((n, i) => (
              <li key={i}>
                {n.url ? (
                  <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline">
                    {n.title}
                  </a>
                ) : (
                  n.title
                )}
                <span className="text-fg-muted"> · {n.source ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-md bg-bg-chat px-3 py-2">
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className="font-bold font-mono">{value}</div>
      {sub && <div className="text-[11px] text-fg-muted">{sub}</div>}
    </div>
  )
}

function AiDaily({ c }: { c: DailyContent }) {
  return (
    <div className={`${card} space-y-4`}>
      <h3 className="font-bold flex items-center gap-1.5">
        <Bot size={16} className="text-brand-100" /> AI 点评
      </h3>
      {c.summary && <p className="text-sm leading-relaxed">{c.summary}</p>}
      {c.market && (
        <Section title="行情">
          <p className="text-sm text-fg-subtle leading-relaxed">{c.market}</p>
        </Section>
      )}
      {!!c.strategies?.length && (
        <Section title="策略表现">
          <div className="grid md:grid-cols-2 gap-2">
            {c.strategies.map((s, i) => (
              <div key={i} className="rounded-md bg-bg-chat px-3 py-2">
                <div className="text-sm font-semibold">{s.name ?? '—'}</div>
                <div className="text-xs text-fg-subtle mt-0.5 leading-relaxed">{s.comment}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section title="异常">
        {c.anomalies?.length ? (
          <div className="space-y-1.5">
            {c.anomalies.map((x, i) => (
              <div key={i} className="flex gap-2 text-sm">
                <AlertTriangle size={14} className="text-[#f59e0b] mt-0.5 shrink-0" />
                <div>
                  <b>{x.title}</b>
                  <div className="text-xs text-fg-subtle leading-relaxed">{x.comment}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-fg-muted">没有异常。</div>
        )}
      </Section>
      {!!c.improvements?.length && (
        <Section title="待验证的改进点" hint="只是假设，系统不会自动采用。要先在回测实验室验证通过，再由你决定是否修改。">
          <div className="space-y-2">
            {c.improvements.map((x, i) => (
              <div key={i} className="rounded-md border border-border-base px-3 py-2">
                <div className="text-sm font-semibold flex items-start gap-1.5">
                  <FlaskConical size={14} className="text-[#a855f7] mt-0.5 shrink-0" />
                  {x.idea}
                  <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#a855f7]/15 text-[#a855f7]">待验证</span>
                </div>
                {x.why && <div className="text-xs text-fg-subtle mt-1">依据：{x.why}</div>}
                {x.howToVerify && <div className="text-xs text-fg-subtle mt-0.5">怎么验证：{x.howToVerify}</div>}
              </div>
            ))}
          </div>
        </Section>
      )}
      {!!c.watch?.length && (
        <Section title="明天关注">
          <ul className="text-sm space-y-1">
            {c.watch.map((w, i) => (
              <li key={i} className="flex gap-1.5">
                <Eye size={14} className="text-fg-muted mt-0.5 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {c.news && (
        <Section title="新闻解读">
          <p className="text-sm text-fg-subtle">{c.news}</p>
        </Section>
      )}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-fg-muted mb-1.5">
        {title}
        {hint && <span className="font-normal"> · {hint}</span>}
      </div>
      {children}
    </div>
  )
}

// ---------- 市场解读 ----------
function MarketInsight({ s }: { s?: AiStatus }) {
  const qc = useQueryClient()
  const q = useQuery<Report<unknown, MarketContent>[]>({ queryKey: ['review-market'], queryFn: () => fetch(api('review/market')).then((r) => r.json()) })
  const [idx, setIdx] = useState(0)
  const run = useMutation({
    mutationFn: () => postJSON('review/market'),
    onSuccess: () => {
      setIdx(0)
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('review') })
    },
  })
  const left = s ? Math.max(0, s.usage.limits.marketCallsPerDay - s.usage.marketToday) : null
  const items = (q.data ?? []).filter((x) => x.status === 'ok')
  const cur = items[idx]
  const c = cur?.content

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="font-bold flex items-center gap-1.5">
            <Sparkles size={16} className="text-brand-100" /> AI 解读当前市场
          </h3>
          <p className="text-[11px] text-fg-muted">点一次调用一次 AI（约 $0.004），只是参考文字，不影响系统交易。</p>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 1 && (
            <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="bg-bg-chat border border-border-strong rounded-md text-xs px-2 py-1">
              {items.map((x, i) => (
                <option key={x.id} value={i}>
                  {fmtTime(x.created_at)}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => run.mutate()}
            disabled={run.isPending || left === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-100 text-white text-sm font-semibold disabled:opacity-50"
          >
            <Sparkles size={14} className={run.isPending ? 'animate-pulse' : ''} />
            {run.isPending ? 'AI 正在分析…' : `立即解读${left != null ? `（今天还剩 ${left} 次）` : ''}`}
          </button>
        </div>
      </div>
      {run.isError && <div className="text-xs text-[#ef4444] mb-2">{(run.error as Error).message}</div>}
      {!cur || !c ? (
        <div className="text-sm text-fg-muted">还没有解读记录。</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <b className="text-base">{c.headline}</b>
            <span className="text-[11px] text-fg-muted">
              {fmtTime(cur.created_at)} · 费用 {usd4(cur.cost_usd)}
            </span>
          </div>
          <div className="grid md:grid-cols-2 gap-2">
            {(c.symbols ?? []).map((x, i) => (
              <div key={i} className="rounded-md bg-bg-chat px-3 py-2">
                <div className="text-sm font-semibold">{x.symbol ?? '—'}</div>
                <div className="text-xs text-fg-subtle mt-0.5 leading-relaxed">{x.view}</div>
                {x.watch && <div className="text-xs mt-1">关注：{x.watch}</div>}
              </div>
            ))}
          </div>
          {c.systemFit && (
            <Section title="系统接下来会怎么做（按现有规则）">
              <p className="text-sm text-fg-subtle">{c.systemFit}</p>
            </Section>
          )}
          {!!c.risks?.length && (
            <Section title="风险提示">
              <ul className="text-sm list-disc pl-5 space-y-0.5">
                {c.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Section>
          )}
          {c.sentiment && <div className="text-xs text-fg-muted">情绪：{c.sentiment}</div>}
        </div>
      )}
    </div>
  )
}

// ---------- 设置页里的 AI 设置卡片 ----------
export function AiSettingsCard() {
  const qc = useQueryClient()
  const q = useQuery<AiStatus>({ queryKey: ['review-status'], queryFn: () => fetch(api('review/status')).then((r) => r.json()) })
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: (newsEnabled: boolean) => postJSON('review/settings', { newsEnabled, reason }),
    onSuccess: () => {
      setReason('')
      qc.invalidateQueries({ queryKey: ['review-status'] })
      qc.invalidateQueries({ queryKey: ['settings-history'] })
    },
  })
  const s = q.data
  if (!s) return null
  const on = s.settings.newsEnabled
  return (
    <div className={card}>
      <h3 className="font-bold flex items-center gap-1.5">
        <Bot size={16} className="text-brand-100" /> AI 复盘
      </h3>
      <p className="text-[11px] text-fg-muted mt-0.5 mb-3">AI 只写复盘文字，不进入下单流程。费用走你的 DeepSeek 账户。</p>
      <AiConfigForm s={s} />
      <div className="grid md:grid-cols-2 gap-3 text-sm my-3">
        <div className="rounded-md bg-bg-chat px-3 py-2">
          <div className="text-[11px] text-fg-muted">费用保护</div>
          每天最多 {s.usage.limits.maxCallsPerDay} 次 · 市场解读 {s.usage.limits.marketCallsPerDay} 次 · 月预算 ${s.usage.limits.monthlyBudgetUsd}
        </div>
        <div className="rounded-md bg-bg-chat px-3 py-2">
          <div className="text-[11px] text-fg-muted">自动生成</div>
          {s.schedule}
        </div>
      </div>
      <div className={`rounded-md border px-3 py-3 ${on ? 'border-[#f59e0b]' : 'border-border-base'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-sm flex items-center gap-1.5">
              <Newspaper size={14} /> 复盘时参考当天加密新闻：{on ? <span className="text-[#f59e0b]">已开启</span> : '关闭'}
            </div>
            <div className="text-[11px] text-fg-muted mt-0.5">
              开启后每份复盘会调用 1 次 Surf 新闻接口（<b>消耗 Surf 点数</b>，具体点数会记录在每份复盘上）。默认关闭。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="修改原因（必填）"
              className="bg-bg-chat border border-border-strong rounded-md px-2 py-1 text-xs w-44"
            />
            <button
              onClick={() => save.mutate(!on)}
              disabled={!reason.trim() || save.isPending}
              className={`px-3 py-1 rounded-md text-xs font-semibold disabled:opacity-50 ${on ? 'border border-border-strong' : 'bg-[#f59e0b] text-black'}`}
            >
              {on ? '关闭' : '开启'}
            </button>
          </div>
        </div>
        {save.isError && <div className="text-xs text-[#ef4444] mt-1">{(save.error as Error).message}</div>}
      </div>
    </div>
  )
}

function AiConfigForm({ s }: { s: AiStatus }) {
  const qc = useQueryClient()
  const models = useQuery<ModelOpt[]>({ queryKey: ['review-models', s.key.masked], queryFn: () => fetch(api('review/models')).then((r) => r.json()) })
  const [key, setKey] = useState('')
  const [model, setModel] = useState(s.model)
  const [reason, setReason] = useState('')
  useEffect(() => setModel(s.model), [s.model])
  const save = useMutation({
    mutationFn: () => postJSON('review/ai-config', { apiKey: key.trim() || undefined, model: model !== s.model ? model : undefined, reason }),
    onSuccess: () => {
      setKey('')
      setReason('')
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('review') })
      qc.invalidateQueries({ queryKey: ['settings-history'] })
    },
  })
  const dirty = !!key.trim() || model !== s.model
  const perCall = (m?: ModelOpt) => (m ? (2000 * m.price.inputMiss + 3000 * m.price.output) / 1e6 : null)
  const sel = models.data?.find((m) => m.id === model)
  return (
    <div className="rounded-md border border-border-base px-3 py-3 space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <label className="block">
          <div className="text-xs font-semibold mb-1">DeepSeek API Key</div>
          <div className="text-[11px] text-fg-muted mb-1">
            当前：{s.key.masked ? <span className="font-mono">{s.key.masked}</span> : <span className="text-[#ef4444]">未配置</span>}
            {s.key.source === 'web' ? '（在本页设置）' : s.key.source === 'file' ? '（服务器配置文件）' : ''}
          </div>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="粘贴新的 Key（sk-…），不换就留空"
            className="w-full bg-bg-chat border border-border-strong rounded-md px-2 py-1.5 text-sm font-mono"
          />
          <div className="text-[11px] text-fg-muted mt-1">保存前会先向 DeepSeek 验证 Key 是否有效。Key 只保存在服务器上，页面和修改记录里只显示打码后的样子。</div>
        </label>
        <label className="block">
          <div className="text-xs font-semibold mb-1">模型</div>
          <div className="text-[11px] text-fg-muted mb-1">当前：{s.model}</div>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full bg-bg-chat border border-border-strong rounded-md px-2 py-1.5 text-sm">
            {(models.data ?? [{ id: s.model, label: s.model } as ModelOpt]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-fg-muted mt-1">
            {sel ? `估算每次约 $${perCall(sel)!.toFixed(4)}（按高峰价）${sel.knownPrice ? '' : '；这个模型价格未知，按最贵的估算'}` : '模型列表由 DeepSeek 实时提供'}
          </div>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="修改原因（必填，会记录）" className="flex-1 min-w-[200px] bg-bg-chat border border-border-strong rounded-md px-2 py-1.5 text-xs" />
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || !reason.trim() || save.isPending}
          className="px-3 py-1.5 rounded-md bg-brand-100 text-white text-xs font-semibold disabled:opacity-50"
        >
          {save.isPending ? '验证并保存中…' : '保存 AI 设置'}
        </button>
      </div>
      {save.isError && <div className="text-xs text-[#ef4444]">{(save.error as Error).message}</div>}
      {save.isSuccess && <div className="text-xs text-[#10b981]">已保存，下一次 AI 调用起生效。</div>}
    </div>
  )
}
