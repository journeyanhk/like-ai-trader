// 定时任务：每天 UTC 00:05 生成前一天的复盘（在 00:02 的整点交易循环之后）
const review = require('../lib/review')
const ai = require('../lib/ai')

exports.handler = async () => {
  const day = ai.dayKey(Date.now() - 86400_000)
  const r = await review.generateDaily(day, 'cron')
  console.log('[review]', day, JSON.stringify(r))
}
