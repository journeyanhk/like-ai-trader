import ReactECharts from 'echarts-for-react'
import { CheckCircle2, AlertTriangle, Info, XCircle } from 'lucide-react'
import {
  type SymbolData,
  type Overview,
  type DataStatusItem,
  type EventItem,
  REGIME_STYLE,
  STRATEGY_NAME,
  coin,
  fmtPrice,
  fmtPct,
  fmtUsdCompact,
  fmtTime,
  fmtDate,
} from '@/lib/market'

const card = 'border border-border-strong rounded-lg bg-bg-base-opaque p-4'

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'up' | 'down' }) {
  return (
    <div title={hint}>
      <div className="text-[11px] text-fg-muted">{label}</div>
      <div className={`font-mono text-sm ${tone === 'up' ? 'text-[#10b981]' : tone === 'down' ? 'text-[#ef4444]' : 'text-fg-base'}`}>{value}</div>
    </div>
  )
}

export function SymbolCard({ s }: { s: SymbolData }) {
  const l = s.live
  const st = REGIME_STYLE[s.regime.regime] ?? REGIME_STYLE.unclear
  const ch = l.change24hPct
  const fundingPct = l.fundingRate8h != null ? l.fundingRate8h * 100 : null
  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-fg-subtle">
            {coin(s.symbol)} <span className="text-fg-muted">永续合约</span>
          </div>
          <div className="font-mono text-3xl font-bold text-fg-base mt-1">${fmtPrice(l.price)}</div>
          <div className={`font-mono text-sm mt-0.5 ${ch == null ? 'text-fg-muted' : ch >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}`}>
            {fmtPct(ch)} <span className="text-fg-muted">24 小时</span>
          </div>
        </div>
        <span className="px-3 py-1 rounded-full text-sm font-bold whitespace-nowrap" style={{ color: st.color, background: st.bg }}>
          {s.regime.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-border-base">
        <Stat label="24h 最高" value={fmtPrice(l.high24h)} />
        <Stat label="24h 最低" value={fmtPrice(l.low24h)} />
        <Stat label="未平仓合约" value={fmtUsdCompact(l.openInterestUsd)} hint="市场上还没平掉的合约总价值，越大说明参与者越多" />
        <Stat
          label="资金费率 / 8h"
          value={fundingPct == null ? '—' : `${fundingPct > 0 ? '+' : ''}${fundingPct.toFixed(4)}%`}
          tone={fundingPct == null ? undefined : fundingPct >= 0 ? 'up' : 'down'}
          hint="正数=做多的人付钱给做空的人（多头拥挤）；负数反之"
        />
        <Stat label="资金费率年化" value={l.fundingAnnualized == null ? '—' : fmtPct(l.fundingAnnualized * 100, 1)} />
        <Stat label="买卖价差" value={l.spreadPct == null ? '—' : `${l.spreadPct.toFixed(4)}%`} hint="越小越好，说明成交成本低" />
      </div>
    </div>
  )
}

function MetricRow({ name, value, rule, ok }: { name: string; value: string; rule: string; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border-base last:border-0">
      <div>
        <div className="text-sm text-fg-base">{name}</div>
        <div className="text-[11px] text-fg-muted">{rule}</div>
      </div>
      <div className={`font-mono text-sm ${ok == null ? 'text-fg-subtle' : ok ? 'text-[#f59e0b]' : 'text-fg-subtle'}`}>{value}</div>
    </div>
  )
}

