// 确定性技术指标（纯函数，回测与实时共用同一份实现）
// 输入 bars: [{ ts, open, high, low, close, volume }]，按时间升序

function ema(values, period) {
  const out = new Array(values.length).fill(null)
  const k = 2 / (period + 1)
  let prev = null
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue
    if (prev === null) {
      let s = 0
      for (let j = i - period + 1; j <= i; j++) s += values[j]
      prev = s / period
    } else {
      prev = values[i] * k + prev * (1 - k)
    }
    out[i] = prev
  }
  return out
}

function sma(values, period) {
  const out = new Array(values.length).fill(null)
  let s = 0
  for (let i = 0; i < values.length; i++) {
    s += values[i]
    if (i >= period) s -= values[i - period]
    if (i >= period - 1) out[i] = s / period
  }
  return out
}

function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low
    const pc = bars[i - 1].close
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  })
}

// Wilder 平滑
function wilder(values, period, startIdx = 0) {
  const out = new Array(values.length).fill(null)
  let prev = null
  for (let i = startIdx; i < values.length; i++) {
    const n = i - startIdx + 1
    if (n < period) continue
    if (prev === null) {
      let s = 0
      for (let j = i - period + 1; j <= i; j++) s += values[j]
      prev = s / period
    } else {
      prev = (prev * (period - 1) + values[i]) / period
    }
    out[i] = prev
  }
  return out
}

function atr(bars, period = 14) {
  return wilder(trueRange(bars), period, 1)
}

function adx(bars, period = 14) {
  const len = bars.length
  const plusDM = new Array(len).fill(0)
  const minusDM = new Array(len).fill(0)
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high
    const down = bars[i - 1].low - bars[i].low
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }
  const tr = trueRange(bars)
  const sTR = wilder(tr, period, 1)
  const sPlus = wilder(plusDM, period, 1)
  const sMinus = wilder(minusDM, period, 1)
  const dx = new Array(len).fill(null)
  const plusDI = new Array(len).fill(null)
  const minusDI = new Array(len).fill(null)
  let firstDx = -1
  for (let i = 0; i < len; i++) {
    if (sTR[i] == null || !sTR[i]) continue
    const p = (100 * sPlus[i]) / sTR[i]
    const m = (100 * sMinus[i]) / sTR[i]
    plusDI[i] = p
    minusDI[i] = m
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m)
    if (firstDx < 0) firstDx = i
  }
  const adxArr = firstDx < 0 ? new Array(len).fill(null) : wilder(dx.map((v) => v ?? 0), period, firstDx)
  return { adx: adxArr, plusDI, minusDI }
}

function rsi(values, period = 14) {
  const len = values.length
  const gains = new Array(len).fill(0)
  const losses = new Array(len).fill(0)
  for (let i = 1; i < len; i++) {
    const d = values[i] - values[i - 1]
    gains[i] = d > 0 ? d : 0
    losses[i] = d < 0 ? -d : 0
  }
  const ag = wilder(gains, period, 1)
  const al = wilder(losses, period, 1)
  return ag.map((g, i) => (g == null || al[i] == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])))
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period)
  const upper = new Array(values.length).fill(null)
  const lower = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    let s = 0
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2
    const sd = Math.sqrt(s / period)
    upper[i] = mid[i] + mult * sd
    lower[i] = mid[i] - mult * sd
  }
  return { mid, upper, lower }
}

// 当前值在历史样本中的分位（0~1）
function percentileRank(sample, value) {
  const xs = sample.filter((v) => v != null && Number.isFinite(v))
  if (!xs.length) return null
  let below = 0
  for (const v of xs) if (v <= value) below++
  return below / xs.length
}

module.exports = { ema, sma, atr, adx, rsi, bollinger, trueRange, percentileRank }
