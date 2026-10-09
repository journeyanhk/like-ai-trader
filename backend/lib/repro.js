// P0-4 复现包：模拟盘启动时把「能完全复现这次模拟」所需的一切落盘
//   配置哈希、引擎源码哈希、git commit、candles / funding_rates 表的行数与首尾 ts、runBacktest 调用参数
// 验收页的同期回测只用复现包里的参数和配置重跑（rerun），不读当前配置。
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { dbQuery } = require('@surf-ai/sdk/db')
const cfg = require('./config')
const feed = require('./feed')
const sim = require('./simulate')
const { runBacktest } = require('./backtest')
const { STRATEGIES } = require('./strategies')

const H1 = 3600_000
const CODE_FILES = ['simulate.js', 'backtest.js', 'paper.js', 'risk.js', 'strategies.js', 'regime.js', 'indicators.js', 'feed.js', 'config.js']

// 键排序后的 JSON，保证同一配置哈希唯一
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const configHash = (conf) => sha(canon(conf))

function codeHash() {
  const h = crypto.createHash('sha256')
  for (const f of CODE_FILES) {
    const p = path.join(__dirname, f)
    if (fs.existsSync(p)) h.update(f).update(fs.readFileSync(p))
  }
  return h.digest('hex')
}

function git() {
  try {
    const cwd = path.join(__dirname, '..', '..')
    const commit = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain -- backend/lib', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0
    return { commit, dirty }
  } catch {
    return { commit: null, dirty: null }
  }
}

