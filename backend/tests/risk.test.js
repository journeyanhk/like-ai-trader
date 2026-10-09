// 单元测试：仓位计算、风控触发、订单状态转换、数据质量检查
// 运行：cd backend && node --test tests/
const test = require('node:test')
const assert = require('node:assert/strict')
const risk = require('../lib/risk')
const orders = require('../lib/orders')
const cfg = require('../lib/config')

test('仓位 = 风险金额 / 止损距离（单笔风险 0.5%）', () => {
  // 权益 10000，风险 50；入场 100，止损 95 → 10 个，名义 1000（未触及上限）
  const s = risk.sizePosition({ equity: 10000, entryPx: 100, stopPx: 95, symbol: 'BTC/USDT' })
  assert.equal(s.riskBudget, 50)
  assert.ok(Math.abs(s.qty - 10) < 1e-9)
  assert.ok(Math.abs(s.riskAmt - 50) < 1e-9)
  assert.equal(s.limitedBy, '风险预算')
})

test('止损太近时被单标的 50% 上限裁剪', () => {
  // 风险 50 / 距离 0.1 = 500 个 × 100 = 50000 → 超过 5000 上限
  const s = risk.sizePosition({ equity: 10000, entryPx: 100, stopPx: 99.9, symbol: 'BTC/USDT' })
  assert.ok(Math.abs(s.notional - 5000) < 1e-6)
  assert.match(s.limitedBy, /单标的/)
  assert.ok(s.riskAmt < 50)
})

test('5 币同组，组上限 60%：已有 BTC 4000 时 DOGE 最多 2000', () => {
  const positions = { 'BTC/USDT': { qty: 0.1, entry_px: 40000 } }
  const s = risk.sizePosition({ equity: 10000, entryPx: 100, stopPx: 99.9, symbol: 'DOGE/USDT', positions, marks: { 'BTC/USDT': 40000 } })
  assert.ok(Math.abs(s.notional - 2000) < 1e-6)
  assert.match(s.limitedBy, /相关资产组合并上限 60%/)
})

test('组内已满 60%（BTC 3000 + ETH 3000）→ SOL 仓位为 0', () => {
  const positions = { 'BTC/USDT': { qty: 0.05, entry_px: 60000 }, 'ETH/USDT': { qty: 1, entry_px: 3000 } }
  const s = risk.sizePosition({ equity: 10000, entryPx: 100, stopPx: 90, symbol: 'SOL/USDT', positions, marks: { 'BTC/USDT': 60000, 'ETH/USDT': 3000 } })
  assert.equal(s.qty, 0)
})

test('总敞口已满时仓位为 0', () => {
  const positions = { 'BTC/USDT': { qty: 0.2, entry_px: 50000 } }
  const s = risk.sizePosition({ equity: 10000, entryPx: 100, stopPx: 95, symbol: 'ETH/USDT', positions, marks: { 'BTC/USDT': 50000 } })
  assert.equal(s.qty, 0)
})

test('日亏 2% 触发', () => {
  assert.equal(risk.dailyLoss(9810, 10000).hit, false)
  assert.equal(risk.dailyLoss(9800, 10000).hit, true)
})

test('回撤 10% 触发锁定', () => {
  assert.equal(risk.drawdown(9001, 10000).hit, false)
  assert.equal(risk.drawdown(9000, 10000).hit, true)
})

test('策略失效：满 20 笔且盈亏比 < 1 才下线', () => {
  const lose = Array.from({ length: 19 }, () => ({ pnl: -10 }))
  assert.equal(risk.strategyInvalidation(lose).invalid, false)
  assert.equal(risk.strategyInvalidation([...lose, { pnl: 5 }]).invalid, true)
  const good = Array.from({ length: 20 }, (_, i) => ({ pnl: i % 2 ? 30 : -10 }))
  assert.equal(risk.strategyInvalidation(good).invalid, false)
})

test('数据检查：过期 > 60 秒、价差 > 0.5% 判为异常', () => {
  const now = 1_000_000_000
  const ok = risk.dataChecks({ last: 100, index: 100.2, ts: now - 5000 }, now)
  assert.equal(ok.stale.ok, true)
  assert.equal(ok.deviation.ok, true)
  const bad = risk.dataChecks({ last: 100, index: 101, ts: now - 61_000 }, now)
  assert.equal(bad.stale.ok, false)
  assert.equal(bad.deviation.ok, false)
  assert.equal(risk.dataChecks(null, now).stale.ok, false)
})

const baseInput = () => ({
  status: 'running',
  pauseKeys: [],
  dayBlocked: false,
  enabled: ['trend_following', 'mean_reversion'],
  disabled: {},
  regime: 'trend_up',
  strategy: 'trend_following',
  signal: { side: 1, stop: 95 },
  refPx: 100,
  equity: 10000,
  positions: {},
  marks: {},
  symbol: 'BTC/USDT',
  barFresh: true,
})

test('风控审核：正常信号通过', () => {
  const r = risk.evaluateEntry(baseInput())
  assert.equal(r.approved, true)
  assert.ok(r.sizing.qty > 0)
})

