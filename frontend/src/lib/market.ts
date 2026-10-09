export interface Check { key: string; label: string; ok: boolean; detail: string }
export interface Live {
  price: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  volume24hBase: number | null
  tickerTs: number | null
  fundingRate8h: number | null
  fundingAnnualized: number | null
  nextFunding: string | null
  markPrice: number | null
  indexPrice: number | null
  openInterestUsd: number | null
  spreadPct: number | null
  errors: string[]
}
export interface Regime {
  regime: 'trend_up' | 'trend_down' | 'range' | 'high_vol' | 'low_liquidity' | 'unclear'
  label: string
  reasons: string[]
  allowedStrategies: string[]
  metrics: {
    adx?: number | null
    atrPct?: number | null
    atrPercentile?: number | null
    emaSlope1hPct?: number | null
    emaSlope4hPct?: number | null
    volumeRatio30d?: number | null
    spreadPct?: number | null
    barTs?: number
  }
}
export interface SymbolData { symbol: string; live: Live; regime: Regime; checks: Check[]; lastBarTs: number | null }
export interface Overview {
  mode: string
  exchange: string
  updatedAt: number
  syncing: boolean
  fearGreed: { ts: number; value: number; classification: string }[]
  symbols: SymbolData[]
}
export interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; ema20: number | null; adx: number | null }
export interface DataStatusItem { id: string; firstTs: number | null; lastTs: number | null; lastRunAt: number | null; count: number; gaps: number; status: string; message: string }
export interface EventItem { id: number; ts: number; level: string; type: string; message: string }

export const fmtPrice = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
export const fmtPct = (v: number | null | undefined, d = 2, sign = true) =>
  v == null ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(d)}%`
export const fmtUsdCompact = (v: number | null | undefined) => {
  if (v == null) return '—'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${v.toLocaleString('en-US')}`
}
export const fmtTime = (ts: number | null | undefined) =>
  ts == null ? '—' : new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
export const fmtDate = (ts: number | null | undefined) =>
  ts == null ? '—' : new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
export const coin = (symbol: string) => symbol.split('/')[0]

export const REGIME_STYLE: Record<string, { color: string; bg: string; hint: string }> = {
  trend_up: { color: '#10b981', bg: 'rgba(16,185,129,0.12)', hint: '行情有明确上涨方向，适合「趋势跟随」策略' },
  trend_down: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', hint: '行情有明确下跌方向，适合「趋势跟随」策略（可做空）' },
  range: { color: '#6366f1', bg: 'rgba(99,102,241,0.14)', hint: '价格来回震荡没有方向，适合「均值回归」策略（低买高卖）' },
  high_vol: { color: '#f59e0b', bg: 'rgba(245,158,11,0.14)', hint: '波动剧烈，止损容易被打穿，系统暂停开新仓' },
  low_liquidity: { color: '#06b6d4', bg: 'rgba(6,182,212,0.12)', hint: '市场交易冷清或买卖价差大，成交成本高，暂停开新仓' },
  unclear: { color: '#aaaaaa', bg: 'rgba(170,170,170,0.12)', hint: '信号互相矛盾，看不清就不做，暂停开新仓' },
}

export const STRATEGY_NAME: Record<string, string> = {
  trend_following: '趋势跟随',
  mean_reversion: '均值回归',
}
