/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Metrics {
  totalReturnPct: number
  annualReturnPct: number
  sharpe: number
  sortino: number
  maxDrawdownPct: number
  profitFactor: number
  winRatePct: number
  trades: number
  avgHoldHours: number
  endEquity: number
  days: number
}
export interface Trade {
  symbol: string
  strategy: string
  side: 'long' | 'short'
  entryTs: number
  entryPx: number
  exitTs: number
  exitPx: number
  qty: number
  regime: string
  reason: string
  fees: number
  slippage: number
  funding: number
  pnl: number
  riskAmt: number
}
export interface Point { ts: number; equity: number }
export interface Group { key: string; trades: number; pnl: number; winRatePct: number }
export interface Fold {
  trainStart: number
  trainEnd: number
  testEnd: number
  params: Record<string, Record<string, number>>
  inSample: Metrics
  outOfSample: Metrics
  market: { label: string; changePct: number | null }
}
export interface SensRow { strategy: string; param: string; label: string; factor: number; value: number; sharpe: number; totalReturnPct: number; maxDrawdownPct: number; trades: number }
export interface Check { key: string; label: string; value: string | number; pass: boolean }
export interface Totals { fees: number; slippage: number; funding: number; fundingAssumed: number }
export interface LabResult {
  main: {
    metrics: Metrics
    totals: Totals
    locked: { ts: number; equity: number } | null
    dailyLossDays: number
    curve: Point[]
    benchmark: Point[]
    benchmarkReturnPct: number | null
    trades: Trade[]
    tradeCount: number
    byStrategy: Group[]
    byRegime: Group[]
    bySymbol: Group[]
    regimeShare: { regime: string; pct: number }[]
    params: Record<string, Record<string, number>>
  }
  walkforward: null | {
    metrics: Metrics
    curve: Point[]
    from: number
    to: number
    avgInSampleSharpe: number
    coverage: { up: boolean; down: boolean; range: boolean }
    totals: Totals
    folds: Fold[]
  }
  sensitivity: { baseSharpe: number; stable: boolean; rows: SensRow[] }
  checks: Check[]
  assumptions: {
    costs: { takerPct: number; makerPct: number; slippageBps: number; assumedFundingPct8h: number }
    risk: Record<string, number>
    startEquity: number
    fundingHistoryFrom: number | null
    walkforward: { warmupDays: number; trainDays: number; testDays: number; stepDays: number }
  }
}
export interface RunSummary {
  symbols: string[]
  strategies: string[]
  regimeFilter: boolean
  ddLock: boolean
  from: number
  to: number
  totalReturnPct: number
  sharpe: number
  maxDrawdownPct: number
  trades: number
  oosSharpe: number | null
  passed: boolean
  passCount: number
  checkCount: number
}
export interface RunRow {
  id: number
  created_at: string
  status: 'running' | 'done' | 'error'
  request: any
  summary: RunSummary | null
  error: string | null
  duration_ms: number | null
  result?: LabResult
}

export const REGIME_NAME: Record<string, string> = {
  trend_up: '上涨趋势',
  trend_down: '下跌趋势',
  range: '震荡',
  high_vol: '高波动',
  low_liquidity: '低流动性',
  unclear: '不明确',
}
