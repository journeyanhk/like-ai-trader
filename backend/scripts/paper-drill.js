// 模拟盘演练（开发用）：用真实历史回放驱动真正的 paper 主循环，内存存储，不碰正式账户。
// 覆盖：开仓 → 对账 → 重复订单拦截 → 盘中止损 → 紧急停止/恢复 → 订单未知 → 回撤锁定/解锁 → 日亏停手 → 跨日解除
// 运行：cd backend && node scripts/paper-drill.js
const cfg = require('../lib/config')
const feed = require('../lib/feed')
const sim = require('../lib/simulate')
const { createPaper, anchorFor } = require('../lib/paper')
const { memoryStore } = require('../lib/paperStore')
const { retry, replayMarket, loadRaw, H1 } = require('../tests/replay')

const DAY = 86400_000
const ok = (c, m) => {
  console.log(c ? 'PASS' : 'FAIL', m)
  if (!c) process.exitCode = 1
}

;(async () => {
  await require('../lib/settings').ensureLoaded()
  const lastTs = Math.min(...(await Promise.all(cfg.symbols.map(async (s) => (await retry(() => feed.loadBars(s, '1h', 1)))[0].ts))))
  const start = lastTs - 30 * DAY
  const anchorTs = anchorFor(start + 2 * 60_000)
  const raw = await loadRaw(cfg.symbols, anchorTs, lastTs)
  const clock = { t: start + 2 * 60_000, quote: {} }
  const store = memoryStore()
  const paper = createPaper({ store, market: replayMarket(raw, clock) })
  await paper.load()
  const { S } = paper
  let t = start
  const cycle = async () => {
    clock.t = t + 2 * 60_000
    const r = await paper.runCycle()
    t += H1
    return r
  }

  // 1. 推进主循环直到出现持仓
  while (!Object.keys(S.st.positions).length && t < lastTs) await cycle()
  const sym = Object.keys(S.st.positions)[0]
  ok(!!sym, `主循环开仓：${sym} @ ${new Date(t - H1).toISOString().slice(0, 13)}`)
  ok((await paper.reconcile()).ok, '开仓后对账一致（订单账本 = 持仓表 = 内存）')

  // 2. 重复订单号：伪造一笔与已有订单相同信号的成交 → 被拦截并暂停
  const o0 = store.mem.orders[store.mem.orders.length - 1]
  S.st.fills.push({ seq: 999, ts: o0.fill_ts, symbol: o0.symbol, intent: o0.intent, side: o0.side, qty: o0.qty, px: o0.fill_px, ref_px: o0.ref_px, fee: 0, slippage: 0, reason: '演练', strategy: o0.strategy, source: o0.client_order_id.split('-')[0], signal_ts: o0.signal_ts })
  const nOrders = store.mem.orders.length
  await paper.flush()
  ok(store.mem.orders.length === nOrders && S.meta.pause_keys.includes('reconcile'), '同一信号重复下单被拦截（幂等）并暂停')
  ok((await paper.resume()).ok && !S.meta.pause_keys.includes('reconcile'), '人工核对后恢复')

  // 3. 盘中止损：本小时第 20 分钟，实时价穿过止损 → 按止损价成交
  const p = S.st.positions[sym]
  clock.t = t - H1 + 20 * 60_000
  clock.quote[sym] = p.side > 0 ? p.stop * 0.999 : p.stop * 1.001
  await paper.monitor()
  clock.quote = {}
  const stopTr = store.mem.trades[store.mem.trades.length - 1]
  ok(!S.st.positions[sym] && stopTr?.symbol === sym && stopTr.reason === '止损', `盘中止损触发并平仓（成交价 ${stopTr?.exit_px}，止损价 ${p.stop}）`)
  ok((await paper.reconcile()).ok, '止损后对账一致')

  // 3b. P2-2：行情中断（数据过期暂停）期间，用最近有效价继续判断止损
  while (!Object.keys(S.st.positions).length && t < lastTs) await cycle()
  const s2 = Object.keys(S.st.positions)[0]
  const p2 = S.st.positions[s2]
  clock.t = t - H1 + 10 * 60_000
  await paper.monitor() // 正常拿到一次报价 → 记为最近有效价
  const lv = S.lastValid[s2].px
  clock.down = Object.fromEntries(cfg.symbols.map((x) => [x, true])) // 之后行情接口全部失败
  clock.t += 3 * 60_000
  await paper.monitor()
  ok(S.meta.pause_keys.includes('stale') && !!S.st.positions[s2], `行情中断 → 数据过期暂停（${S.meta.pause_keys.join(',')}），持仓仍在`)
  p2.stop = p2.side > 0 ? lv * 1.001 : lv * 0.999 // 模拟整点移动止损把止损移过了最近有效价
  clock.t += 60_000
  await paper.monitor()
  const tr2 = store.mem.trades[store.mem.trades.length - 1]
  ok(!S.st.positions[s2] && tr2?.symbol === s2 && tr2.reason === '止损', `数据过期期间仍按最近有效价 ${lv} 判断止损并平仓（${s2}）`)
  ok(store.mem.events.some((e) => /行情过期，用最近有效价/.test(e.message ?? e.msg ?? '')), '事件日志记录了“用最近有效价判断止损”')
  clock.down = {}
  clock.t = t - H1 + 30 * 60_000
  for (let k = 0; k < 6; k++) {
    await paper.monitor()
    clock.t += 60_000
  }
  await paper.resume()

  // 4. 再推进到有持仓 → 紧急停止 → 恢复
  while (!Object.keys(S.st.positions).length && t < lastTs) await cycle()
  const es = await paper.emergencyStop('演练')
  ok(es.closed.length >= 1 && !Object.keys(S.st.positions).length && S.st.status === 'stopped', `紧急停止：平掉 ${es.closed.length} 个持仓 + 停止`)
  ok((await paper.resume()).ok && S.st.status === 'running', '人工恢复运行')

  // 5. 订单超时未知 → 标 UNKNOWN → 恢复时按持仓表撤销
  const cid = `drill-${t}-x`
  await store.insertOrder({ client_order_id: cid, status: 'SUBMITTED', history: [], symbol: 'ETH/USDT', side: 1, intent: 'open', qty: 1, ref_px: 2000, reason: '演练', strategy: 'breakout', signal_ts: t, created_at: clock.t })
  S.inflight.set(cid, clock.t - 31_000)
  ok((await paper.sweepUnknownOrders(false)) >= 1, '订单超过 30 秒未知 → 标为 UNKNOWN')
  ok((await paper.resume()).ok && (await store.getOrder(cid)).status === 'CANCELED', '恢复时按持仓表处理未知订单（撤销）')

  // 6. 回撤锁定（在 K 线收盘时由引擎判断）
  S.st.peak = sim.equity(S.st) / 0.89
  await cycle()
  ok(S.st.status === 'locked', '回撤超过 10% → 收盘时锁定')
  ok((await paper.resume()).ok === false, '锁定状态下「恢复」被拒绝，必须解锁')
  ok((await paper.unlock()).ok && S.st.status === 'running', '人工解锁（以当前权益为新峰值）')

  // 7. 日亏停手（当日持续有效，次日 UTC 0 点解除）
  S.st.dayStartEq = sim.equity(S.st) / 0.97
  await cycle()
  ok(S.st.dayBlocked === true, '日亏超过 2% → 当日停开新仓')
  const nextDay = Math.floor(t / DAY) * DAY + DAY
  while (t <= nextDay) await cycle()
  ok(S.st.dayBlocked === false, '新的一天解除')

  ok((await paper.reconcile()).ok, '最终对账一致')
  console.log(`演练共 ${store.mem.cycles.length} 次主循环，${store.mem.orders.length} 笔订单，${store.mem.trades.length} 笔平仓；未写入正式账户`)
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
