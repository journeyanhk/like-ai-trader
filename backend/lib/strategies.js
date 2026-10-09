// 策略库：每个策略都是确定性规则，信号只用 K 线收盘后可见的数据
// 接口：name, version, label, allowedRegimes, defaults, grid, sensitivityKeys,
//       prepare(bars, params) -> 指标, entry(i, ctx) -> {side, stop} | null,
//       exit(i, pos, ctx) -> {reason} | null（可同时更新 pos.stop 实现移动止损）
//       invalidation：失效条件（第 3 次交付在模拟盘中自动执行）
const ind = require('./indicators')

const trendFollowing = {
  name: 'trend_following',
  version: '1.0',
  label: '趋势跟随',
  description: '快均线在慢均线上方且价格回到快均线上方时做多（反之做空），用 ATR 移动止损，均线反向交叉离场。',
  allowedRegimes: ['trend_up', 'trend_down'],
  defaults: { fast: 20, slow: 50, atrMult: 2.5 },
  grid: { fast: [10, 20, 30], slow: [50, 100], atrMult: [2, 3] },
  sensitivityKeys: ['fast', 'slow', 'atrMult'],
  paramLabels: { fast: '快均线周期', slow: '慢均线周期', atrMult: '止损距离（ATR 倍数）' },
  invalidation: '连续 20 笔交易盈亏比 < 1.0 自动下线',
  prepare(bars, p) {
    const c = bars.map((b) => b.close)
    return { emaF: ind.ema(c, Math.round(p.fast)), emaS: ind.ema(c, Math.round(p.slow)), atr: ind.atr(bars, 14) }
  },
  entry(i, { bars, x, p, regime, filter }) {
    const { emaF, emaS, atr } = x
    if (i < 1 || emaS[i - 1] == null || atr[i] == null) return null
    const c = bars[i].close
    const pc = bars[i - 1].close
    const crossUp = emaF[i - 1] <= emaS[i - 1] && emaF[i] > emaS[i]
    const crossDn = emaF[i - 1] >= emaS[i - 1] && emaF[i] < emaS[i]
    const reclaimUp = emaF[i] > emaS[i] && pc <= emaF[i - 1] && c > emaF[i]
    const reclaimDn = emaF[i] < emaS[i] && pc >= emaF[i - 1] && c < emaF[i]
    // 开启市场状态过滤时，方向必须与趋势方向一致
    if ((crossUp || reclaimUp) && (!filter || regime === 'trend_up')) return { side: 1, stop: c - p.atrMult * atr[i] }
    if ((crossDn || reclaimDn) && (!filter || regime === 'trend_down')) return { side: -1, stop: c + p.atrMult * atr[i] }
    return null
  },
  exit(i, pos, { bars, x, p }) {
    const { emaF, emaS, atr } = x
    const c = bars[i].close
    if (atr[i] != null) {
      if (pos.side > 0) pos.stop = Math.max(pos.stop, c - p.atrMult * atr[i])
      else pos.stop = Math.min(pos.stop, c + p.atrMult * atr[i])
    }
    if (pos.side > 0 && emaF[i] < emaS[i]) return { reason: '均线反向' }
    if (pos.side < 0 && emaF[i] > emaS[i]) return { reason: '均线反向' }
    return null
  },
}

const meanReversion = {
  name: 'mean_reversion',
  version: '1.0',
  label: '均值回归',
  description: '价格跌破布林带下轨且 RSI 超卖时做多（反之做空），回到中轨止盈，ATR 固定止损，最多持有 48 小时。',
  allowedRegimes: ['range'],
  defaults: { bbMult: 2, rsiLow: 30, rsiHigh: 70, atrMult: 2, maxBars: 48 },
  grid: { bbMult: [1.8, 2.2], rsiLow: [25, 30, 35], atrMult: [1.5, 2.5] },
  sensitivityKeys: ['bbMult', 'rsiLow', 'atrMult', 'maxBars'],
  paramLabels: { bbMult: '布林带宽度（标准差倍数）', rsiLow: 'RSI 超卖线（超买线对称）', rsiHigh: 'RSI 超买线', atrMult: '止损距离（ATR 倍数）', maxBars: '最长持仓（小时）' },
  invalidation: '连续 20 笔交易盈亏比 < 1.0 自动下线',
  prepare(bars, p) {
    const c = bars.map((b) => b.close)
    return { bb: ind.bollinger(c, 20, p.bbMult), rsi: ind.rsi(c, 14), atr: ind.atr(bars, 14) }
  },
  entry(i, { bars, x, p }) {
    const { bb, rsi, atr } = x
    if (bb.lower[i] == null || rsi[i] == null || atr[i] == null) return null
    const c = bars[i].close
    const hi = p.rsiHigh ?? 100 - p.rsiLow
    if (c < bb.lower[i] && rsi[i] < p.rsiLow) return { side: 1, stop: c - p.atrMult * atr[i] }
    if (c > bb.upper[i] && rsi[i] > hi) return { side: -1, stop: c + p.atrMult * atr[i] }
    return null
  },
  exit(i, pos, { bars, x, p }) {
    const c = bars[i].close
    if (pos.side > 0 && c >= x.bb.mid[i]) return { reason: '回到中轨止盈' }
    if (pos.side < 0 && c <= x.bb.mid[i]) return { reason: '回到中轨止盈' }
    if (i - pos.entryIdx >= Math.round(p.maxBars)) return { reason: '持仓超时' }
    return null
  },
}

