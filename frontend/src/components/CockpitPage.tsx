import ReactECharts from 'echarts-for-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { XCircle, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { type EventItem, coin, fmtPrice, fmtPct, fmtTime, fmtDate } from '@/lib/market'
import { type PaperStatus, type PaperStats, type PaperOrder, type PaperTrade, type OrderDetail, type GroupStat, STATE_STYLE, EVENT_TYPE_NAME } from '@/lib/paper'
import { Positions } from '@/components/PaperPage'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'
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
const usd = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${usd(v, d)}`
const tone = (v: number | null | undefined) => (v == null ? 'text-fg-base' : v > 0 ? 'text-[#10b981]' : v < 0 ? 'text-[#ef4444]' : 'text-fg-base')

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(api(path))
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error ?? '加载失败')
  return j as T
}

export default function CockpitPage({ goPaper }: { goPaper: () => void }) {
  const status = useQuery<PaperStatus>({ queryKey: ['paper-status'], queryFn: () => getJson('paper/status'), refetchInterval: 10_000 })
  const stats = useQuery<PaperStats>({ queryKey: ['paper-stats'], queryFn: () => getJson('paper/stats'), refetchInterval: 60_000 })
  const s = status.data
  const st = stats.data

  if (status.isLoading || stats.isLoading) return <div className={card}>正在加载驾驶舱…</div>
  if (!s || !st) return <div className={card}>加载失败：{((status.error || stats.error) as Error)?.message}（请稍后刷新）</div>

  const state = STATE_STYLE[s.state]
  const days = st.runningDays
  return (
    <div className="space-y-4">
      {/* 第一行：状态 + 核心数字 */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <button onClick={goPaper} className={`${card} text-left col-span-2 lg:col-span-1 hover:border-fg-muted`} style={{ borderColor: state.color }} title="点击进入模拟交易控制台（紧急停止在那里）">
          <div className="text-[11px] text-fg-muted">系统状态</div>
          <div className="text-xl font-black mt-1" style={{ color: state.color }}>
            {state.label}
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5">点此进入控制台 →</div>
        </button>
        <Kpi label="账户权益（USDT）" value={usd(s.equity)} sub={`起始 ${usd(st.startingEquity, 0)}`} />
        <Kpi label="累计收益" value={fmtPct(st.totalReturnPct)} cls={tone(st.totalReturnPct)} sub={`${signed(s.equity - st.startingEquity)} USDT`} />
        <Kpi label="最大回撤" value={`${st.maxDrawdownPct.toFixed(2)}%`} cls={st.maxDrawdownPct > 0 ? 'text-[#ef4444]' : undefined} sub={`锁定线 ${s.gauges.drawdownLimitPct}%`} />
        <Kpi label="今日盈亏（UTC）" value={signed(s.equity - s.dayStartEquity)} cls={tone(s.equity - s.dayStartEquity)} sub={`停手线 -${s.gauges.dailyLimitPct}%`} />
        <Kpi
          label="已运行"
          value={days < 1 ? `${Math.max(1, Math.round(days * 24))} 小时` : `${days.toFixed(1)} 天`}
          sub={`目标 30 天 · ${Math.min(100, (days / 30) * 100).toFixed(0)}%`}
          bar={Math.min(1, days / 30)}
        />
      </div>

      <div className={card}>
        <Title hint={`每小时 K 线收盘后记录一次，最右边一点是此刻的实时权益。起始于 ${fmtDate(st.startedAt)}。`}>账户净值曲线</Title>
        <EquityCurve st={st} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Positions s={s} />
        </div>
        <PerfCard st={st} />
      </div>

      <Breakdown st={st} />

      <div className="grid lg:grid-cols-2 gap-4">
        <TradesFull />
        <OrdersFull />
      </div>

      <AlertCenter />
    </div>
  )
}

function Kpi({ label, value, sub, cls, bar }: { label: string; value: string; sub?: string; cls?: string; bar?: number }) {
  return (
    <div className={card}>
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className={`font-mono text-xl font-bold mt-1 ${cls ?? 'text-fg-base'}`}>{value}</div>
      {sub && <div className="text-[11px] text-fg-muted mt-0.5">{sub}</div>}
      {bar != null && (
        <div className="h-1.5 rounded bg-border-base mt-1.5 overflow-hidden">
          <div className="h-full bg-brand-100 rounded" style={{ width: `${bar * 100}%` }} />
        </div>
      )}
    </div>
  )
}

function Title({ children, hint, right }: { children: ReactNode; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 className="font-bold text-fg-base">{children}</h3>
        {hint && <p className="text-[11px] text-fg-muted mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  )
}

function EquityCurve({ st }: { st: PaperStats }) {
  if (st.curve.length < 2)
    return <div className="h-[200px] flex items-center justify-center text-sm text-fg-muted">数据还太少，运行几个小时后这里会出现曲线。</div>
  const labels = st.curve.map((p) => fmtTime(p.ts))
  const option = {
    animation: false,
    grid: [
      { left: 70, right: 16, top: 16, height: '60%' },
      { left: 70, right: 16, top: '78%', bottom: 26 },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [0, 1].map((i) => ({
      type: 'category',
      data: labels,
      gridIndex: i,
      boundaryGap: false,
      axisLine: { lineStyle: { color: fgSubtle } },
      axisLabel: { color: fgSubtle, show: i === 1, hideOverlap: true },
      axisTick: { show: false },
    })),
    yAxis: [
      { scale: true, gridIndex: 0, axisLabel: { color: fgSubtle, formatter: (v: number) => v.toLocaleString('en-US') }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
      { gridIndex: 1, max: 0, splitNumber: 2, axisLabel: { color: fgSubtle, formatter: '{value}%' }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
    ],
    tooltip: { trigger: 'axis', ...tip },
    series: [
      {
        name: '权益',
        type: 'line',
        data: st.curve.map((p) => Math.round(p.equity * 100) / 100),
        symbol: 'none',
        lineStyle: { width: 1.8, color: '#fd4b96' },
        areaStyle: { color: '#fd4b96', opacity: 0.08 },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: fgSubtle, type: 'dashed' }, label: { color: fgSubtle, formatter: '起始' }, data: [{ yAxis: st.startingEquity }] },
      },
      { name: '回撤 %', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: st.drawdown.map((d) => Math.round(d.dd * 100) / 100), symbol: 'none', lineStyle: { width: 1, color: '#ef4444' }, areaStyle: { color: '#ef4444', opacity: 0.15 } },
    ],
  }
  return <ReactECharts option={option} style={{ height: 320 }} notMerge />
}

function PerfCard({ st }: { st: PaperStats }) {
  const o = st.overall
  const totalCost = st.costs.fees + st.costs.slippage + st.costs.funding
  const rows: [string, string, string?][] = [
    ['交易笔数', String(o.trades), '已平仓'],
    ['胜率', o.winRatePct == null ? '—' : `${o.winRatePct.toFixed(0)}%`, '赚钱的笔数占比'],
    ['盈亏比', o.profitFactor == null ? '—' : o.profitFactor.toFixed(2), '总盈利 ÷ 总亏损，大于 1 才赚钱'],
    ['平均每笔（R）', o.avgR == null ? '—' : `${o.avgR > 0 ? '+' : ''}${o.avgR.toFixed(2)}R`, '1R = 这笔交易计划的最大亏损'],
    ['平均持仓', o.avgHoldHours == null ? '—' : `${o.avgHoldHours.toFixed(1)} 小时`],
    ['已实现盈亏', `${signed(o.pnl)}`],
    ['交易成本合计', usd(totalCost), `手续费 ${usd(st.costs.fees)} · 滑点 ${usd(st.costs.slippage)} · 资金费 ${usd(st.costs.funding)}`],
  ]
  return (
    <div className={card}>
      <Title hint="满 20 笔后数字才有参考意义；验收要求 30 天里没有未处理的异常。">交易表现</Title>
      <div className="space-y-2">
        {rows.map(([l, v, h]) => (
          <div key={l} className="flex items-start justify-between gap-3" title={h}>
            <div>
              <div className="text-sm text-fg-subtle">{l}</div>
              {h && <div className="text-[10px] text-fg-muted">{h}</div>}
            </div>
            <div className="font-mono text-sm font-bold whitespace-nowrap">{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Breakdown({ st }: { st: PaperStats }) {
  const groups: [string, GroupStat[]][] = [
    ['按策略', st.byStrategy],
    ['按币种', st.bySymbol.map((g) => ({ ...g, label: coin(g.label) }))],
    ['按方向', st.bySide],
  ]
  if (!st.overall.trades) return null
  return (
    <div className={card}>
      <Title hint="看清楚钱是从哪里赚的、在哪里亏的。">盈亏拆分</Title>
      <div className="grid md:grid-cols-3 gap-4">
        {groups.map(([t, rows]) => (
          <div key={t}>
            <div className="text-xs text-fg-muted mb-1">{t}</div>
            <table className="w-full text-sm">
              <tbody>
                {rows.map((g) => (
                  <tr key={g.key} className="border-t border-border-base">
                    <td className="py-1">{g.label}</td>
                    <td className="text-right text-xs text-fg-muted">{g.trades} 笔</td>
                    <td className="text-right text-xs text-fg-muted">{g.winRatePct == null ? '—' : `胜率 ${g.winRatePct.toFixed(0)}%`}</td>
                    <td className={`text-right font-mono ${tone(g.pnl)}`}>{signed(g.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}

function TradesFull() {
  const [limit, setLimit] = useState(30)
  const q = useQuery<PaperTrade[]>({ queryKey: ['paper-trades-full', limit], queryFn: () => getJson(`paper/trades?limit=${limit}`), refetchInterval: 60_000 })
  const trades = q.data ?? []
  return (
    <div className={card}>
      <Title hint="净盈亏已扣除手续费、滑点和资金费。">交易记录</Title>
      {trades.length === 0 ? (
        <div className="text-sm text-fg-muted">还没有平仓记录。系统只在市场状态合适且出现信号时开仓，可能要等一段时间。</div>
      ) : (
        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-bg-base-opaque">
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="py-1 pr-2">开仓</th>
                <th className="pr-2">平仓</th>
                <th className="pr-2">币种</th>
                <th className="pr-2">方向</th>
                <th className="pr-2">价格</th>
                <th className="pr-2">成本</th>
                <th className="pr-2">净盈亏</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-border-base" title={t.strategyLabel}>
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(t.entry_ts)}</td>
                  <td className="pr-2 whitespace-nowrap">{fmtTime(t.exit_ts)}</td>
                  <td className="pr-2">{coin(t.symbol)}</td>
                  <td className={`pr-2 ${t.side === 'long' ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{t.side === 'long' ? '多' : '空'}</td>
                  <td className="pr-2 font-mono whitespace-nowrap">
                    {fmtPrice(t.entry_px)} → {fmtPrice(t.exit_px)}
                  </td>
                  <td className="pr-2 font-mono">{usd((t.fees ?? 0) + (t.funding ?? 0))}</td>
                  <td className={`pr-2 font-mono ${tone(t.pnl)}`}>{signed(t.pnl)}</td>
                  <td className="text-fg-muted">{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length >= limit && (
            <button className="mt-2 text-xs text-fg-subtle underline" onClick={() => setLimit(limit + 50)}>
              显示更多
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const ORDER_FILTERS: [string, string][] = [
  ['', '全部'],
  ['FILLED', '已成交'],
  ['UNKNOWN', '状态未知'],
  ['CANCELED', '已撤销'],
  ['REJECTED', '被拒绝'],
]

function OrdersFull() {
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const q = useQuery<PaperOrder[]>({
    queryKey: ['paper-orders-full', status],
    queryFn: () => getJson(`paper/orders?limit=100${status ? `&status=${status}` : ''}`),
    refetchInterval: 30_000,
  })
  const orders = q.data ?? []
  const color = (st: string) => (st === 'FILLED' ? 'text-[#10b981]' : st === 'UNKNOWN' || st === 'REJECTED' ? 'text-[#ef4444]' : 'text-fg-subtle')
  return (
    <div className={card}>
      <Title
        hint="点开一行可以看到订单每一步的状态变化。订单编号由「策略 + 信号时间 + 币种」组成，同一信号不会重复下单。"
        right={
          <select className="text-xs bg-transparent border border-border-strong rounded px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value)}>
            {ORDER_FILTERS.map(([v, l]) => (
              <option key={v} value={v} className="bg-bg-base-opaque">
                {l}
              </option>
            ))}
          </select>
        }
      >
        订单状态
      </Title>
      {orders.length === 0 ? (
        <div className="text-sm text-fg-muted">没有订单</div>
      ) : (
        <div className="max-h-[420px] overflow-auto space-y-1">
          {orders.map((o) => (
            <div key={o.id} className="border-t border-border-base pt-1">
              <button className="w-full flex items-center gap-2 text-xs text-left" onClick={() => setOpen(open === o.id ? null : o.id)}>
                {open === o.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="whitespace-nowrap w-[88px]">{fmtTime(o.created_at)}</span>
                <span className="w-9">{coin(o.symbol)}</span>
                <span className="whitespace-nowrap w-16">
                  {o.side > 0 ? '买入' : '卖出'}
                  {o.intent === 'open' ? '开仓' : '平仓'}
                </span>
                <span className="font-mono w-20">{fmtPrice(o.fill_px)}</span>
                <span className={`w-14 ${color(o.status)}`}>{o.statusLabel}</span>
                <span className="text-fg-muted truncate">{o.reason}</span>
              </button>
              {open === o.id && <OrderHistory id={o.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OrderHistory({ id }: { id: number }) {
  const q = useQuery<OrderDetail>({ queryKey: ['paper-order', id], queryFn: () => getJson(`paper/orders/${id}`) })
  const o = q.data
  if (!o) return <div className="text-[11px] text-fg-muted pl-5 py-1">加载中…</div>
  return (
    <div className="pl-5 py-1.5 text-[11px] space-y-0.5">
      <div className="text-fg-muted font-mono break-all">编号 {o.client_order_id}</div>
      <div className="text-fg-muted">
        数量 {Number(o.qty).toPrecision(4)} · 参考价 {fmtPrice(o.ref_px)} · 手续费 {usd(o.fee)}
      </div>
      {(o.history ?? []).map((h, i) => (
        <div key={i}>
          {fmtTime(h.ts)} · {h.from} → <b>{h.to}</b> {h.note && <span className="text-fg-muted">（{h.note}）</span>}
        </div>
      ))}
    </div>
  )
}

const LEVELS: [string, string][] = [
  ['', '全部'],
  ['warn,error', '只看告警'],
  ['error', '只看严重'],
]
const TYPE_GROUPS: [string, string][] = [
  ['', '全部类型'],
  ['order,trade', '开平仓'],
  ['risk,auto_pause,auto_resume', '风控 / 自动暂停'],
  ['control,settings', '人工操作 / 参数修改'],
  ['system', '系统启动 / 对账'],
  ['data_sync,data_quality,data_source,regime_change', '数据 / 市场状态'],
]

function AlertCenter() {
  const [levels, setLevels] = useState('')
  const [types, setTypes] = useState('')
  const q = useInfiniteQuery<EventItem[]>({
    queryKey: ['events-full', levels, types],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => getJson(`market/events?limit=50${levels ? `&levels=${levels}` : ''}${types ? `&types=${types}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.length < 50 ? undefined : last[last.length - 1].ts),
    refetchInterval: 30_000,
  })
  const items = (q.data?.pages ?? []).flat()
  const icon = (lv: string) =>
    lv === 'error' ? <XCircle size={14} className="text-[#ef4444]" /> : lv === 'warn' ? <AlertTriangle size={14} className="text-[#f59e0b]" /> : <Info size={14} className="text-[#6366f1]" />
  const sel = 'text-xs bg-transparent border border-border-strong rounded px-2 py-1'
  return (
    <div className={card}>
      <Title
        hint="开平仓、风控触发、自动暂停、人工操作、参数修改、系统重启，全部有记录。红色 = 严重，黄色 = 需要留意。"
        right={
          <div className="flex gap-2">
            <select className={sel} value={levels} onChange={(e) => setLevels(e.target.value)}>
              {LEVELS.map(([v, l]) => (
                <option key={v} value={v} className="bg-bg-base-opaque">
                  {l}
                </option>
              ))}
            </select>
            <select className={sel} value={types} onChange={(e) => setTypes(e.target.value)}>
              {TYPE_GROUPS.map(([v, l]) => (
                <option key={v} value={v} className="bg-bg-base-opaque">
                  {l}
                </option>
              ))}
            </select>
          </div>
        }
      >
        事件与告警
      </Title>
      <div className="max-h-[420px] overflow-auto space-y-2 pr-1">
        {q.isLoading && <div className="text-xs text-fg-muted">加载中…</div>}
        {!q.isLoading && items.length === 0 && <div className="text-xs text-fg-muted">没有符合条件的事件</div>}
        {items.map((e) => (
          <div key={e.id} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(e.level)}</span>
            <div className="min-w-0">
              <div className="text-sm break-words">{e.message}</div>
              <div className="text-[11px] text-fg-muted">
                {fmtTime(e.ts)} · {EVENT_TYPE_NAME[e.type] ?? e.type}
              </div>
            </div>
          </div>
        ))}
        {q.hasNextPage && (
          <button className="text-xs text-fg-subtle underline" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            {q.isFetchingNextPage ? '加载中…' : '加载更早的'}
          </button>
        )}
      </div>
    </div>
  )
}
