import type { UseQueryResult } from '@tanstack/react-query'
import { type Overview, type DataStatusItem, type EventItem } from '@/lib/market'
import PriceChart from '@/components/PriceChart'
import { SymbolCard, RegimeCard, FearGreedCard, HealthPanel, EventsPanel, RulesExplainer } from '@/components/MarketPanels'

export default function MarketPage({
  overview,
  status,
  events,
}: {
  overview: UseQueryResult<Overview>
  status: UseQueryResult<{ syncing: boolean; items: DataStatusItem[] }>
  events: UseQueryResult<EventItem[]>
}) {
  const o = overview.data
  return (
    <>
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

          <section className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
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

    </>
  )
}
