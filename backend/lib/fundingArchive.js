// P1-4 资金费率历史回填：OKX 官方历史数据下载（免费、无需密钥）
//   列表：GET /api/v5/public/market-data-history?module=3（资金费率）&instType=SWAP&instFamilyList=BTC-USDT&dateAggrType=monthly
//   文件：static.okx.com/.../swaprates/monthly/YYYYMM/BTC-USDT-SWAP-fundingrates-YYYY-MM.zip（CSV：instrument_name,funding_rate,funding_time）
// REST 接口只保留约 3 个月，更早的从这里补。
const zlib = require('zlib')
const { dbQuery } = require('@surf-ai/sdk/db')

const MONTH = 30 * 86400_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url, tries = 4) {
  let err
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const j = await r.json()
      if (j.code !== '0') throw new Error(`OKX ${j.code}: ${j.msg}`)
      return j.data
    } catch (e) {
      err = e
      await sleep(600 * 2 ** k)
    }
  }
  throw err
}

/** 极简 ZIP 解析（只读中央目录 + deflate/store），避免引入新依赖 */
function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = {}
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString()
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.slice(start, start + csize)
    out[name] = method === 0 ? data : zlib.inflateRawSync(data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function parseCsv(text, instId) {
  const rows = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [inst, rate, ts] = line.split(',')
    if (inst !== instId || !ts) continue
    const r = Number(rate)
    const t = Number(ts)
    if (Number.isFinite(r) && Number.isFinite(t)) rows.push({ ts: t, rate: r })
  }
  return rows
}

/** 列出 [fromMs, toMs] 内的月度文件（接口单次跨度 ≤ 10 个月，分段查询） */
async function listMonthly(symbol, fromMs, toMs) {
  const fam = symbol.replace('/', '-')
  const files = new Map()
  for (let a = fromMs; a < toMs; a += 9 * MONTH) {
    const b = Math.min(toMs, a + 9 * MONTH)
    const data = await getJson(`https://www.okx.com/api/v5/public/market-data-history?module=3&instType=SWAP&instFamilyList=${fam}&dateAggrType=monthly&begin=${a}&end=${b}`)
    for (const d of data ?? []) for (const det of d.details ?? []) for (const g of det.groupDetails ?? []) files.set(g.filename, g.url)
    await sleep(200)
  }
  return [...files.entries()].sort().map(([filename, url]) => ({ filename, url }))
}

async function insertRates(symbol, list) {
  let n = 0
  for (let k = 0; k < list.length; k += 500) {
    const part = list.slice(k, k + 500)
    const vals = part.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`).join(',')
    const params = part.flatMap((f) => [`${symbol}:${f.ts}`, symbol, f.ts, f.rate])
    for (let t = 0; ; t++) {
      try {
        const r = await dbQuery(`INSERT INTO funding_rates (id, symbol, ts, rate) VALUES ${vals} ON CONFLICT (id) DO NOTHING RETURNING id`, params)
        n += r.rows.length
        break
      } catch (e) {
        if (t >= 4) throw e
        await sleep(1500)
      }
    }
  }
  return n
}

/**
 * 回填某个币 [fromMs, 现在] 的资金费率。已有的行不覆盖（ON CONFLICT DO NOTHING），
 * 与 REST 重叠的月份用于核对两边是否一致。
 */
async function backfill(symbol, fromMs, { log = () => {} } = {}) {
  const files = await listMonthly(symbol, fromMs - 31 * 86400_000, Date.now()) // 往前多查一个月，确保起始月文件在列表里
  const instId = `${symbol.replace('/', '-')}-SWAP`
  const existing = new Map((await dbQuery('SELECT ts::float8 AS ts, rate FROM funding_rates WHERE symbol=$1 ORDER BY ts LIMIT 5000', [symbol])).rows.map((r) => [Number(r.ts), Number(r.rate)]))
  let fetched = 0
  let inserted = 0
  let overlap = 0
  let mismatch = 0
  for (const f of files) {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) {
      log(`${f.filename}：下载失败 HTTP ${r.status}`)
      continue
    }
    const zip = unzip(Buffer.from(await r.arrayBuffer()))
    const rows = Object.values(zip).flatMap((b) => parseCsv(b.toString(), instId)).filter((x) => x.ts >= fromMs)
    for (const x of rows) {
      if (existing.has(x.ts)) {
        overlap++
        if (existing.get(x.ts) !== x.rate) mismatch++
      }
    }
    fetched += rows.length
    inserted += await insertRates(symbol, rows)
    await sleep(150)
  }
  return { symbol, files: files.length, fetched, inserted, overlap, mismatch }
}

module.exports = { backfill, unzip, parseCsv, listMonthly }