test('风控审核：各种红线逐一拦截', () => {
  const cases = [
    ['status', { status: 'stopped' }],
    ['status', { status: 'locked' }],
    ['pause', { pauseKeys: ['stale'] }],
    ['daily', { dayBlocked: true }],
    ['bar', { barFresh: false }],
    ['regime', { regime: 'unclear' }],
    ['regime', { regime: 'range' }],
    ['enabled', { disabled: { trend_following: '失效' } }],
    ['enabled', { enabled: ['mean_reversion'] }],
    ['noPos', { positions: { 'BTC/USDT': { qty: 1, entry_px: 100 } } }],
    ['stop', { signal: { side: 1, stop: 101 } }],
  ]
  for (const [key, patch] of cases) {
    const r = risk.evaluateEntry({ ...baseInput(), ...patch })
    assert.equal(r.approved, false, `应被 ${key} 拦截`)
    assert.equal(r.checks.find((c) => c.key === key).ok, false, key)
  }
})

test('风控审核：非 PAPER 模式一律拒绝', () => {
  const r = risk.evaluateEntry(baseInput(), { ...cfg, mode: 'LIVE' })
  assert.equal(r.approved, false)
})

test('订单状态机：合法路径', () => {
  let o = { client_order_id: 'x', status: 'PENDING', history: [] }
  o = orders.transition(o, 'SUBMITTED')
  o = orders.transition(o, 'FILLED')
  assert.equal(o.status, 'FILLED')
  assert.equal(o.history.length, 2)
  assert.ok(orders.isFinal('FILLED'))
})

test('订单状态机：非法跳转抛错', () => {
  assert.throws(() => orders.transition({ client_order_id: 'x', status: 'FILLED' }, 'SUBMITTED'))
  assert.throws(() => orders.transition({ client_order_id: 'x', status: 'PENDING' }, 'FILLED'))
  assert.throws(() => orders.transition({ client_order_id: 'x', status: 'UNKNOWN' }, 'SUBMITTED'))
})

test('幂等键：同一信号生成同一个 clientOrderId', () => {
  const a = orders.clientOrderId('trend_following', 123, 'BTC/USDT', 'open')
  const b = orders.clientOrderId('trend_following', 123, 'BTC/USDT', 'open')
  assert.equal(a, b)
  assert.equal(a, 'trend_following-123-BTCUSDT-open')
})

// ---------- P1-1 合约取整 ----------
const sim = require('../lib/simulate')
test('BTC 按张取整：0.0305504 BTC → 3.05 张 = 0.0305 BTC（只向下取整）', () => {
  const r = sim.roundQty('BTC/USDT', 0.0305504, 63000)
  assert.equal(r.contracts, 3.05)
  assert.equal(r.qty, 0.0305)
  assert.equal(r.check.ok, true)
})
test('DOGE 1 张 = 1000 DOGE：1234.5 DOGE → 1.23 张 = 1230 DOGE', () => {
  const r = sim.roundQty('DOGE/USDT', 1234.5, 0.1)
  assert.equal(r.contracts, 1.23)
  assert.equal(r.qty, 1230)
})
test('不足最小下单量（ETH 0.0009 = 0.009 张 < 0.01 张）→ 不交易并给出原因', () => {
  const r = sim.roundQty('ETH/USDT', 0.0009, 2000)
  assert.equal(r.qty, 0)
  assert.equal(r.check.ok, false)
  assert.match(r.check.detail, /最小 0\.01 张/)
})
test('没有合约规格的币 → 不交易', () => {
  const r = sim.roundQty('ABC/USDT', 5, 1)
  assert.equal(r.qty, 0)
  assert.equal(r.check.ok, false)
})

// ---------- P1-3 策略失效：≥20 笔且 ≥30 天 ----------
const losing = Array.from({ length: 20 }, (_, k) => ({ pnl: k % 4 === 0 ? 10 : -10 })) // 盈亏比 0.33
test('20 笔亏损但只运行 10 天 → 不下线', () => {
  const r = risk.strategyInvalidation(losing, cfg, { total: 20, days: 10 })
  assert.equal(r.invalid, false)
  assert.equal(r.eligible, false)
})
test('运行 40 天但只有 15 笔 → 不下线', () => {
  const r = risk.strategyInvalidation(losing.slice(0, 15), cfg, { total: 15, days: 40 })
  assert.equal(r.invalid, false)
})
test('≥20 笔 且 ≥30 天，最近 20 笔盈亏比 < 1 → 下线', () => {
  const r = risk.strategyInvalidation(losing, cfg, { total: 25, days: 31 })
  assert.equal(r.invalid, true)
})
test('≥20 笔 且 ≥30 天，但盈亏比 ≥ 1 → 不下线', () => {
  const r = risk.strategyInvalidation(losing.map((t) => ({ pnl: -t.pnl })), cfg, { total: 25, days: 31 })
  assert.equal(r.invalid, false)
})
