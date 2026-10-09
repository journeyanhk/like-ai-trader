// 模拟盘演练脚本（开发用）：开仓 → 对账 → 紧急停止 → 恢复 → 订单未知 → 回撤锁定 → 解锁 → 日亏停手 → 每小时循环
// 注意：会写入模拟账户，演练后需清空模拟账户表。
const paper = require('../lib/paper')
const okx = require('../lib/okx')
const { S, openPosition, placeOrder, sweepUnknownOrders, riskSweep, saveAcct } = paper._t
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1 }

;(async () => {
  await paper.load(true)
  const q = await okx.quote('BTC/USDT')
  S.quotes['BTC/USDT'] = { ...q, at: Date.now() }
  const t = Date.now()
  const p = await openPosition({ symbol: 'BTC/USDT', sig: { side: 1, stop: q.last * 0.98 }, qty: 0.01, refPx: q.last, strategy: 'trend_following', params: { fast: 20, slow: 50, atrMult: 2.5 }, regime: 'trend_up', signalTs: t, riskAmt: 10, entryTs: t })
  ok(p && S.positions['BTC/USDT'], '开仓成功')
  const dup = await openPosition({ symbol: 'BTC/USDT', sig: { side: 1, stop: q.last * 0.98 }, qty: 0.01, refPx: q.last, strategy: 'trend_following', params: {}, regime: 'trend_up', signalTs: t, riskAmt: 10, entryTs: t })
  ok(dup === null, '同一信号重复下单被拦截（幂等）')
  ok((await paper.reconcile()).ok, '开仓后对账一致')
  const es = await paper.emergencyStop('演练')
  ok(es.closed.length === 1 && !S.positions['BTC/USDT'] && S.acct.status === 'stopped', '紧急停止：平仓 + 停止')
  ok((await paper.resume()).ok && S.acct.status === 'running', '人工恢复运行')

  const placed = await placeOrder({ clientId: `drill-${t}-x`, symbol: 'ETH/USDT', side: 1, intent: 'open', qty: 1, refPx: 2000, reason: '演练', strategy: 'mean_reversion', signalTs: t })
  S.inflight.set(placed.order.client_order_id, Date.now() - 31_000)
  const unk = await sweepUnknownOrders(false)
  ok(unk >= 1, '订单超过 30 秒未知 → 标为 UNKNOWN')
  ok((await paper.resume()).ok, '恢复时按持仓表处理未知订单（撤销）')

  S.acct.peak_equity = S.acct.cash / 0.89
  await riskSweep()
  ok(S.acct.status === 'locked', '回撤超过 10% → 锁定')
  ok((await paper.resume()).ok === false, '锁定状态下「恢复」被拒绝，必须解锁')
  ok((await paper.unlock()).ok && S.acct.status === 'running', '人工解锁')

  S.acct.day_start_equity = S.acct.cash / 0.97
  await riskSweep()
  ok(S.acct.day_blocked === true, '日亏超过 2% → 当日停开新仓')
  S.acct.day_key = 0
  await riskSweep()
  ok(S.acct.day_blocked === false, '新的一天解除')
  await saveAcct()

  const e = await okx.quote('ETH/USDT')
  await openPosition({ symbol: 'ETH/USDT', sig: { side: -1, stop: e.last * 1.03 }, qty: 0.5, refPx: e.last, strategy: 'trend_following', params: { fast: 20, slow: 50, atrMult: 2.5 }, regime: 'trend_down', signalTs: t + 1, riskAmt: 10, entryTs: t - 3 * 3600_000 })
  const c = await paper.runCycle(null, { force: true })
  ok(Array.isArray(c.decisions), '每小时循环在持仓状态下正常运行')
  console.log(JSON.stringify(c.decisions.map((d) => ({ s: d.symbol, a: d.actions, n: d.notes })), null, 1))
  await paper.emergencyStop('演练结束')
  ok((await paper.reconcile()).ok, '最终对账一致')
})().catch((e) => { console.error(e); process.exitCode = 1 })
