// 市场状态判定 —— 完全由确定性规则计算，不依赖 AI
const cfg = require('./config')
const ind = require('./indicators')

const LABELS = {
  trend_up: '上涨趋势',
  trend_down: '下跌趋势',
  range: '震荡',
  high_vol: '高波动',
  low_liquidity: '低流动性',
  unclear: '不明确',
}

function slopeSign(series, lookback) {
  const n = series.length
  const a = series[n - 1]
  const b = series[n - 1 - lookback]
  if (a == null || b == null) return { sign: 0, pct: null }
  const pct = ((a - b) / b) * 100
  return { sign: Math.sign(a - b), pct }
}

/**
 * @param bars1h 已收盘 1h K 线（升序，建议 ≥ 90 天）
 * @param bars4h 已收盘 4h K 线（升序）
 * @param opts { spreadPct } 当前盘口价差（%），可选
 * @param upto  只使用到该下标为止的数据（回测时用，防止未来数据）
 */
function computeRegime(bars1h, bars4h, opts = {}) {
  const r = cfg.regime
  if (bars1h.length < 200 || bars4h.length < 50) {
    return { regime: 'unclear', label: LABELS.unclear, reasons: ['历史数据不足，暂不判断'], metrics: {}, allowedStrategies: [] }
  }
  const closes1h = bars1h.map((b) => b.close)
  const closes4h = bars4h.map((b) => b.close)
  const last = bars1h[bars1h.length - 1]

  const { adx, plusDI, minusDI } = ind.adx(bars1h, r.adxPeriod)
  const atr = ind.atr(bars1h, r.atrPeriod)
  const ema1h = ind.ema(closes1h, r.emaPeriod)
  const ema4h = ind.ema(closes4h, r.emaPeriod)

  const i = bars1h.length - 1
  const adxNow = adx[i]
  const atrPctSeries = atr.map((a, k) => (a == null ? null : (a / bars1h[k].close) * 100))
  const atrPctNow = atrPctSeries[i]
  const volBars = r.volLookbackDays * 24
  const atrPctile = ind.percentileRank(atrPctSeries.slice(-volBars), atrPctNow)

  const s1 = slopeSign(ema1h, r.slopeLookback)
  const s4 = slopeSign(ema4h, r.slopeLookback)

  // 成交量：最近 24 根 1h vs 过去 30 天日均
  const vol24h = bars1h.slice(-24).reduce((s, b) => s + b.volume, 0)
  const last30 = bars1h.slice(-24 * 30)
  const avgDaily30 = (last30.reduce((s, b) => s + b.volume, 0) / last30.length) * 24
  const volRatio = avgDaily30 ? vol24h / avgDaily30 : null
  const spreadPct = opts.spreadPct ?? null

  const flags = {
    lowLiquidity: (volRatio != null && volRatio < r.lowLiqVolumeRatio) || (spreadPct != null && spreadPct > r.maxSpreadPct),
    highVol: atrPctile != null && atrPctile >= r.highVolPercentile,
    trend: adxNow != null && adxNow > r.trendAdx && s1.sign !== 0 && s1.sign === s4.sign,
    range: adxNow != null && adxNow < r.rangeAdx,
  }

  const reasons = []
  let regime
  if (flags.lowLiquidity) {
    regime = 'low_liquidity'
    if (volRatio != null && volRatio < r.lowLiqVolumeRatio) reasons.push(`24h 成交量仅为 30 日均值的 ${(volRatio * 100).toFixed(0)}%（< 50%）`)
    if (spreadPct != null && spreadPct > r.maxSpreadPct) reasons.push(`盘口价差 ${spreadPct.toFixed(3)}% 超过阈值 ${r.maxSpreadPct}%`)
  } else if (flags.highVol) {
    regime = 'high_vol'
    reasons.push(`波动率（ATR/价格）处于过去 90 天的 ${(atrPctile * 100).toFixed(0)} 分位（≥ 80）`)
  } else if (flags.trend) {
    regime = s1.sign > 0 ? 'trend_up' : 'trend_down'
    reasons.push(`趋势强度 ADX = ${adxNow.toFixed(1)}（> 25）`)
    reasons.push(`1 小时与 4 小时均线同向${s1.sign > 0 ? '向上' : '向下'}`)
  } else if (flags.range) {
    regime = 'range'
    reasons.push(`趋势强度 ADX = ${adxNow.toFixed(1)}（< 20），缺乏方向`)
  } else {
    regime = 'unclear'
    if (adxNow != null && adxNow >= r.rangeAdx && adxNow <= r.trendAdx) reasons.push(`ADX = ${adxNow.toFixed(1)}，介于 20~25 之间`)
    else if (adxNow != null && adxNow > r.trendAdx) reasons.push(`ADX = ${adxNow.toFixed(1)} 偏强，但 1 小时与 4 小时均线方向不一致`)
    reasons.push('状态不明确，不开新仓')
  }

  const metrics = {
    price: last.close,
    barTs: last.ts,
    adx: adxNow,
    plusDI: plusDI[i],
    minusDI: minusDI[i],
    atr: atr[i],
    atrPct: atrPctNow,
    atrPercentile: atrPctile,
    ema20_1h: ema1h[i],
    ema20_4h: ema4h[ema4h.length - 1],
    emaSlope1hPct: s1.pct,
    emaSlope4hPct: s4.pct,
    volume24h: vol24h,
    volumeRatio30d: volRatio,
    spreadPct,
  }

  return {
    regime,
    label: LABELS[regime],
    reasons,
    flags,
    metrics,
    allowedStrategies: cfg.allowedStrategies[regime] || [],
  }
}

module.exports = { computeRegime, LABELS }
