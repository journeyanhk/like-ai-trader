// 模拟盘的持久化层（可替换）：
//   dbStore()     —— 正式运行，写数据库
//   memoryStore() —— 等价性测试 / 演练用，全部在内存里，不碰正式账户
// 两者接口完全相同，paper.js 只通过这些方法读写。
const n = (v) => (v == null ? null : Number(v))

const ACCT_COLS = ['status', 'status_reason', 'pause_keys', 'cash', 'peak_equity', 'day_key', 'day_start_equity', 'day_blocked', 'enabled_strategies', 'disabled_strategies', 'last_bar_ts', 'last_heartbeat', 'last_cycle_at', 'started_at', 'updated_at', 'engine']
const JSON_COLS = new Set(['pause_keys', 'enabled_strategies', 'disabled_strategies', 'engine'])

function rowToPos(r) {
  return {
    symbol: r.symbol,
    side: n(r.side),
    qty: n(r.qty),
    entry_px: n(r.entry_px),
    entry_ts: n(r.entry_ts),
    stop: n(r.stop),
    strategy: r.strategy,
    params: r.params,
    regime: r.regime,
    fees: n(r.fees),
    slippage: n(r.slippage),
    funding: n(r.funding),
    risk_amt: n(r.risk_amt),
    last_funding_ts: n(r.last_funding_ts),
  }
}
function rowToAcct(r) {
  if (!r) return null
  const o = { ...r }
  for (const k of ['cash', 'peak_equity', 'day_key', 'day_start_equity', 'last_bar_ts', 'last_heartbeat', 'last_cycle_at', 'started_at', 'updated_at']) o[k] = n(r[k])
  o.day_blocked = !!r.day_blocked
  return o
}

