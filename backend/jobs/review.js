// 定时任务：每天 UTC 00:05 生成前一天的复盘（在 00:02 的整点交易循环之后）
// 同时核对一次 OKX 合约规格（ctVal / lotSz / minSz），变化即告警。
const review = require('../lib/review')
const ai = require('../lib/ai')

exports.handler = async () => {
  try {
    const c = await require('../lib/contractCheck').checkAndAlert()
    console.log('[review] 合约规格', c.ok ? '一致' : JSON.stringify(c.rows.filter((x) => !x.ok)))
  } catch (e) {
    console.error('[review] 合约规格核对出错', e.message)
  }
  const day = ai.dayKey(Date.now() - 86400_000)
  const r = await review.generateDaily(day, 'cron')
  console.log('[review]', day, JSON.stringify(r))
}
