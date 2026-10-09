// /api/review —— AI 复盘：每日复盘、市场解读、用量与费用
// AI 只写文字，不进入下单流程；费用走 DeepSeek 账户，不消耗 Surf 点数（新闻开关除外，默认关闭）
const { Router } = require("express");
const { dbQuery } = require("@surf-ai/sdk/db");
const cfg = require("../lib/config");
const ai = require("../lib/ai");
const review = require("../lib/review");

const router = Router();
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
const row = (r) =>
  r
    ? {
        ...r,
        created_at: Number(r.created_at),
        cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      }
    : null;

// 状态：是否配置 Key、用量、余额、新闻开关
router.get(
  "/status",
  wrap(async () => {
    await ai.ensureConf();
    return {
      provider: cfg.ai.provider,
      model: ai.model(),
      hasKey: ai.hasKey(),
      key: ai.keyInfo(),
      usage: await ai.usage(),
      balance: await ai.balance(),
      settings: await review.getAiSettings(),
      busy: review.isBusy(),
      schedule: "每天 UTC 00:05（北京时间 08:05）自动生成前一天的复盘",
      price: ai.priceOf(ai.model()),
    };
  }),
);

// 复盘列表（每天取最新一份）
router.get(
  "/daily",
  wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 60, 365);
    const { rows } = await dbQuery(
      `SELECT DISTINCT ON (day) id, day, created_at::float8 AS created_at, status, trigger, cost_usd,
              content->>'headline' AS headline, (facts->'account'->>'dayPnl')::float8 AS day_pnl, (facts->'trading'->>'closed')::int AS closed
       FROM trade_reviews WHERE kind='daily' ORDER BY day DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(row);
  }),
);

router.get(
  "/daily/:day",
  wrap(async (req, res) => {
    const { rows } = await dbQuery(
      `SELECT *, created_at::float8 AS created_at FROM trade_reviews WHERE kind='daily' AND day=$1 ORDER BY id DESC`,
      [req.params.day],
    );
    if (!rows.length) {
      res.status(404);
      return { error: "这一天还没有复盘" };
    }
    return {
      latest: row(rows[0]),
      versions: rows.map((r) => ({
        id: r.id,
        created_at: Number(r.created_at),
        status: r.status,
        trigger: r.trigger,
        cost_usd: r.cost_usd,
      })),
    };
  }),
);

// 手动生成 / 重新生成某天复盘（默认昨天）
router.post(
  "/daily/generate",
  wrap(async (req, res) => {
    const day = String(req.body?.day || ai.dayKey(Date.now() - 86400_000));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > ai.dayKey()) {
      res.status(400);
      return { error: "日期不正确" };
    }
    const r = await review.generateDaily(day, "manual");
    if (!r.ok && r.status !== "error") res.status(409);
    return { ...r, day };
  }),
);

// 市场解读
router.get(
  "/market",
  wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const { rows } = await dbQuery(
      `SELECT *, created_at::float8 AS created_at FROM trade_reviews WHERE kind='market' ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(row);
  }),
);
router.post(
  "/market",
  wrap(async (_req, res) => {
    const r = await review.generateMarket();
    if (!r.ok) res.status(409);
    return r;
  }),
);

// 只看数字（免费，不调用 AI）：预览某天的事实数据
router.get(
  "/facts/:day",
  wrap(async (req) => review.dailyFacts(req.params.day)),
);

// 可选模型（用当前 Key 向 DeepSeek 查询，免费）
router.get(
  "/models",
  wrap(async () => ai.listModels()),
);

// 保存 API Key / 模型（Key 会先验证；修改记录里只保存打码后的 Key）
router.post(
  "/ai-config",
  wrap(async (req, res) => {
    const r = await ai.updateConfig(
      { apiKey: req.body?.apiKey, model: req.body?.model },
      req.body?.reason,
    );
    if (!r.ok) res.status(400);
    return r;
  }),
);

// 新闻开关
router.post(
  "/settings",
  wrap(async (req, res) => {
    const r = await review.setNewsEnabled(
      req.body?.newsEnabled,
      req.body?.reason,
    );
    if (!r.ok) res.status(400);
    return r;
  }),
);

module.exports = router;
