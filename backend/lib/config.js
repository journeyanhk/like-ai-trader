// 系统全部参数集中在这里（对应设计文档中的 config.yaml）
module.exports = {
  mode: 'PAPER', // 第一阶段强制模拟
  // 实盘：验收清单全部通过前不开放；首期资金不超过总资金 5%
  live: { enabled: false, maxInitialCapitalPct: 5 },
  exchange: 'okx', // 行情来自 OKX 免费公共接口（不消耗 Surf 点数）
  marketType: 'swap', // 永续合约
  // 第 7 次交付：从 2 个扩到 5 个币，靠分散提高稳定性（数据仍来自 OKX 免费接口）
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT'],
  // 相关资产分组（风控合并计算敞口）：P1-2 五个币高度相关，归为同一组，组合计上限见 risk.maxGroupExposurePct
  correlationGroups: { crypto: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT'] },
  // P1-1 OKX 永续合约规格（2026-10-09 从 public/instruments 抓取；scripts/check-contracts.js 可核对是否变化）
  // 下单数量单位是「张」：1 张 = ctVal 个币；张数必须是 lotSz 的整数倍，且不小于 minSz
  contracts: {
    'BTC/USDT': { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
    'ETH/USDT': { instId: 'ETH-USDT-SWAP', ctVal: 0.1, lotSz: 0.01, minSz: 0.01 },
    'SOL/USDT': { instId: 'SOL-USDT-SWAP', ctVal: 1, lotSz: 0.01, minSz: 0.01 },
    'XRP/USDT': { instId: 'XRP-USDT-SWAP', ctVal: 100, lotSz: 0.01, minSz: 0.01 },
    'DOGE/USDT': { instId: 'DOGE-USDT-SWAP', ctVal: 1000, lotSz: 0.01, minSz: 0.01 },
  },
  mainInterval: '1h',
  confirmInterval: '4h',
  historyDays: 730, // 回补 2 年历史（滚动验证需要覆盖牛市、熊市、震荡）

  regime: {
    adxPeriod: 14,
    atrPeriod: 14,
    emaPeriod: 20,
    trendAdx: 25, // ADX > 25 且 1h/4h EMA20 斜率同向 → 趋势
    rangeAdx: 20, // ADX < 20 → 震荡
    slopeLookback: 5, // EMA 斜率：与 N 根之前比较
    highVolPercentile: 0.8, // ATR/价格 位于过去 90 天 80 分位以上 → 高波动
    volLookbackDays: 90,
    lowLiqVolumeRatio: 0.5, // 24h 成交量 < 30 日均值 50% → 低流动性
    maxSpreadPct: 0.05, // 盘口价差 > 0.05% → 低流动性
  },

  // 每种市场状态允许运行的策略（状态不明确不开新仓）
  allowedStrategies: {
    trend_up: ['breakout', 'trend_following'],
    trend_down: ['breakout', 'trend_following'],
    range: ['mean_reversion'],
    high_vol: [],
    low_liquidity: [],
    unclear: [],
  },

  // 数据质量
  staleDataSeconds: 60,
  priceSourceMaxDeviationPct: 0.5,

  // 风控（第 3 次交付启用）
  risk: {
    riskPerTradePct: 0.5,
    dailyLossLimitPct: 2,
    maxDrawdownPct: 10,
    maxGrossExposurePct: 100,
    maxSymbolExposurePct: 50,
    maxGroupExposurePct: 60, // 同一相关组（5 个币）合计仓位不超过权益 60%
    maxLeverage: 3,
  },

  // 成本模型（第 2 次交付回测使用）
  costs: {
    takerPct: 0.05,
    makerPct: 0.02,
    slippageBps: 5,
    // 早于已保存资金费率历史的时段：保守假设每 8 小时付 0.01%（无论多空都算成本）
    assumedFundingPct8h: 0.01,
  },

  // 回测 / 滚动验证
  backtest: {
    warmupDays: 30, // 指标预热，不计入结果
    trainDays: 180,
    testDays: 60,
    stepDays: 30,
    minTrainTrades: 8, // 训练期交易太少的参数组合不予采用
    // P2-3 留出集：2026-10-09 标记的最近 90 天（2026-07-11 00:00 UTC 起）。边界固定不随时间滚动，
    // 策略比较 / 参数挑选 / 回测实验室一律不读这段数据，留到最终一次性检验。
    holdoutDays: 90,
    holdoutFrom: Date.UTC(2026, 6, 11),
  },

  paperStartingEquity: 10000,

  // AI 复盘（第 5 次交付）：AI 只写文字，永远不进入下单流程
  ai: {
    provider: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', // 默认模型；可在设置页修改（价格表见 lib/ai.js）
    maxTokens: 6000,
    timeoutMs: 120_000,
    marketCallsPerDay: 5, // 手动「解读当前市场」每天上限
    maxCallsPerDay: 10, // 所有 AI 调用每天硬上限（含复盘重新生成）
    monthlyBudgetUsd: 3, // 本月估算花费超过就停止调用
    newsLimit: 20, // 开启新闻时每天取多少条（1 次 Surf 调用）
  },

  // 验收标准（设计文档）
  acceptance: {
    oosSharpe: 1.0,
    oosMaxDrawdownPct: 15,
    oosTrades: 100,
    paperDays: 30,
    paperVsBacktestDevPct: 20,
    devMinBaseReturnPct: 1, // 偏差分母下限：同期回测收益绝对值小于 1% 时按 1% 计算，避免除以接近 0 的数
  },

  // 模拟盘（第 3 次交付）
  paper: {
    strategies: ['breakout'], // 默认启用的策略（参数用策略默认值）；旧的两个策略回测亏损，保留在策略库但默认不启用
    barsForSignals: 600, // 计算信号用的 1h K 线数量
    heartbeatEveryMs: 5 * 60_000, // 心跳 5 分钟写一次
    heartbeatMissing: 3, // 连续 3 次缺失视为宕机
    orderUnknownSeconds: 30, // 订单超过 30 秒状态未知 → 暂停
    maxApiErrors: 5, // 连续 5 次接口错误 → 暂停
    autoResumeHealthyChecks: 5, // 数据类暂停：连续 5 次（约 5 分钟）检查正常后自动恢复
    invalidationTrades: 20, // 策略失效：最近 20 笔盈亏比 < 1.0 自动下线
    invalidationPf: 1.0,
    invalidationMinDays: 30, // P1-3：且策略运行满 30 天才评估（避免短期运气差就下线）
  },
}
