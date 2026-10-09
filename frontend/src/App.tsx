import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldCheck, Lock } from 'lucide-react'
import { api } from '@/lib/api'
import { type Overview, type DataStatusItem, type EventItem, fmtTime } from '@/lib/market'
import PriceChart from '@/components/PriceChart'
import { SymbolCard, RegimeCard, FearGreedCard, HealthPanel, EventsPanel, RulesExplainer } from '@/components/MarketPanels'

const TABS = [
  { key: 'market', label: '行情看板', ready: true },
  { key: 'backtest', label: '回测实验室', ready: false },
  { key: 'paper', label: '模拟交易', ready: false },
  { key: 'cockpit', label: '交易驾驶舱', ready: false },
  { key: 'review', label: 'AI 复盘', ready: false },
  { key: 'accept', label: '验收清单', ready: false },
]

export default function App() {
  const qc = useQueryClient()
  const overview = useQuery<Overview>({
    queryKey: ['overview'],
    queryFn: async () => {
      const r = await fetch(api('market/overview'))
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? '加载失败')
      return r.json()
    },
    refetchInterval: 20_000,
  })
  const status = useQuery<{ syncing: boolean; items: DataStatusItem[] }>({
    queryKey: ['data-status'],
    queryFn: () => fetch(api('market/data-status')).then((r) => r.json()),
    refetchInterval: (q) => (q.state.data?.syncing || overview.data?.syncing ? 5_000 : 60_000),
  })
  const events = useQuery<EventItem[]>({
    queryKey: ['events'],
    queryFn: () => fetch(api('market/events')).then((r) => r.json()),
    refetchInterval: 30_000,
  })
  const sync = useMutation({
    mutationFn: () => fetch(api('market/sync'), { method: 'POST' }).then((r) => r.json()),
    onSuccess: () => setTimeout(() => qc.invalidateQueries(), 3000),
  })

  const o = overview.data
  const syncing = !!(o?.syncing || status.data?.syncing)

  return (
    <div className="min-h-screen bg-bg-chat text-fg-base">
      <header className="border-b border-border-strong bg-bg-chat-nav">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-lg font-black">AI 交易智能体</div>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-tag-cyan-10 text-tag-cyan-100">
              <ShieldCheck size={12} /> 模拟模式 · 不涉及真钱
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-muted">
            <span>数据来源：Binance 永续合约</span>
            <span>更新于 {o ? fmtTime(o.updatedAt) : '—'}</span>
            <button
              onClick={() => sync.mutate()}
              disabled={syncing || sync.isPending}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border-strong text-fg-subtle hover:text-fg-base disabled:opacity-50"
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
              {syncing ? '同步中' : '立即同步'}
            </button>
          </div>
        </div>
        <nav className="max-w-[1400px] mx-auto px-4 flex gap-1 overflow-x-auto">
          {TABS.map((t, i) => (
            <div
              key={t.key}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 ${
                t.ready ? 'border-brand-100 text-fg-base font-semibold' : 'border-transparent text-fg-disabled'
              }`}
              title={t.ready ? '' : `第 ${i + 1} 次交付上线`}
            >
              {!t.ready && <Lock size={11} />}
              {t.label}
              {!t.ready && <span className="text-[10px]">· 第 {i + 1} 步</span>}
            </div>
          ))}
        </nav>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 py-5 space-y-4">
        {overview.isError && (
          <div className="border border-[#ef4444]/40 rounded-lg p-3 text-sm text-[#ef4444]">行情加载失败：{String(overview.error?.message)}，稍后自动重试。</div>
        )}

        {!o ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[220px] rounded-lg bg-bg-subtle animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {o.symbols.map((s) => (
                <SymbolCard key={s.symbol} s={s} />
              ))}
              <FearGreedCard data={o.fearGreed} />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {o.symbols.map((s) => (
                <RegimeCard key={s.symbol} s={s} />
              ))}
            </section>

            <PriceChart symbols={o.symbols.map((s) => s.symbol)} />

            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <HealthPanel symbols={o.symbols} status={status.data?.items ?? []} />
              <EventsPanel events={events.data ?? []} />
              <RulesExplainer />
            </section>
          </>
        )}

        <footer className="text-[11px] text-fg-muted pt-2 pb-6">
          市场状态每小时自动重新计算（K 线收盘后 2 分钟）。本页面只展示行情与判断，不会下单。
        </footer>
      </main>
    </div>
  )
}
