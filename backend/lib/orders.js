// 订单状态机（确定性，纯函数，便于单元测试）
// PENDING → SUBMITTED → PARTIAL / FILLED / CANCELED / REJECTED / UNKNOWN
// UNKNOWN 只能由人工或对账程序处理为 FILLED / CANCELED
const TRANSITIONS = {
  PENDING: ['SUBMITTED', 'REJECTED', 'CANCELED'],
  SUBMITTED: ['PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN'],
  PARTIAL: ['PARTIAL', 'FILLED', 'CANCELED', 'UNKNOWN'],
  UNKNOWN: ['FILLED', 'CANCELED'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
}

const STATUS_LABEL = {
  PENDING: '待提交',
  SUBMITTED: '已提交',
  PARTIAL: '部分成交',
  FILLED: '已成交',
  CANCELED: '已撤销',
  REJECTED: '被拒绝',
  UNKNOWN: '状态未知',
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to)
}

/** 返回新订单对象（不修改原对象）；非法跳转直接抛错 */
function transition(order, to, note = '', ts = Date.now()) {
  if (!canTransition(order.status, to)) throw new Error(`订单 ${order.client_order_id} 不能从 ${order.status} 变为 ${to}`)
  return { ...order, status: to, updated_at: ts, history: [...(order.history || []), { ts, from: order.status, to, note }] }
}

const isFinal = (s) => TRANSITIONS[s]?.length === 0

/** 幂等键：策略名 + 信号时间戳 + 标的 + 意图。重试时复用，同一信号不会下两次单 */
function clientOrderId(source, signalTs, symbol, intent) {
  return `${source}-${signalTs}-${symbol.replace('/', '')}-${intent}`
}

module.exports = { TRANSITIONS, STATUS_LABEL, canTransition, transition, isFinal, clientOrderId }
