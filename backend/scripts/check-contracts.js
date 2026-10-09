// 核对 config.contracts 与 OKX 实时合约规格（ctVal/lotSz/minSz）是否一致。运行：node scripts/check-contracts.js
// 每日复盘任务也会自动跑一次（lib/contractCheck.js），不一致会发告警。
const { checkContracts } = require('../lib/contractCheck')
checkContracts().then((r) => {
  for (const x of r.rows) console.log(`${x.ok ? 'OK  ' : x.ok === null ? 'ERR ' : 'DIFF'} ${x.symbol.padEnd(10)} 配置 ${JSON.stringify(x.config || {})}  OKX ${JSON.stringify(x.live || x.error)}`)
  process.exitCode = r.ok ? 0 : 1
})
