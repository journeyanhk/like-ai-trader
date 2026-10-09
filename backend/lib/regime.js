// 市场状态判定 —— 完全由确定性规则计算，不依赖 AI
// regimeSeries 为每一根 1h K 线算出「当时」的状态（只用该 K 线收盘前可见的数据），
// 实时看板与回测共用同一份实现，保证两边结论一致。
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

const H4 = 4 * 3600_000
const H1 = 3600_000

// opts.from：只为下标 ≥ from 的 K 线判定状态（模拟盘增量计算用；所有指标都是因果的，
// 同一段锚定历史上算出来的结果与一次性全量计算逐位相同）
function regimeSeries(bars1h, bars4h, opts = {}) {
  const from = opts.from ?? 0
  const r = cfg.regime
  const n = bars1h.length
  const closes1h = bars1h.map((b) => b.close)
  const closes4h = bars4h.map((b) => b.close)
  const { adx, plusDI, minusDI } = ind.adx(bars1h, r.adxPeriod)
  const atr = ind.atr(bars1h, r.atrPeriod)
  const ema1h = ind.ema(closes1h, r.emaPeriod)
  const ema4h = ind.ema(closes4h, r.emaPeriod)
  const atrPct = atr.map((a, k) => (a == null ? null : (a / bars1h[k].close) * 100))

  // 成交量前缀和
  const pre = new Array(n + 1).fill(0)
  for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + bars1h[k].volume

  const volBars = r.volLookbackDays * 24
  const out = {
    regime: new Array(n).fill('unclear'),
    adx,
    plusDI,
    minusDI,
    atr,
    atrPct,
    atrPctile: new Array(n).fill(null),
    ema1h,
    slope1h: new Array(n).fill(null),
    slope4h: new Array(n).fill(null),
    ema4hAligned: new Array(n).fill(null),
    vol24: new Array(n).fill(null),
    volRatio: new Array(n).fill(null),
    flags: new Array(n).fill(null),
  }

  let j = -1 // 当前 1h K 线收盘时，最近一根已收盘 4h K 线的下标
  for (let i = 0; i < n; i++) {
    const closeT = bars1h[i].ts + H1
    while (j + 1 < bars4h.length && bars4h[j + 1].ts + H4 <= closeT) j++
    if (i < from) continue

    // 波动率分位（过去 90 天）
    if (atrPct[i] != null) {
      let cnt = 0
      let below = 0
      for (let k = Math.max(0, i - volBars + 1); k <= i; k++) {
        const v = atrPct[k]
        if (v == null) continue
        cnt++
        if (v <= atrPct[i]) below++
      }
      if (cnt >= 24 * 30) out.atrPctile[i] = below / cnt
    }
    // 均线斜率
    const lb = r.slopeLookback
    if (i >= lb && ema1h[i] != null && ema1h[i - lb] != null) out.slope1h[i] = ((ema1h[i] - ema1h[i - lb]) / ema1h[i - lb]) * 100
    if (j >= lb && ema4h[j] != null && ema4h[j - lb] != null) out.slope4h[i] = ((ema4h[j] - ema4h[j - lb]) / ema4h[j - lb]) * 100
    if (j >= 0) out.ema4hAligned[i] = ema4h[j]
    // 成交量：最近 24h vs 30 日日均
    if (i >= 23) {
      out.vol24[i] = pre[i + 1] - pre[i - 23]
      const m = Math.min(720, i + 1)
      const avgDaily = ((pre[i + 1] - pre[i + 1 - m]) / m) * 24
      out.volRatio[i] = avgDaily ? out.vol24[i] / avgDaily : null
    }

    if (i < 200 || j < 50) continue
    const a = adx[i]
    const s1 = Math.sign(out.slope1h[i] ?? 0)
    const s4 = Math.sign(out.slope4h[i] ?? 0)
    const flags = {
      lowLiquidity: out.volRatio[i] != null && out.volRatio[i] < r.lowLiqVolumeRatio,
      highVol: out.atrPctile[i] != null && out.atrPctile[i] >= r.highVolPercentile,
      trend: a != null && a > r.trendAdx && s1 !== 0 && s1 === s4,
      range: a != null && a < r.rangeAdx,
    }
    out.flags[i] = flags
    out.regime[i] = flags.lowLiquidity
      ? 'low_liquidity'
      : flags.highVol
        ? 'high_vol'
        : flags.trend
          ? s1 > 0
            ? 'trend_up'
            : 'trend_down'
          : flags.range
            ? 'range'
            : 'unclear'
  }
  return out
}

