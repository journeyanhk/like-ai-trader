// 核对 config.contracts 与 OKX 实时合约规格（ctVal/lotSz/minSz）是否一致。运行：node scripts/check-contracts.js
const cfg = require('../lib/config')
;(async () => {
  let bad = 0
  for (const [s, c] of Object.entries(cfg.contracts)) {
    const j = await (await fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${c.instId}`)).json()
    const d = j.data?.[0]
    const live = { ctVal: Number(d?.ctVal), lotSz: Number(d?.lotSz), minSz: Number(d?.minSz) }
    const same = ['ctVal', 'lotSz', 'minSz'].every((k) => live[k] === c[k])
    if (!same) bad++
    console.log(`${same ? 'OK  ' : 'DIFF'} ${s.padEnd(10)} 配置 ${JSON.stringify({ ctVal: c.ctVal, lotSz: c.lotSz, minSz: c.minSz })}  OKX ${JSON.stringify(live)}`)
  }
  process.exitCode = bad ? 1 : 0
})()
