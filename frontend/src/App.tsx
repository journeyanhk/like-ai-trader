import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, ShieldCheck, Lock } from 'lucide-react'
import { api } from '@/lib/api'
import { type Overview, type DataStatusItem, type EventItem, fmtTime } from '@/lib/market'
import { useState } from 'react'
import MarketPage from '@/components/MarketPage'
import BacktestPage from '@/components/BacktestPage'
import PaperPage from '@/components/PaperPage'
import CockpitPage from '@/components/CockpitPage'
import SettingsPage from '@/components/SettingsPage'
import ReviewPage from '@/components/ReviewPage'

const TABS = [
  { key: 'cockpit', label: '交易驾驶舱', ready: true, step: 4 },
  { key: 'paper', label: '模拟交易 · 风控', ready: true, step: 3 },
  { key: 'market', label: '行情看板', ready: true, step: 1 },
  { key: 'backtest', label: '回测实验室', ready: true, step: 2 },
  { key: 'review', label: 'AI 复盘', ready: true, step: 5 },
  { key: 'settings', label: '设置', ready: true, step: 4 },
  { key: 'accept', label: '验收清单', ready: false, step: 6 },
]

export default function App() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('cockpit')
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
            <span>数据来源：OKX 永续合约（免费公开数据）</span>
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
          {TABS.map((t) => (
            <button
              key={t.key}
              disabled={!t.ready}
              onClick={() => t.ready && setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 ${
                tab === t.key
                  ? 'border-brand-100 text-fg-base font-semibold'
                  : t.ready
                    ? 'border-transparent text-fg-subtle hover:text-fg-base'
                    : 'border-transparent text-fg-disabled cursor-not-allowed'
              }`}
              title={t.ready ? '' : `第 ${t.step} 次交付上线`}
            >
              {!t.ready && <Lock size={11} />}
              {t.label}
              {!t.ready && <span className="text-[10px]">· 第 {t.step} 步</span>}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 py-5 space-y-4">
        {tab === 'market' && <MarketPage overview={overview} status={status} events={events} />}
        {tab === 'backtest' && <BacktestPage />}
        {tab === 'paper' && <PaperPage />}
        {tab === 'cockpit' && <CockpitPage goPaper={() => setTab('paper')} />}
        {tab === 'settings' && <SettingsPage />}
        {tab === 'review' && <ReviewPage />}

        <footer className="text-[11px] text-fg-muted pt-2 pb-6">
          市场状态每小时自动重新计算（K 线收盘后 2 分钟）。所有数据来自免费公开接口，回测为本地计算，不消耗 Surf 点数。AI 复盘使用你的 DeepSeek 账户，AI 不参与下单。交易全部为模拟，不涉及真钱。
        </footer>
      </main>
    </div>
  )
}
