export interface PauseDef { label: string; auto: boolean }
export interface PaperPosition {
  symbol: string
  side: number
  qty: number
  entry_px: number
  entry_ts: number
  stop: number
  strategy: string
  strategyLabel: string
  regimeLabel: string
  fees: number
  funding: number
  risk_amt: number
  mark: number
  notional: number
  unrealized: number
  stopDistancePct: number
  riskAtStop: number
}
export interface DataCheck { ok: boolean; value: number | null; detail: string }
export interface PaperStatus {
  mode: string
  state: 'running' | 'paused' | 'day_blocked' | 'stopped' | 'locked'
  status: string
  statusReason: string | null
  pauseKeys: string[]
  pauseDefs: Record<string, PauseDef>
  dayBlocked: boolean
  startedAt: number | null
  startingEquity: number
  equity: number
  cash: number
  unrealized: number
  peakEquity: number
  dayStartEquity: number
  gauges: {
    dailyChangePct: number
    dailyLimitPct: number
    drawdownPct: number
    drawdownLimitPct: number
    grossPct: number
    grossLimitPct: number
    leverage: number
    maxLeverage: number
    bySymbolPct: Record<string, number>
    symbolLimitPct: number
    riskPerTradePct: number
  }
  positions: PaperPosition[]
  strategies: { name: string; label: string; enabled: boolean; disabledReason: string | null; allowedRegimes: string[]; invalidation: string }[]
  quotes: Record<string, { last: number; index: number; ts: number; at: number } | null>
  checks: { at: number; per: Record<string, { stale: DataCheck; deviation: DataCheck }>; apiErrors: number; unknown: number } | null
  apiErrors: number
  reconcile: { at: number; ok: boolean; diffs: unknown[] } | null
  lastHeartbeat: number | null
  lastMonitorAt: number | null
  lastCycleAt: number | null
  lastBarTs: number | null
  nextCycleAt: number
  serverTime: number
  booted: boolean
  pauseStats: Record<string, { count: number; lastTs: number }>
}
export interface RiskCheck { key: string; label: string; ok: boolean; detail: string }
export interface Decision {
  symbol: string
  regime: string
  regimeLabel: string
  barTs: number | null
  close: number | null
  fresh: boolean
  nextOpen: number | null
  actions: string[]
  notes: string[]
  signal?: { strategy: string; strategyLabel: string; side: number; stop: number }
  risk?: { approved: boolean; checks: RiskCheck[]; sizing: { qty: number; notional: number; riskAmt: number; limitedBy: string } | null }
}
export interface Cycle { id: number; ts: number; bar_ts: number; summary: { equity: number; status: string; pauseKeys: string[]; dayBlocked: boolean; decisions: Decision[] } }
export interface PaperOrder {
  id: number
  client_order_id: string
  symbol: string
  side: number
  intent: string
  qty: number
  ref_px: number | null
  fill_px: number | null
  fee: number | null
  status: string
  statusLabel: string
  reason: string
  strategyLabel: string
  created_at: number
}
export interface PaperTrade {
  id: number
  symbol: string
  strategyLabel: string
  side: string
  entry_ts: number
  entry_px: number
  exit_ts: number
  exit_px: number
  qty: number
  reason: string
  fees: number
  funding: number
  pnl: number
}

export const STATE_STYLE: Record<PaperStatus['state'], { label: string; color: string; bg: string; hint: string }> = {
  running: { label: '运行中', color: '#10b981', bg: 'rgba(16,185,129,0.12)', hint: '每小时自动检查行情，符合条件且风控通过才会模拟开仓' },
  day_blocked: { label: '今日停手', color: '#f59e0b', bg: 'rgba(245,158,11,0.14)', hint: '今天亏损已达上限，今天不再开新仓；已有持仓照常管理，明天（UTC 0 点）自动恢复' },
  paused: { label: '自动暂停', color: '#f59e0b', bg: 'rgba(245,158,11,0.14)', hint: '检测到数据或系统异常，暂停开新仓；已有持仓的止损照常看守' },
  stopped: { label: '已紧急停止', color: '#ef4444', bg: 'rgba(239,68,68,0.14)', hint: '你按下了紧急停止：所有持仓已平掉，不再开新仓，直到你点「恢复运行」' },
  locked: { label: '回撤锁定', color: '#ef4444', bg: 'rgba(239,68,68,0.14)', hint: '账户从最高点回撤达到 10%，已全部平仓并锁定，必须你手动解锁' },
}

export interface GroupStat {
  key: string
  label: string
  trades: number
  pnl: number
  winRatePct: number | null
  profitFactor: number | null
  avgR: number | null
  avgHoldHours: number | null
}
export interface PaperStats {
  startedAt: number | null
  runningDays: number
  startingEquity: number
  equity: number
  totalReturnPct: number
  maxDrawdownPct: number
  overall: Omit<GroupStat, 'key' | 'label'>
  costs: { fees: number; slippage: number; funding: number }
  byStrategy: GroupStat[]
  bySymbol: GroupStat[]
  bySide: GroupStat[]
  curve: { ts: number; equity: number }[]
  drawdown: { ts: number; dd: number }[]
}
export interface OrderDetail extends PaperOrder {
  history: { ts: number; from: string; to: string; note: string }[]
}
export const EVENT_TYPE_NAME: Record<string, string> = {
  order: '订单',
  trade: '平仓',
  risk: '风控',
  auto_pause: '自动暂停',
  auto_resume: '自动恢复',
  control: '人工操作',
  system: '系统',
  settings: '参数修改',
  data_sync: '数据同步',
  data_quality: '数据质量',
  data_source: '数据源',
  regime_change: '市场状态',
  backtest: '回测',
}
