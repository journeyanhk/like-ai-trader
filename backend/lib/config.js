// 系统全部参数集中在这里（对应设计文档中的 config.yaml）
module.exports = {
  mode: 'PAPER', // 第一阶段强制模拟
  exchange: 'binance',
  marketType: 'swap', // 永续合约
  symbols: ['BTC/USDT', 'ETH/USDT'],
  // 相关资产分组（风控合并计算敞口）
  correlationGroups: { majors: ['BTC/USDT', 'ETH/USDT'] },
  mainInterval: '1h',
  confirmInterval: '4h',
  historyDays: 365, // 至少回补 1 年历史

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
    trend_up: ['trend_following'],
    trend_down: ['trend_following'],
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
    maxLeverage: 3,
  },

  // 成本模型（第 2 次交付回测使用）
  costs: { takerPct: 0.05, makerPct: 0.02, slippageBps: 5 },

  paperStartingEquity: 10000,
}