function dbStore() {
  const { dbQuery } = require('@surf-ai/sdk/db')
  const feed = require('./feed')
  return {
    kind: 'db',
    async wipe() {
      for (const t of ['paper_positions', 'paper_orders', 'paper_trades', 'paper_funding', 'paper_equity', 'paper_cycles', 'paper_account']) await dbQuery(`DELETE FROM ${t}`)
    },
    async loadAccount() {
      const { rows } = await dbQuery(`SELECT * FROM paper_account WHERE id='main'`)
      return rowToAcct(rows[0])
    },
    async insertAccount(a) {
      const cols = ACCT_COLS.filter((c) => a[c] !== undefined)
      await dbQuery(
        `INSERT INTO paper_account (id, ${cols.join(',')}) VALUES ('main', ${cols.map((_, k) => `$${k + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`,
        cols.map((c) => (JSON_COLS.has(c) ? JSON.stringify(a[c]) : a[c])),
      )
    },
    async saveAccount(a) {
      const cols = ACCT_COLS.filter((c) => c !== 'started_at')
      await dbQuery(
        `UPDATE paper_account SET ${cols.map((c, k) => `${c}=$${k + 1}`).join(', ')} WHERE id='main'`,
        cols.map((c) => (JSON_COLS.has(c) ? JSON.stringify(a[c] ?? null) : a[c] ?? null)),
      )
    },
    async loadPositions() {
      const { rows } = await dbQuery('SELECT * FROM paper_positions')
      return rows.map(rowToPos)
    },
    async upsertPosition(p) {
      await dbQuery(
        `INSERT INTO paper_positions (symbol, side, qty, entry_px, entry_ts, stop, strategy, params, regime, fees, slippage, funding, risk_amt, last_funding_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (symbol) DO UPDATE SET side=$2, qty=$3, entry_px=$4, entry_ts=$5, stop=$6, strategy=$7, params=$8, regime=$9,
           fees=$10, slippage=$11, funding=$12, risk_amt=$13, last_funding_ts=$14`,
        [p.symbol, p.side, p.qty, p.entry_px, p.entry_ts, p.stop, p.strategy, JSON.stringify(p.params || {}), p.regime, p.fees, p.slippage, p.funding, p.risk_amt, p.last_funding_ts],
      )
    },
    async deletePosition(symbol) {
      await dbQuery('DELETE FROM paper_positions WHERE symbol=$1', [symbol])
    },
    async insertOrder(o) {
      const ins = await dbQuery(
        `INSERT INTO paper_orders (client_order_id, symbol, side, intent, qty, ref_px, status, reason, strategy, signal_ts, fill_ts, history, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) ON CONFLICT (client_order_id) DO NOTHING RETURNING id`,
        [o.client_order_id, o.symbol, o.side, o.intent, o.qty, o.ref_px, o.status, o.reason, o.strategy, o.signal_ts, o.fill_ts, JSON.stringify(o.history), o.created_at],
      )
      return ins.rows[0]?.id ?? null
    },
    async updateOrder(id, f) {
      await dbQuery(`UPDATE paper_orders SET status=$1, fill_px=$2, fee=$3, slippage=$4, history=$5, updated_at=$6 WHERE id=$7`, [f.status, f.fill_px ?? null, f.fee ?? null, f.slippage ?? null, JSON.stringify(f.history), f.updated_at, id])
    },
    async getOrder(cid) {
      const { rows } = await dbQuery('SELECT * FROM paper_orders WHERE client_order_id=$1', [cid])
      return rows[0] ?? null
    },
    async ordersByStatus(status) {
      return (await dbQuery(`SELECT * FROM paper_orders WHERE status=$1 ORDER BY id`, [status])).rows
    },
    async stuckOrderIds(before) {
      const { rows } = await dbQuery(`SELECT client_order_id FROM paper_orders WHERE status IN ('PENDING','SUBMITTED','PARTIAL') AND created_at < $1`, [before])
      return rows.map((r) => r.client_order_id)
    },
    async countUnknown() {
      return (await dbQuery(`SELECT COUNT(*)::int AS c FROM paper_orders WHERE status='UNKNOWN'`)).rows[0].c
    },
    async ledgerNet() {
      const { rows } = await dbQuery(`SELECT symbol, SUM(side*qty)::float8 AS net FROM paper_orders WHERE status='FILLED' GROUP BY symbol`)
      return Object.fromEntries(rows.map((r) => [r.symbol, n(r.net)]))
    },
    async insertTrade(t, at) {
      await dbQuery(
        `INSERT INTO paper_trades (symbol, strategy, side, entry_ts, entry_px, exit_ts, exit_px, qty, regime, reason, fees, slippage, funding, pnl, risk_amt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [t.symbol, t.strategy, t.side, t.entry_ts, t.entry_px, t.exit_ts, t.exit_px, t.qty, t.regime, t.reason, t.fees, t.slippage, t.funding, t.pnl, t.risk_amt],
      )
    },
    async insertFunding(f) {
      await dbQuery(`INSERT INTO paper_funding (ts, symbol, side, qty, mark, rate, assumed, cashflow) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [f.ts, f.symbol, f.side, f.qty, f.mark, f.rate, f.assumed, f.cashflow])
    },
    async insertEquity(e) {
      await dbQuery(
        `INSERT INTO paper_equity (ts, equity, cash, unrealized, exposure, drawdown_pct, positions) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ts) DO UPDATE SET equity=$2, cash=$3, unrealized=$4, exposure=$5, drawdown_pct=$6, positions=$7`,
        [e.ts, e.equity, e.cash, e.unrealized, e.exposure, e.drawdown_pct, e.positions],
      )
    },
    async insertCycle(c) {
      await dbQuery('INSERT INTO paper_cycles (ts, bar_ts, summary) VALUES ($1,$2,$3)', [c.ts, c.bar_ts, JSON.stringify(c.summary)])
    },
    logEvent: (level, type, msg, detail) => feed.logEvent(level, type, msg, detail),
  }
}

function memoryStore() {
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)))
  const m = { account: null, positions: {}, orders: [], trades: [], funding: [], equity: [], cycles: [], events: [] }
  let oid = 0
  return {
    kind: 'memory',
    mem: m,
    async wipe() {
      Object.assign(m, { account: null, positions: {}, orders: [], trades: [], funding: [], equity: [], cycles: [] })
    },
    async loadAccount() {
      return clone(m.account)
    },
    async insertAccount(a) {
      if (!m.account) m.account = clone(a)
    },
    async saveAccount(a) {
      m.account = { ...clone(a), started_at: m.account?.started_at ?? a.started_at }
    },
    async loadPositions() {
      return Object.values(clone(m.positions))
    },
    async upsertPosition(p) {
      m.positions[p.symbol] = clone(p)
    },
    async deletePosition(symbol) {
      delete m.positions[symbol]
    },
    async insertOrder(o) {
      if (m.orders.some((x) => x.client_order_id === o.client_order_id)) return null
      m.orders.push({ ...clone(o), id: ++oid })
      return oid
    },
    async updateOrder(id, f) {
      Object.assign(
        m.orders.find((x) => x.id === id),
        clone(f),
      )
    },
    async getOrder(cid) {
      return clone(m.orders.find((x) => x.client_order_id === cid) ?? null)
    },
    async ordersByStatus(status) {
      return clone(m.orders.filter((x) => x.status === status))
    },
    async stuckOrderIds(before) {
      return m.orders.filter((x) => ['PENDING', 'SUBMITTED', 'PARTIAL'].includes(x.status) && x.created_at < before).map((x) => x.client_order_id)
    },
    async countUnknown() {
      return m.orders.filter((x) => x.status === 'UNKNOWN').length
    },
    async ledgerNet() {
      const out = {}
      for (const o of m.orders) if (o.status === 'FILLED') out[o.symbol] = (out[o.symbol] || 0) + o.side * o.qty
      return out
    },
    async insertTrade(t) {
      m.trades.push(clone(t))
    },
    async insertFunding(f) {
      m.funding.push(clone(f))
    },
    async insertEquity(e) {
      m.equity.push(clone(e))
    },
    async insertCycle(c) {
      m.cycles.push(clone(c))
    },
    async logEvent(level, type, message, detail) {
      m.events.push({ level, type, message })
    },
  }
}

module.exports = { dbStore, memoryStore, rowToPos }