// 区间最高 / 最低（不含当前 K 线）
function highest(arr, n, i) {
  let m = -Infinity
  for (let k = i - n; k < i; k++) m = Math.max(m, arr[k])
  return m
}
function lowest(arr, n, i) {
  let m = Infinity
  for (let k = i - n; k < i; k++) m = Math.min(m, arr[k])
  return m
}

// 第 7 次交付：趋势突破（唐奇安通道）
// 研究结论：在 BTC/ETH/SOL/XRP/DOGE 上，各种突破变体的样本外结果都为正（夏普 0.5~1.2），
// 优势来自「多币种分散」而不是精调参数；短线均值回归类策略扣除成本后全部亏损。
const breakout = {
  name: 'breakout',
  version: '1.0',
  label: '趋势突破',
  description: '收盘价突破过去 N 小时最高价、且在 200 小时均线上方时做多（反之做空）；只用 ATR 移动止损离场，让盈利奔跑。',
  allowedRegimes: ['trend_up', 'trend_down'],
  defaults: { lookback: 120, trendLen: 200, atrMult: 4 },
  grid: { lookback: [96, 120, 168], atrMult: [3, 4, 5] },
  sensitivityKeys: ['lookback', 'trendLen', 'atrMult'],
  paramLabels: { lookback: '突破周期（小时）', trendLen: '趋势均线周期', atrMult: '移动止损距离（ATR 倍数）' },
  invalidation: '连续 20 笔交易盈亏比 < 1.0 自动下线',
  prepare(bars, p) {
    const c = bars.map((b) => b.close)
    return { h: bars.map((b) => b.high), l: bars.map((b) => b.low), ema: ind.ema(c, Math.round(p.trendLen)), atr: ind.atr(bars, 14) }
  },
  entry(i, { bars, x, p, regime, filter }) {
    const n = Math.round(p.lookback)
    if (i < n + 1 || x.ema[i] == null || x.atr[i] == null) return null
    const c = bars[i].close
    if (c > highest(x.h, n, i) && c > x.ema[i] && (!filter || regime === 'trend_up')) return { side: 1, stop: c - p.atrMult * x.atr[i] }
    if (c < lowest(x.l, n, i) && c < x.ema[i] && (!filter || regime === 'trend_down')) return { side: -1, stop: c + p.atrMult * x.atr[i] }
    return null
  },
  exit(i, pos, { bars, x, p }) {
    const c = bars[i].close
    if (x.atr[i] != null) pos.stop = pos.side > 0 ? Math.max(pos.stop, c - p.atrMult * x.atr[i]) : Math.min(pos.stop, c + p.atrMult * x.atr[i])
    return null
  },
}

const STRATEGIES = { breakout, trend_following: trendFollowing, mean_reversion: meanReversion }

// 网格展开
function expandGrid(grid, defaults) {
  let combos = [{ ...defaults }]
  for (const [k, vals] of Object.entries(grid)) {
    const next = []
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v })
    combos = next
  }
  // 均值回归：超买线与超卖线对称
  return combos.map((c) => ('rsiLow' in c ? { ...c, rsiHigh: 100 - c.rsiLow } : c)).filter((c) => !(c.fast && c.slow && c.fast >= c.slow))
}

module.exports = { STRATEGIES, expandGrid }
