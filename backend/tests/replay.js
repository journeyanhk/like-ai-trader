// 测试用：历史回放行情（只暴露时钟时刻之前已收盘的 K 线和已结算的资金费），不碰正式账户
const feed = require('../lib/feed')

const H1 = 3600_000

async function retry(fn, n = 5) {
  for (let k = 0; ; k++) {
    try {
      return await fn()
    } catch (e) {
      if (k >= n) throw e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

// 二分：第一个 ts >= x 的下标
function lb(arr, x) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m].ts < x) lo = m + 1
    else hi = m
  }
  return lo
}

/** clock = { t, quote?: { [symbol]: 价格覆盖（演练盘中止损用） } } */
function replayMarket(raw, clock) {
  const ivMs = { '1h': H1, '4h': 4 * H1 }
  return {
    now: () => clock.t,
    async bars(s, iv, from, to) {
      const arr = raw[s][iv]
      const out = []
      for (let k = lb(arr, from); k < arr.length && arr[k].ts < to; k++) if (arr[k].ts + ivMs[iv] <= clock.t) out.push(arr[k])
      return out
    },
    async funding(s, from, to) {
      const arr = raw[s].funding
      const out = []
      for (let k = lb(arr, from); k < arr.length && arr[k].ts < to; k++) if (arr[k].ts <= clock.t) out.push(arr[k])
      return out
    },
    async currentBar(s) {
      const ts = Math.floor(clock.t / H1) * H1
      const b = raw[s]['1h'][lb(raw[s]['1h'], ts)]
      if (!b || b.ts !== ts) throw new Error('no bar')
      return { ts, open: b.open }
    },
    async quote(s) {
      const b = await this.currentBar(s)
      const px = clock.quote?.[s] ?? b.open
      return { symbol: s, last: px, index: px, ts: clock.t }
    },
  }
}

async function loadRaw(symbols, anchorTs, end) {
  const raw = {}
  for (const s of symbols) {
    const [b1, b4, f] = await Promise.all([
      retry(() => feed.loadBarsRange(s, '1h', anchorTs, end + H1)),
      retry(() => feed.loadBarsRange(s, '4h', anchorTs, end + H1)),
      retry(() => feed.loadFunding(s)),
    ])
    raw[s] = { '1h': b1, '4h': b4, funding: f }
  }
  return raw
}

module.exports = { retry, lb, replayMarket, loadRaw, H1 }
