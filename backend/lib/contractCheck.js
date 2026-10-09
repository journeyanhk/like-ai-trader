// 核对 config.contracts 与 OKX 实时合约规格（ctVal / lotSz / minSz）。
// 每日复盘任务会调用；规格变了 → 写一条 risk 告警事件（会推送 Telegram）。
// 只读 OKX 免费公共接口；不改配置（配置属于冻结组，改动需人工确认）。
const cfg = require('./config')

async function checkContracts() {
  const rows = []
  for (const [s, c] of Object.entries(cfg.contracts)) {
    try {
      const j = await (await fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${c.instId}`, { signal: AbortSignal.timeout(10000) })).json()
      const d = j.data?.[0]
      const live = { ctVal: Number(d?.ctVal), lotSz: Number(d?.lotSz), minSz: Number(d?.minSz), state: d?.state }
      const same = ['ctVal', 'lotSz', 'minSz'].every((k) => live[k] === c[k])
      rows.push({ symbol: s, ok: same, config: { ctVal: c.ctVal, lotSz: c.lotSz, minSz: c.minSz }, live })
    } catch (e) {
      rows.push({ symbol: s, ok: null, error: e.message })
    }
  }
  return { ok: rows.every((r) => r.ok === true), rows }
}

async function checkAndAlert() {
  const r = await checkContracts()
  const feed = require('./feed')
  const diff = r.rows.filter((x) => x.ok === false)
  const err = r.rows.filter((x) => x.ok === null)
  if (diff.length) {
    await feed.logEvent('error', 'risk', `合约规格变了：${diff.map((x) => `${x.symbol} 配置 ${JSON.stringify(x.config)} → OKX ${JSON.stringify({ ctVal: x.live.ctVal, lotSz: x.live.lotSz, minSz: x.live.minSz })}`).join('；')}。下单取整可能不准，请人工确认后更新配置`)
  } else if (err.length) {
    await feed.logEvent('warn', 'data_quality', `合约规格核对失败（接口错误）：${err.map((x) => `${x.symbol} ${x.error}`).join('；')}`)
  }
  return r
}

module.exports = { checkContracts, checkAndAlert }
