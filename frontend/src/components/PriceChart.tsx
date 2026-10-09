import ReactECharts from 'echarts-for-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { type Bar, coin, fmtPrice } from '@/lib/market'

const fgBase = '#e7e7e7'
const fgSubtle = '#aaaaaa'
const split = 'rgba(255,255,255,0.12)'
const UP = '#10b981'
const DOWN = '#ef4444'

const RANGES = [
  { key: '1h-120', label: '5 天', interval: '1h', limit: 120 },
  { key: '1h-336', label: '2 周', interval: '1h', limit: 336 },
  { key: '4h-180', label: '1 月', interval: '4h', limit: 180 },
  { key: '4h-540', label: '3 月', interval: '4h', limit: 540 },
]

export default function PriceChart({ symbols }: { symbols: string[] }) {
  const [symbol, setSymbol] = useState(symbols[0])
  const [rangeKey, setRangeKey] = useState('1h-120')
  const range = RANGES.find((r) => r.key === rangeKey)!

  const { data, isLoading } = useQuery<{ bars: Bar[] }>({
    queryKey: ['candles', symbol, range.interval, range.limit],
    queryFn: () =>
      fetch(api(`market/candles?symbol=${encodeURIComponent(symbol)}&interval=${range.interval}&limit=${range.limit}`)).then((r) => r.json()),
    refetchInterval: 60_000,
  })
  const bars = data?.bars ?? []
  const labels = bars.map((b) =>
    new Date(b.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
  )

  const option = {
    animation: false,
    grid: [
      { left: 64, right: 16, top: 16, height: '62%' },
      { left: 64, right: 16, top: '78%', bottom: 28 },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [0, 1].map((i) => ({
      type: 'category',
      data: labels,
      gridIndex: i,
      boundaryGap: true,
      axisLine: { show: true, lineStyle: { color: fgSubtle, width: 1 } },
      axisLabel: { color: fgSubtle, show: i === 1, hideOverlap: true },
      axisTick: { show: false },
    })),
    yAxis: [
      { scale: true, gridIndex: 0, axisLabel: { color: fgSubtle }, splitLine: { lineStyle: { type: 'dashed', color: split } } },
      {
        gridIndex: 1,
        min: 0,
        max: (v: { max: number }) => Math.max(50, Math.ceil(v.max / 10) * 10),
        splitNumber: 2,
        axisLabel: { color: fgSubtle },
        splitLine: { lineStyle: { type: 'dashed', color: split } },
      },
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#171717',
      borderColor: 'rgba(255,255,255,0.12)',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: fgBase, fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);',
      formatter: (params: { dataIndex: number; axisValueLabel: string }[]) => {
        const b = bars[params[0]?.dataIndex]
        if (!b) return ''
        const row = (name: string, val: string, color: string) =>
          `<div style="display:flex;justify-content:space-between;gap:16px;align-items:center"><div style="display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:2.5px;border-radius:1px;background:${color}"></span><span style="color:${fgSubtle}">${name}</span></div><span style="font-weight:600">${val}</span></div>`
        const c = b.close >= b.open ? UP : DOWN
        return (
          `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValueLabel}</div>` +
          row('开盘', fmtPrice(b.open), c) +
          row('最高', fmtPrice(b.high), c) +
          row('最低', fmtPrice(b.low), c) +
          row('收盘', fmtPrice(b.close), c) +
          row('20 均线', fmtPrice(b.ema20), '#f59e0b') +
          row('趋势强度 ADX', b.adx == null ? '—' : b.adx.toFixed(1), '#6366f1')
        )
      },
    },
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
    series: [
      {
        name: 'K 线',
        type: 'candlestick',
        data: bars.map((b) => [b.open, b.close, b.low, b.high]),
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
      },
      {
        name: '20 均线',
        type: 'line',
        data: bars.map((b) => b.ema20),
        symbol: 'none',
        smooth: false,
        lineStyle: { width: 1.5, color: '#f59e0b' },
      },
      {
        name: 'ADX',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: bars.map((b) => b.adx),
        symbol: 'none',
        lineStyle: { width: 1.5, color: '#6366f1' },
        markLine: {
          symbol: 'none',
          silent: true,
          label: { color: fgSubtle, formatter: '{b}', position: 'insideEndTop', fontSize: 10 },
          data: [
            { name: '25 以上=有趋势', yAxis: 25, lineStyle: { color: UP, type: 'dashed', width: 1 } },
            { name: '20 以下=震荡', yAxis: 20, lineStyle: { color: '#aaaaaa', type: 'dashed', width: 1 } },
          ],
        },
      },
    ],
  }

  return (
    <div className="border border-border-strong rounded-lg bg-bg-base-opaque p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="font-bold text-fg-base">价格走势</h3>
          <p className="text-xs text-fg-muted">上图：K 线 + 橙色 20 均线；下图：紫线为趋势强度（ADX）</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Seg options={symbols.map((s) => ({ key: s, label: coin(s) }))} value={symbol} onChange={setSymbol} />
          <Seg options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={rangeKey} onChange={setRangeKey} />
        </div>
      </div>
      {isLoading || bars.length === 0 ? (
        <div className="h-[420px] rounded bg-bg-subtle animate-pulse" />
      ) : (
        <ReactECharts option={option} style={{ height: 420 }} notMerge />
      )}
    </div>
  )
}

function Seg({ options, value, onChange }: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border-strong p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-3 py-1 text-xs rounded ${value === o.key ? 'bg-bg-subtle text-fg-base font-semibold' : 'text-fg-subtle hover:text-fg-base'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
