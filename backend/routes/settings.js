// /api/settings —— 查看 / 调整风控参数（只能更严格），全部修改留记录；其余参数只读展示
const { Router } = require('express')
const cfg = require('../lib/config')
const settings = require('../lib/settings')
const { STRATEGIES } = require('../lib/strategies')

const router = Router()

router.get('/', async (_req, res) => {
  try {
    await settings.ensureLoaded()
    res.json({
      mode: cfg.mode,
      risk: settings.view(),
      readonly: {
        market: { exchange: 'OKX 永续合约', symbols: cfg.symbols, mainInterval: cfg.mainInterval, confirmInterval: cfg.confirmInterval, startingEquity: cfg.paperStartingEquity },
        costs: cfg.costs,
        regime: cfg.regime,
        allowedStrategies: cfg.allowedStrategies,
        pause: {
          staleDataSeconds: cfg.staleDataSeconds,
          priceSourceMaxDeviationPct: cfg.priceSourceMaxDeviationPct,
          orderUnknownSeconds: cfg.paper.orderUnknownSeconds,
          maxApiErrors: cfg.paper.maxApiErrors,
          autoResumeHealthyChecks: cfg.paper.autoResumeHealthyChecks,
          heartbeatMinutes: cfg.paper.heartbeatEveryMs / 60000,
          heartbeatMissing: cfg.paper.heartbeatMissing,
        },
        invalidation: { trades: cfg.paper.invalidationTrades, pf: cfg.paper.invalidationPf, minDays: cfg.paper.invalidationMinDays },
        strategies: Object.values(STRATEGIES).map((s) => ({ name: s.name, label: s.label, version: s.version, defaults: s.defaults, paramLabels: s.paramLabels, description: s.description })),
      },
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/risk', async (req, res) => {
  const runner = require('../lib/runner')
  const ri = runner.info()
  if (!runner.isLeader() && ri.leaseHolder && ri.leaseHolder !== ri.id) return res.status(409).json({ ok: false, error: '风控参数请到正在运行模拟盘的实例（已发布的网站）上修改，这里只读' })
  try {
    const r = req.body?.reset ? await settings.resetToDoc(req.body?.reason) : await settings.update(req.body?.changes, req.body?.reason)
    res.status(r.ok ? 200 : 400).json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

router.get('/history', async (_req, res) => {
  try {
    res.json(await settings.history(100))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
