// 免费公开行情源：OKX 公共 API（无需密钥、不消耗 Surf 点数）
// 恐惧贪婪指数：alternative.me 公共 API（免费）
const BASE = 'https://www.okx.com/api/v5'

const instId = (symbol) => `${symbol.replace('/', '-')}-SWAP` // BTC/USDT -> BTC-USDT-SWAP
const indexId = (symbol) => symbol.replace('/', '-') // BTC/USDT -> BTC-USDT
const BAR = { '1h': '1H', '4h': '4H' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(path, params = {}, tries = 4) {
  const qs = new URLSearchParams(params).toString()
  let err
  for (let k = 0; k < tries; k++) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 10_000) // 超时
      const r = await fetch(`${BASE}/${path}${qs ? `?${qs}` : ''}`, { signal: ctl.signal })
      clearTimeout(t)
      const j = await r.json()
      if (r.status === 429 || j.code === '50011') throw new Error('限频')
      if (j.code !== '0') throw new Error(`OKX ${j.code}: ${j.msg}`)
      return j.data
    } catch (e) {
      err = e
      await sleep(500 * 2 ** k) // 指数退避
    }
  }
  throw err
}

const num = (v) => (v === '' || v == null ? null : Number(v))

/**
 * 拉取 K 线：从现在往回翻页，直到早于 sinceMs。只返回已收盘（confirm=1）的 K 线，升序。
 */
async function candlesSince(symbol, interval, sinceMs) {
  const out = []
  let after = null
  for (let guard = 0; guard < 200; guard++) {
    const params = { instId: instId(symbol), bar: BAR[interval], limit: '100' }
    if (after) params.after = String(after)
    const rows = await get('market/history-candles', params)
    if (!rows?.length) break
    for (const c of rows) {
      const ts = Number(c[0])
      if (ts < sinceMs) continue
      if (c[8] !== '1') continue // 未收盘的 K 线不要
      out.push({ ts, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[6] /* 以币计的成交量 */ })
    }
    const oldest = Number(rows[rows.length - 1][0])
    if (oldest <= sinceMs) break
    after = oldest
    await sleep(120) // 遵守限频（20 次 / 2 秒）
  }
  return out.sort((a, b) => a.ts - b.ts)
}

async function snapshot(symbol) {
  const id = instId(symbol)
  const safe = (p) => p.catch((e) => ({ __error: e.message }))
  const [tk, fr, oi, idx, bk] = await Promise.all([
    safe(get('market/ticker', { instId: id })),
    safe(get('public/funding-rate', { instId: id })),
    safe(get('public/open-interest', { instType: 'SWAP', instId: id })),
    safe(get('market/index-tickers', { instId: indexId(symbol) })),
    safe(get('market/books', { instId: id, sz: '1' })),
  ])
  const t = Array.isArray(tk) ? tk[0] : null
  const f = Array.isArray(fr) ? fr[0] : null
  const o = Array.isArray(oi) ? oi[0] : null
  const i = Array.isArray(idx) ? idx[0] : null
  const b = Array.isArray(bk) ? bk[0] : null
  const last = num(t?.last)
  const open24 = num(t?.open24h)
  const bid = num(b?.bids?.[0]?.[0])
  const ask = num(b?.asks?.[0]?.[0])
  const mid = bid && ask ? (bid + ask) / 2 : null
  const rate = num(f?.fundingRate)
  const periodH = f?.nextFundingTime && f?.fundingTime ? (Number(f.nextFundingTime) - Number(f.fundingTime)) / 3600_000 : 8
  return {
    price: last,
    change24hPct: last && open24 ? ((last - open24) / open24) * 100 : null,
    high24h: num(t?.high24h),
    low24h: num(t?.low24h),
    volume24hBase: num(t?.volCcy24h),
    tickerTs: num(t?.ts),
    fundingRate8h: rate == null ? null : (rate * 8) / (periodH || 8),
    fundingAnnualized: rate == null ? null : (rate * 24 * 365) / (periodH || 8),
    nextFunding: f?.fundingTime ? new Date(Number(f.fundingTime)).toISOString() : null,
    markPrice: null,
    indexPrice: num(i?.idxPx),
    openInterestUsd: num(o?.oiUsd),
    spreadPct: mid ? ((ask - bid) / mid) * 100 : null,
    errors: [tk, fr, oi, idx, bk].filter((x) => x?.__error).map((x) => x.__error),
  }
}

async function fearGreed(days = 31) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 10_000)
  const r = await fetch(`https://api.alternative.me/fng/?limit=${days}`, { signal: ctl.signal })
  clearTimeout(t)
  const j = await r.json()
  return (j?.data ?? [])
    .filter((x) => x?.timestamp && x?.value)
    .map((x) => ({ ts: Number(x.timestamp) * 1000, value: Number(x.value), classification: x.value_classification ?? '' }))
    .sort((a, b) => a.ts - b.ts)
}

module.exports = { candlesSince, snapshot, fearGreed }
