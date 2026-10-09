// /api/backtest —— 回测实验室（纯本地计算，不调用任何付费接口）
const { Router } = require('express')
const { dbQuery } = require('@surf-ai/sdk/db')
const lab = require('../lib/lab')
const { STRATEGIES } = require('../lib/strategies')
const cfg = require('../lib/config')

const router = Router()

router.get('/meta', (_req, res) => {
  res.json({
    symbols: cfg.symbols,
    strategies: Object.values(STRATEGIES).map((s) => ({
      name: s.name,
      label: s.label,
      version: s.version,
      description: s.description,
      allowedRegimes: s.allowedRegimes,
      defaults: s.defaults,
      paramLabels: s.paramLabels,
      invalidation: s.invalidation,
    })),
    costs: cfg.costs,
    risk: cfg.risk,
    backtest: cfg.backtest,
    startEquity: cfg.paperStartingEquity,
  })
})

router.post('/run', async (req, res) => {
  try {
    const b = req.body || {}
    res.json(await lab.startRun({ symbols: b.symbols, strategies: b.strategies, regimeFilter: b.regimeFilter !== false, ddLock: !!b.ddLock }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/runs', async (_req, res) => {
  try {
    const { rows } = await dbQuery(`SELECT id, created_at, status, request, summary, error, duration_ms FROM backtest_runs ORDER BY id DESC LIMIT 30`)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/runs/:id', async (req, res) => {
  try {
    const { rows } = await dbQuery(`SELECT * FROM backtest_runs WHERE id=$1`, [Number(req.params.id)])
    if (!rows[0]) return res.status(404).json({ error: '未找到' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