async function q(sql, params) {
  for (let k = 0; ; k++) {
    try {
      return (await dbQuery(sql, params)).rows
    } catch (e) {
      if (k >= 4) throw e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

/** candles / funding_rates：全表与 [anchorTs, uptoTs) 窗口内的行数与首尾 ts（按币种、周期） */
async function dataStats(symbols, anchorTs, uptoTs) {
  const c = await q(
    `SELECT symbol, interval, COUNT(*)::int AS rows, MIN(ts)::float8 AS first_ts, MAX(ts)::float8 AS last_ts,
            COUNT(*) FILTER (WHERE ts >= $2 AND ts < $3)::int AS win_rows,
            MIN(ts) FILTER (WHERE ts >= $2 AND ts < $3)::float8 AS win_first_ts,
            MAX(ts) FILTER (WHERE ts >= $2 AND ts < $3)::float8 AS win_last_ts
     FROM candles WHERE symbol = ANY($1) GROUP BY symbol, interval ORDER BY symbol, interval`,
    [symbols, anchorTs, uptoTs],
  )
  const f = await q(
    `SELECT symbol, COUNT(*)::int AS rows, MIN(ts)::float8 AS first_ts, MAX(ts)::float8 AS last_ts,
            COUNT(*) FILTER (WHERE ts >= $2 AND ts < $3)::int AS win_rows,
            MIN(ts) FILTER (WHERE ts >= $2 AND ts < $3)::float8 AS win_first_ts,
            MAX(ts) FILTER (WHERE ts >= $2 AND ts < $3)::float8 AS win_last_ts
     FROM funding_rates WHERE symbol = ANY($1) GROUP BY symbol ORDER BY symbol`,
    [symbols, anchorTs, uptoTs],
  )
  return { window: { from: anchorTs, to: uptoTs }, candles: c, funding_rates: f }
}

/** 模拟盘开始时生成复现包。startedAt = 账户开始时间，anchorTs = 指标锚点 */
async function buildBundle({ startedAt, anchorTs, conf = cfg, enabled }) {
  const config = JSON.parse(JSON.stringify(conf))
  const strategies = [...enabled]
  const first = Math.floor(startedAt / H1) * H1 - H1 // 第一次整点循环处理的收盘 K 线
  const params = {
    symbols: [...conf.symbols],
    strategies,
    strategyParams: Object.fromEntries(strategies.map((n) => [n, { ...STRATEGIES[n].defaults }])),
    anchorTs,
    from: first,
    startEquity: conf.paperStartingEquity,
    regimeFilter: true,
    ddLock: true,
    invalidation: true,
    closeAtEnd: false,
    until: 'open',
    startedAt,
  }
  const g = git()
  return {
    started_at: startedAt,
    created_at: Date.now(),
    config_hash: configHash(config),
    code_hash: codeHash(),
    git_commit: g.commit,
    git_dirty: g.dirty,
    config,
    data: await dataStats(conf.symbols, anchorTs, first + H1),
    params,
  }
}

async function save(b) {
  const rows = await q(
    `INSERT INTO paper_repro (started_at, created_at, config_hash, code_hash, git_commit, git_dirty, config, data, params)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.started_at, b.created_at, b.config_hash, b.code_hash, b.git_commit, b.git_dirty, JSON.stringify(b.config), JSON.stringify(b.data), JSON.stringify(b.params)],
  )
  return rows[0].id
}

async function latest(startedAt) {
  const rows = await q(`SELECT * FROM paper_repro WHERE started_at=$1 ORDER BY id DESC LIMIT 1`, [startedAt])
  if (!rows[0]) return null
  const r = rows[0]
  return { ...r, started_at: Number(r.started_at), created_at: Number(r.created_at) }
}

/**
 * 按复现包重跑同期回测：数据从锚点读到 lastCloseTs，调用参数、配置、策略参数全部取自复现包。
 * 时间轴与模拟盘一一对应：from = 第一次循环的收盘 K 线，到 lastCloseTs 收盘 + 下一根开盘为止（until: 'open'）。
 */
async function rerun(bundle, lastCloseTs) {
  const p = bundle.params
  const conf = bundle.config
  const to = lastCloseTs + 2 * H1
  const data = {}
  for (const s of p.symbols) {
    const [b1, b4, f] = await Promise.all([feed.loadBarsRange(s, '1h', p.anchorTs, to), feed.loadBarsRange(s, '4h', p.anchorTs, to), feed.loadFundingRange(s, p.anchorTs, to)])
    data[s] = { ...sim.buildSeries(b1, b4.filter((b) => b.ts + 4 * H1 <= to)), funding: new Map(f.map((x) => [x.ts, x.rate])) }
  }
  const res = runBacktest(data, {
    strategies: p.strategies,
    paramsAt: (n) => ({ ...p.strategyParams[n] }),
    from: p.from,
    to,
    startEquity: p.startEquity,
    regimeFilter: p.regimeFilter,
    ddLock: p.ddLock,
    invalidation: p.invalidation,
    closeAtEnd: p.closeAtEnd,
    until: p.until,
    conf,
  })
  return { res, from: p.from, to }
}

/** 验收时核对：复现包里记录的启动前历史窗口，现在数据库里是否原样还在 */
async function verify(bundle) {
  const now = await dataStats(bundle.params.symbols, bundle.data.window.from, bundle.data.window.to)
  const key = (r) => `${r.symbol}|${r.interval ?? 'funding'}`
  const pick = (r) => `${r.win_rows}|${r.win_first_ts}|${r.win_last_ts}`
  const was = new Map([...bundle.data.candles, ...bundle.data.funding_rates].map((r) => [key(r), pick(r)]))
  const diffs = [...now.candles, ...now.funding_rates].filter((r) => was.get(key(r)) !== pick(r)).map((r) => ({ key: key(r), was: was.get(key(r)) ?? null, now: pick(r) }))
  const curCfg = configHash(JSON.parse(JSON.stringify(cfg)))
  return { dataOk: diffs.length === 0, diffs, configSame: curCfg === bundle.config_hash, codeSame: codeHash() === bundle.code_hash, currentConfigHash: curCfg }
}

module.exports = { buildBundle, save, latest, rerun, verify, configHash, codeHash, canon }
