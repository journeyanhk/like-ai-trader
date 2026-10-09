// P1-4：从 OKX 官方月度历史文件回填资金费率（默认回填到 historyDays，至少 400 天）。运行：node scripts/backfill-funding.js [天数]
const cfg = require('../lib/config')
const { backfill } = require('../lib/fundingArchive')
const { dbQuery } = require('@surf-ai/sdk/db')
const DAY = 86400_000
;(async () => {
  const days = Math.max(400, Number(process.argv[2]) || cfg.historyDays)
  const from = Date.now() - days * DAY
  for (const s of cfg.symbols) {
    const r = await backfill(s, from, { log: console.log })
    console.log(`${s}：${r.files} 个月度文件，读到 ${r.fetched} 条，新写入 ${r.inserted} 条；与已有 REST 数据重叠 ${r.overlap} 条，费率不一致 ${r.mismatch} 条`)
  }
  const { rows } = await dbQuery(`SELECT symbol, COUNT(*)::int AS n, MIN(ts)::float8 AS a, MAX(ts)::float8 AS b FROM funding_rates GROUP BY symbol ORDER BY symbol`)
  console.log('\n回填后：')
  for (const r of rows) {
    const span = (r.b - r.a) / DAY
    // 每 8 小时一条：检查缺口
    console.log(`  ${r.symbol.padEnd(10)} ${r.n} 条  ${new Date(r.a).toISOString().slice(0, 10)} → ${new Date(r.b).toISOString().slice(0, 10)}  覆盖 ${span.toFixed(0)} 天  理论条数 ${Math.round(span * 3) + 1}`)
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
