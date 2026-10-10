// 单实例运行（租约）：发布后，线上实例与开发沙盒连的是同一个数据库、同一个模拟账户。
// 两边都跑每小时循环 / 每分钟巡检会重复下单、互相覆盖账户状态，所以：
//   - 只有持有租约（runner_lease 'paper'）的实例执行模拟盘任务；租约 3 分钟有效，每分钟续一次。
//   - 线上实例优先：线上可以从沙盒手里直接接管；沙盒只能在租约过期（线上失联 ≥ 3 分钟）后接管。
//   - 刚拿到租约时先从数据库重载账户（别的实例可能改过）。
// 不改模拟盘决策路径：只在任务入口（jobs/*）和操作接口前做判断。
const os = require('node:os')
const crypto = require('node:crypto')
const { dbQuery } = require('@surf-ai/sdk/db')

const TTL = 3 * 60_000
const SANDBOX = !!(process.env.E2B_SANDBOX || process.env.SANDBOX_WORKSPACE_ROOT)
const ID = `${SANDBOX ? 'sandbox' : 'live'}:${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`
const STARTED = Date.now()
let commit = null
try {
  commit = require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch { /* 线上可能没有 git */ }

const state = { leader: false, lastTick: 0, leaseHolder: null, leaseSandbox: null, leaseExpires: null, error: null }

async function q(sql, p) {
  for (let i = 0; ; i++) {
    try {
      return (await dbQuery(sql, p)).rows
    } catch (e) {
      if (i < 2 && String(e.message).includes('499')) continue
      throw e
    }
  }
}

/** 每次任务开始前调用。返回 { leader, justAcquired } */
async function tick() {
  const t = Date.now()
  const wasLeader = state.leader
  try {
    const rows = await q(
      `INSERT INTO runner_lease (id, holder, host, sandbox, acquired_at, renewed_at, expires_at)
       VALUES ('paper', $1, $2, $3, $4, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         holder = EXCLUDED.holder, host = EXCLUDED.host, sandbox = EXCLUDED.sandbox,
         acquired_at = CASE WHEN runner_lease.holder = EXCLUDED.holder THEN runner_lease.acquired_at ELSE EXCLUDED.acquired_at END,
         renewed_at = EXCLUDED.renewed_at, expires_at = EXCLUDED.expires_at
       WHERE runner_lease.holder = EXCLUDED.holder
          OR runner_lease.expires_at < EXCLUDED.renewed_at
          OR (runner_lease.sandbox = true AND EXCLUDED.sandbox = false)
       RETURNING holder`,
      [ID, os.hostname(), SANDBOX, t, t + TTL],
    )
    state.leader = rows.length > 0
    if (!state.leader) {
      const cur = (await q(`SELECT holder, sandbox, expires_at::float8 AS e FROM runner_lease WHERE id='paper'`))[0]
      state.leaseHolder = cur?.holder ?? null
      state.leaseSandbox = cur?.sandbox ?? null
      state.leaseExpires = cur ? Number(cur.e) : null
    } else {
      state.leaseHolder = ID
      state.leaseSandbox = SANDBOX
      state.leaseExpires = t + TTL
    }
    state.error = null
  } catch (e) {
    // 租约表还没建好等情况：保守起见不执行（别的实例可能在跑）；但只有自己时，表建好后下一分钟就能拿到
    state.error = e.message
    state.leader = false
  }
  state.lastTick = t
  await q(
    `INSERT INTO runner_instances (id, host, sandbox, started_at, last_seen, role, git_commit) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET last_seen = EXCLUDED.last_seen, role = EXCLUDED.role`,
    [ID, os.hostname(), SANDBOX, STARTED, t, state.leader ? 'leader' : 'standby', commit],
  ).catch(() => {})
  const justAcquired = state.leader && !wasLeader
  if (justAcquired) {
    await require('./paper').load(true)
    await require('./feed').logEvent('info', 'system', `模拟盘由${SANDBOX ? '开发沙盒' : '线上实例'}接管运行（${ID.split(':').slice(0, 2).join(':')}）`).catch(() => {})
  } else if (wasLeader && !state.leader) {
    await require('./feed').logEvent('info', 'system', `${SANDBOX ? '开发沙盒' : '线上实例'}转为备用，模拟盘由${state.leaseSandbox ? '另一个沙盒' : '线上实例'}运行`).catch(() => {})
  }
  await loadSecrets().catch(() => {})
  return { leader: state.leader, justAcquired }
}

// 告警凭证：.env 优先；没有就从数据库读（线上实例没有 .env）
let secretsAt = 0
async function loadSecrets(force = false) {
  if (!force && Date.now() - secretsAt < 10 * 60_000) return
  secretsAt = Date.now()
  require('./envfile').loadEnv()
  const rows = await q(`SELECT key, value FROM app_secrets`)
  for (const r of rows) if (!process.env[r.key]) process.env[r.key] = r.value
}

function info() {
  return { id: ID, sandbox: SANDBOX, role: state.leader ? 'leader' : 'standby', startedAt: STARTED, commit, lastTick: state.lastTick, leaseHolder: state.leaseHolder, leaseSandbox: state.leaseSandbox, leaseExpires: state.leaseExpires, error: state.error }
}

async function instances() {
  return (await q(`SELECT id, host, sandbox, started_at::float8 AS started_at, last_seen::float8 AS last_seen, role, git_commit FROM runner_instances WHERE last_seen > $1 ORDER BY last_seen DESC`, [Date.now() - 10 * 60_000])).map((r) => ({ ...r, started_at: Number(r.started_at), last_seen: Number(r.last_seen) }))
}

module.exports = { tick, info, instances, loadSecrets, isLeader: () => state.leader, SANDBOX, ID }
