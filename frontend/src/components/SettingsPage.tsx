import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Lock, RotateCcw } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtTime, REGIME_STYLE } from '@/lib/market'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'

interface RiskParam { key: string; label: string; min: number; max: number; step: number; unit: string; help: string; value: number; docValue: number }
interface SettingsData {
  mode: string
  risk: RiskParam[]
  readonly: {
    market: { exchange: string; symbols: string[]; mainInterval: string; confirmInterval: string; startingEquity: number }
    costs: { takerPct: number; makerPct: number; slippageBps: number; assumedFundingPct8h: number }
    regime: Record<string, number>
    allowedStrategies: Record<string, string[]>
    pause: { staleDataSeconds: number; priceSourceMaxDeviationPct: number; orderUnknownSeconds: number; maxApiErrors: number; autoResumeHealthyChecks: number; heartbeatMinutes: number; heartbeatMissing: number }
    invalidation: { trades: number; pf: number }
    strategies: { name: string; label: string; version: string; defaults: Record<string, number>; paramLabels: Record<string, string>; description: string }[]
  }
}
interface Change { id: number; ts: number; key: string; label: string; old_value: number; new_value: number; reason: string; source: string }

const REGIME_LABEL: Record<string, string> = { trend_up: '上涨趋势', trend_down: '下跌趋势', range: '震荡', high_vol: '高波动', low_liquidity: '低流动性', unclear: '不明确' }
const STRAT_LABEL: Record<string, string> = { trend_following: '趋势跟随', mean_reversion: '均值回归' }