export function RegimeCard({ s }: { s: SymbolData }) {
  const r = s.regime
  const m = r.metrics
  const st = REGIME_STYLE[r.regime] ?? REGIME_STYLE.unclear
  const sameDir =
    m.emaSlope1hPct != null && m.emaSlope4hPct != null ? Math.sign(m.emaSlope1hPct) === Math.sign(m.emaSlope4hPct) : null
  const dirText = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? '向上' : v < 0 ? '向下' : '走平')
  return (
    <div className={card} style={{ borderColor: st.color + '55' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-fg-base">{coin(s.symbol)} 市场状态</h3>
        <span className="text-[11px] text-fg-muted">基于 {fmtTime(m.barTs)} 收盘的 1 小时 K 线</span>
      </div>
      <div className="mt-3 rounded-md p-3" style={{ background: st.bg }}>
        <div className="text-2xl font-black" style={{ color: st.color }}>{r.label}</div>
        <div className="text-sm text-fg-base mt-1">{st.hint}</div>
        <ul className="mt-2 space-y-0.5">
          {r.reasons.map((x) => (
            <li key={x} className="text-xs text-fg-subtle">· {x}</li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-fg-subtle">此状态下允许的策略：</span>
        {r.allowedStrategies.length ? (
          r.allowedStrategies.map((x) => (
            <span key={x} className="px-2 py-0.5 rounded-full text-xs bg-tag-blue-10 text-tag-blue-100">{STRATEGY_NAME[x] ?? x}</span>
          ))
        ) : (
          <span className="px-2 py-0.5 rounded-full text-xs bg-tag-orange-10 text-tag-orange-100">无 · 暂停开新仓</span>
        )}
      </div>
      <div className="mt-3">
        <MetricRow
          name="趋势强度 ADX"
          value={m.adx == null ? '—' : m.adx.toFixed(1)}
          rule="> 25 有趋势；< 20 震荡"
          ok={m.adx == null ? null : m.adx > 25 || m.adx < 20}
        />
        <MetricRow
          name="均线方向（1 小时 / 4 小时）"
          value={`${dirText(m.emaSlope1hPct)} / ${dirText(m.emaSlope4hPct)}`}
          rule="两个周期同向才算趋势"
          ok={sameDir}
        />
        <MetricRow
          name="波动率分位"
          value={m.atrPercentile == null ? '—' : `${Math.round(m.atrPercentile * 100)} 分位`}
          rule="在过去 90 天中排第几；≥ 80 视为高波动"
          ok={m.atrPercentile == null ? null : m.atrPercentile >= 0.8}
        />
        <MetricRow
          name="成交量 vs 30 日均值"
          value={m.volumeRatio30d == null ? '—' : `${Math.round(m.volumeRatio30d * 100)}%`}
          rule="< 50% 视为低流动性"
          ok={m.volumeRatio30d == null ? null : m.volumeRatio30d < 0.5}
        />
      </div>
    </div>
  )
}

export function FearGreedCard({ data }: { data: Overview['fearGreed'] }) {
  const last = data[data.length - 1]
  const prev = data[data.length - 8]
  const v = last?.value
  const color = v == null ? '#aaaaaa' : v >= 75 ? '#10b981' : v >= 55 ? '#84cc16' : v >= 45 ? '#aaaaaa' : v >= 25 ? '#f59e0b' : '#ef4444'
  const zh: Record<string, string> = { 'Extreme Fear': '极度恐惧', Fear: '恐惧', Neutral: '中性', Greed: '贪婪', 'Extreme Greed': '极度贪婪' }
  const option = {
    animation: false,
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: 'category', show: false, data: data.map((d) => d.ts) },
    yAxis: { type: 'value', show: false, min: 0, max: 100 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#171717',
      borderColor: 'rgba(255,255,255,0.12)',
      textStyle: { color: '#e7e7e7', fontSize: 12 },
      formatter: (p: { dataIndex: number }[]) => {
        const d = data[p[0]?.dataIndex]
        return d ? `${fmtDate(d.ts)}<br/><b>${d.value}</b> ${zh[d.classification] ?? d.classification}` : ''
      },
    },
    series: [
      {
        type: 'line',
        data: data.map((d) => d.value),
        symbol: 'none',
        lineStyle: { width: 1.5, color },
        areaStyle: { color, opacity: 0.08 },
        markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: 'rgba(255,255,255,0.15)', type: 'dashed' }, data: [{ yAxis: 50 }] },
      },
    ],
  }
  return (
    <div className={card}>
      <div className="text-sm text-fg-subtle">市场情绪 · 恐惧贪婪指数</div>
      <div className="flex items-end gap-3 mt-1">
        <div className="font-mono text-3xl font-bold" style={{ color }}>{v ?? '—'}</div>
        <div className="pb-1 text-sm font-semibold" style={{ color }}>{last ? zh[last.classification] ?? last.classification : ''}</div>
      </div>
      <div className="text-xs text-fg-muted mt-0.5">
        {prev && v != null ? `一周前 ${prev.value}，${v > prev.value ? '情绪升温' : v < prev.value ? '情绪降温' : '持平'}` : '0 = 极度恐惧，100 = 极度贪婪'}
      </div>
      {data.length > 1 && <ReactECharts option={option} style={{ height: 90, marginTop: 8 }} />}
      <div className="text-[11px] text-fg-muted">近 30 天 · 仅作参考，不参与交易决策</div>
    </div>
  )
}

export function HealthPanel({ symbols, status }: { symbols: SymbolData[]; status: DataStatusItem[] }) {
  const all = symbols.flatMap((s) => s.checks.map((c) => ({ ...c, symbol: coin(s.symbol) })))
  const bad = all.filter((c) => !c.ok)
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-fg-base">数据健康检查</h3>
        {bad.length === 0 ? (
          <span className="text-xs text-[#10b981] flex items-center gap-1"><CheckCircle2 size={14} /> 全部正常</span>
        ) : (
          <span className="text-xs text-[#f59e0b] flex items-center gap-1"><AlertTriangle size={14} /> {bad.length} 项异常</span>
        )}
      </div>
      <p className="text-[11px] text-fg-muted mt-1">这些就是以后「自动暂停交易」的触发条件。现在只做展示，第 3 次交付后会真正拦截下单。</p>
      <div className="mt-3 space-y-1.5">
        {all.map((c) => (
          <div key={c.symbol + c.key} className="flex items-start gap-2 text-sm">
            {c.ok ? <CheckCircle2 size={15} className="text-[#10b981] mt-0.5 shrink-0" /> : <XCircle size={15} className="text-[#ef4444] mt-0.5 shrink-0" />}
            <div>
              <span className="text-fg-base">{c.symbol} · {c.label}</span>
              <div className="text-[11px] text-fg-muted">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
      <h4 className="font-semibold text-fg-base text-sm mt-4 mb-2">历史数据仓库（回测用）</h4>
      <div className="space-y-1">
        {status.length === 0 && <div className="text-xs text-fg-muted">正在首次下载 1 年历史 K 线，约需 1 分钟…</div>}
        {status.map((d) => (
          <div key={d.id} className="flex items-center justify-between text-xs">
            <span className="text-fg-subtle">{d.id.replace('/USDT:', ' · ')}</span>
            <span className="font-mono text-fg-base">
              {d.count?.toLocaleString()} 根 · {fmtDate(d.firstTs)} 起
              <span className={d.status === 'ok' ? 'text-[#10b981] ml-2' : 'text-[#f59e0b] ml-2'}>{d.status === 'ok' ? '无缺口' : d.message}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function EventsPanel({ events }: { events: EventItem[] }) {
  const icon = (lv: string) =>
    lv === 'error' ? <XCircle size={14} className="text-[#ef4444]" /> : lv === 'warn' ? <AlertTriangle size={14} className="text-[#f59e0b]" /> : <Info size={14} className="text-[#6366f1]" />
  return (
    <div className={card}>
      <h3 className="font-bold text-fg-base">系统事件</h3>
      <p className="text-[11px] text-fg-muted mt-1">数据同步、市场状态切换等都会记在这里；以后开平仓、风控触发也会出现。</p>
      <div className="mt-3 space-y-2 max-h-[300px] overflow-auto pr-1">
        {events.length === 0 && <div className="text-xs text-fg-muted">暂无事件</div>}
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-2">
            <span className="mt-0.5">{icon(e.level)}</span>
            <div className="min-w-0">
              <div className="text-sm text-fg-base break-words">{e.message}</div>
              <div className="text-[11px] text-fg-muted">{fmtTime(e.ts)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function RulesExplainer() {
  const rows = [
    ['上涨 / 下跌趋势', 'ADX > 25，且 1 小时和 4 小时的 20 均线同方向', '趋势跟随'],
    ['震荡', 'ADX < 20', '均值回归'],
    ['高波动', '波动率处于过去 90 天的前 20%', '暂停开新仓'],
    ['低流动性', '24h 成交量不足 30 日均值一半，或买卖价差 > 0.05%', '暂停开新仓'],
    ['不明确', '以上都不满足（例如 ADX 在 20~25 之间）', '暂停开新仓'],
  ]
  return (
    <div className={card}>
      <h3 className="font-bold text-fg-base">市场状态是怎么判断的？</h3>
      <p className="text-xs text-fg-muted mt-1">
        全部是固定公式，每小时 K 线收盘后自动计算一次，同样的数据永远得出同样的结论。AI 不参与这一步。判断顺序：先查流动性，再查波动，最后看趋势或震荡。
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-fg-muted">
              <th className="py-1 pr-3 font-normal">状态</th>
              <th className="py-1 pr-3 font-normal">判断规则</th>
              <th className="py-1 font-normal">允许的策略</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([a, b, c]) => (
              <tr key={a} className="border-t border-border-base">
                <td className="py-1.5 pr-3 text-fg-base whitespace-nowrap">{a}</td>
                <td className="py-1.5 pr-3 text-fg-subtle">{b}</td>
                <td className="py-1.5 text-fg-base whitespace-nowrap">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
