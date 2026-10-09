// /api/accept —— 验收清单：自动统计、自动打勾；全部通过前不开放实盘
const { Router } = require('express')
const acceptance = require('../lib/acceptance')
const paper = require('../lib/paper')

const router = Router()
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
}

router.get('/', wrap(async (req) => acceptance.evaluate({ runId: Number(req.query.run) || null })))

// 故障演练：人为触发一个自动暂停条件
router.post(
  '/drill',
  wrap(async (req, res) => {
    const r = await paper.drillPause(String(req.body?.key || ''))
    if (!r.ok) res.status(409)
    return r
  }),
)

module.exports = router