export default function SettingsPage() {
  const qc = useQueryClient()
  const q = useQuery<SettingsData>({ queryKey: ['settings'], queryFn: () => fetch(api('settings')).then((r) => r.json()) })
  const hist = useQuery<Change[]>({ queryKey: ['settings-history'], queryFn: () => fetch(api('settings/history')).then((r) => r.json()) })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.risk.map((r) => [r.key, String(r.value)])))
  }, [q.data])

  const save = useMutation({
    mutationFn: async (body: unknown) => {
      const r = await fetch(api('settings/risk'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error ?? '保存失败')
      return j
    },
    onSuccess: () => {
      setMsg({ ok: true, text: '已保存并立即生效（模拟交易和回测都会使用新参数），修改已记录。' })
      setReason('')
      qc.invalidateQueries({ queryKey: ['settings'] })
      qc.invalidateQueries({ queryKey: ['settings-history'] })
      qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith('paper') })
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  })

  const d = q.data
  if (q.isLoading) return <div className={card}>加载中…</div>
  if (!d) return <div className={card}>设置加载失败</div>

  const changes = Object.fromEntries(
    d.risk.filter((r) => draft[r.key] !== undefined && Number(draft[r.key]) !== r.value).map((r) => [r.key, Number(draft[r.key])]),
  )
  const dirty = Object.keys(changes).length > 0
  const anyCustom = d.risk.some((r) => r.value !== r.docValue)
  const ro = d.readonly

  return (
    <div className="space-y-4">
      <div className={card}>
        <Title
          icon={<ShieldCheck size={16} className="text-[#10b981]" />}
          hint="只能调得比设计文档更严格（更保守），不能放宽。修改立即生效，必须写原因，所有修改永久留记录。"
        >
          风控参数
        </Title>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {d.risk.map((r) => {
            const v = draft[r.key] ?? String(r.value)
            const n = Number(v)
            const bad = !Number.isFinite(n) || n < r.min || n > r.max
            const changed = !bad && n !== r.value
            return (
              <div key={r.key} className={`border rounded-md p-3 ${changed ? 'border-[#f59e0b]' : 'border-border-base'}`}>
                <div className="text-sm font-bold">{r.label}</div>
                <div className="text-[11px] text-fg-muted mt-0.5 min-h-[28px]">{r.help}</div>
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="range"
                    min={r.min}
                    max={r.max}
                    step={r.step}
                    value={bad ? r.value : n}
                    onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
                    className="flex-1 accent-[#fd4b96]"
                  />
                  <input
                    value={v}
                    onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
                    className={`w-16 text-right font-mono text-sm bg-transparent border rounded px-1.5 py-0.5 ${bad ? 'border-[#ef4444]' : 'border-border-strong'}`}
                  />
                  <span className="text-xs text-fg-muted w-3">{r.unit}</span>
                </div>
                <div className="text-[10px] text-fg-muted mt-1">
                  可调范围 {r.min} ~ {r.max}
                  {r.unit} · 设计文档值 {r.docValue}
                  {r.unit}
                  {r.value !== r.docValue && <span className="text-[#f59e0b]"> · 已收紧</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="修改原因（必填），例如：最近波动大，先把单笔风险降一半"
            className="flex-1 min-w-[240px] text-sm bg-transparent border border-border-strong rounded-md px-3 py-2"
          />
          <button
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ changes, reason })}
            className="px-4 py-2 rounded-md bg-brand-100 text-white text-sm font-bold disabled:opacity-40"
          >
            保存修改{dirty ? `（${Object.keys(changes).length} 项）` : ''}
          </button>
          {dirty && (
            <button className="px-3 py-2 rounded-md border border-border-strong text-sm" onClick={() => setDraft(Object.fromEntries(d.risk.map((r) => [r.key, String(r.value)])))}>
              撤销
            </button>
          )}
          {anyCustom && !dirty && (
            <button
              disabled={save.isPending}
              onClick={() => save.mutate({ reset: true, reason: reason || '恢复设计文档默认值' })}
              className="flex items-center gap-1 px-3 py-2 rounded-md border border-border-strong text-sm"
            >
              <RotateCcw size={14} /> 恢复文档默认值
            </button>
          )}
        </div>
        {msg && <div className={`mt-2 text-sm ${msg.ok ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>{msg.text}</div>}
      </div>

      <div className={card}>
        <Title hint="每一次修改：什么时候、哪个参数、从多少改到多少、为什么。">修改记录</Title>
        {(hist.data ?? []).length === 0 ? (
          <div className="text-sm text-fg-muted">还没有修改过，目前全部使用设计文档的数值。</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-fg-muted">
                <th className="py-1 pr-3">时间</th>
                <th className="pr-3">参数</th>
                <th className="pr-3">修改</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {(hist.data ?? []).map((c) => (
                <tr key={c.id} className="border-t border-border-base">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-xs">{fmtTime(c.ts)}</td>
                  <td className="pr-3">{c.label}</td>
                  <td className="pr-3 font-mono whitespace-nowrap">
                    {String(c.old_value)} → <b>{String(c.new_value)}</b>
                  </td>
                  <td className="text-fg-subtle">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className={card}>
          <Title icon={<Lock size={14} className="text-fg-muted" />} hint="这些参数决定系统的基本行为，网页上只能查看；如需修改请告诉开发者。">
            基本设置（只读）
          </Title>
          <KV
            rows={[
              ['运行模式', `${d.mode}（模拟）——全部验收通过之前不会开放真钱模式`],
              ['行情', `${ro.market.exchange}（免费公开数据）`],
              ['交易标的', ro.market.symbols.join('、')],
              ['周期', `主周期 ${ro.market.mainInterval}，确认周期 ${ro.market.confirmInterval}`],
              ['起始模拟资金', `${ro.market.startingEquity.toLocaleString()} USDT`],
              ['手续费', `吃单 ${ro.costs.takerPct}%，挂单 ${ro.costs.makerPct}%（模拟盘按吃单计）`],
              ['滑点', `${ro.costs.slippageBps} 个基点（${ro.costs.slippageBps / 100}%）`],
              ['资金费', `按 OKX 真实费率；缺历史时保守按每 8 小时 ${ro.costs.assumedFundingPct8h}%`],
              ['策略失效', `最近 ${ro.invalidation.trades} 笔盈亏比 < ${ro.invalidation.pf} 自动下线`],
            ]}
          />
        </div>
        <div className={card}>
          <Title icon={<Lock size={14} className="text-fg-muted" />} hint="出现任何一项都会暂停开新仓（止损照常）。">
            自动暂停条件（只读）
          </Title>
          <KV
            rows={[
              ['行情过期', `超过 ${ro.pause.staleDataSeconds} 秒`],
              ['两个价格源偏差', `超过 ${ro.pause.priceSourceMaxDeviationPct}%`],
              ['接口连续出错', `≥ ${ro.pause.maxApiErrors} 次`],
              ['订单状态未知', `超过 ${ro.pause.orderUnknownSeconds} 秒`],
              ['对账不一致', '本地持仓与订单账本对不上'],
              ['自动恢复', `数据类问题连续 ${ro.pause.autoResumeHealthyChecks} 次检查正常后自动恢复；订单/对账类需人工恢复`],
              ['心跳', `每 ${ro.pause.heartbeatMinutes} 分钟一次，连续缺 ${ro.pause.heartbeatMissing} 次视为宕机`],
            ]}
          />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className={card}>
          <Title icon={<Lock size={14} className="text-fg-muted" />}>市场状态 → 允许的策略（只读）</Title>
          <div className="space-y-1.5">
            {Object.entries(ro.allowedStrategies).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-sm">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ color: REGIME_STYLE[k]?.color, background: REGIME_STYLE[k]?.bg }}>
                  {REGIME_LABEL[k] ?? k}
                </span>
                <span className={v.length ? '' : 'text-fg-muted'}>{v.length ? v.map((x) => STRAT_LABEL[x] ?? x).join('、') : '不开新仓'}</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-fg-muted mt-3">
            判定阈值：ADX &gt; {ro.regime.trendAdx} 为趋势，ADX &lt; {ro.regime.rangeAdx} 为震荡，波动率高于 {ro.regime.volLookbackDays} 天 {Math.round(ro.regime.highVolPercentile * 100)} 分位为高波动，成交量低于均值{' '}
            {Math.round(ro.regime.lowLiqVolumeRatio * 100)}% 或价差 &gt; {ro.regime.maxSpreadPct}% 为低流动性。
          </div>
        </div>
        <div className={card}>
          <Title icon={<Lock size={14} className="text-fg-muted" />}>策略参数（只读，模拟盘使用默认值）</Title>
          <div className="space-y-3">
            {ro.strategies.map((s) => (
              <div key={s.name}>
                <div className="text-sm font-bold">
                  {s.label} <span className="text-[11px] text-fg-muted font-normal">v{s.version}</span>
                </div>
                <div className="text-[11px] text-fg-muted">{s.description}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs">
                  {Object.entries(s.defaults).map(([k, v]) => (
                    <span key={k}>
                      <span className="text-fg-muted">{s.paramLabels?.[k] ?? k}</span> <span className="font-mono">{v}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Title({ children, hint, icon }: { children: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="font-bold flex items-center gap-1.5">
        {icon}
        {children}
      </h3>
      {hint && <p className="text-[11px] text-fg-muted mt-0.5">{hint}</p>}
    </div>
  )
}

function KV({ rows }: { rows: [string, string][] }) {
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 text-sm">
          <span className="text-fg-muted w-28 shrink-0">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  )
}