/** 实时：取最新一根已收盘 K 线的状态，并附上中文理由。opts.spreadPct 为当前盘口价差（仅实时可用） */
function computeRegime(bars1h, bars4h, opts = {}) {
  const r = cfg.regime
  if (bars1h.length < 200 || bars4h.length < 50) {
    return { regime: 'unclear', label: LABELS.unclear, reasons: ['历史数据不足，暂不判断'], metrics: {}, allowedStrategies: [] }
  }
  const s = regimeSeries(bars1h, bars4h)
  const i = bars1h.length - 1
  let regime = s.regime[i]
  const spreadPct = opts.spreadPct ?? null
  const spreadBad = spreadPct != null && spreadPct > r.maxSpreadPct
  if (spreadBad) regime = 'low_liquidity'

  const adxNow = s.adx[i]
  const volRatio = s.volRatio[i]
  const reasons = []
  if (regime === 'low_liquidity') {
    if (volRatio != null && volRatio < r.lowLiqVolumeRatio) reasons.push(`24h 成交量仅为 30 日均值的 ${(volRatio * 100).toFixed(0)}%（< 50%）`)
    if (spreadBad) reasons.push(`盘口价差 ${spreadPct.toFixed(3)}% 超过阈值 ${r.maxSpreadPct}%`)
  } else if (regime === 'high_vol') {
    reasons.push(`波动率（ATR/价格）处于过去 90 天的 ${(s.atrPctile[i] * 100).toFixed(0)} 分位（≥ 80）`)
  } else if (regime === 'trend_up' || regime === 'trend_down') {
    reasons.push(`趋势强度 ADX = ${adxNow.toFixed(1)}（> 25）`)
    reasons.push(`1 小时与 4 小时均线同向${regime === 'trend_up' ? '向上' : '向下'}`)
  } else if (regime === 'range') {
    reasons.push(`趋势强度 ADX = ${adxNow.toFixed(1)}（< 20），缺乏方向`)
  } else {
    if (adxNow != null && adxNow >= r.rangeAdx && adxNow <= r.trendAdx) reasons.push(`ADX = ${adxNow.toFixed(1)}，介于 20~25 之间`)
    else if (adxNow != null && adxNow > r.trendAdx) reasons.push(`ADX = ${adxNow.toFixed(1)} 偏强，但 1 小时与 4 小时均线方向不一致`)
    reasons.push('状态不明确，不开新仓')
  }

  const last = bars1h[i]
  return {
    regime,
    label: LABELS[regime],
    reasons,
    flags: s.flags[i],
    metrics: {
      price: last.close,
      barTs: last.ts,
      adx: adxNow,
      plusDI: s.plusDI[i],
      minusDI: s.minusDI[i],
      atr: s.atr[i],
      atrPct: s.atrPct[i],
      atrPercentile: s.atrPctile[i],
      ema20_1h: s.ema1h[i],
      ema20_4h: s.ema4hAligned[i],
      emaSlope1hPct: s.slope1h[i],
      emaSlope4hPct: s.slope4h[i],
      volume24h: s.vol24[i],
      volumeRatio30d: volRatio,
      spreadPct,
    },
    allowedStrategies: cfg.allowedStrategies[regime] || [],
  }
}

module.exports = { computeRegime, regimeSeries, LABELS }
