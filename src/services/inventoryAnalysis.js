const inventoryFailure = require('../utils/inventoryFailure');
const { QueryTypes } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { parseFilters } = require('./inventoryPolicy');

/** 统一筛选统计，不把缺失采集填成零；SQL 分组避免加载全部历史明细。 */
class InventoryAnalysis {
  constructor(service) {
    this.s = service;
  }
  /** 按同一口径返回小时、规格、热力图和全国榜单。 */
  async get(query) {
    try {
      let { from, to, metric, source } = this.s.historyQuery(query);
      const requestedFrom = from;
      const requestedTo = to;
      if (metric === 'all') throw ApiError.badRequest('分析请选择到货、检测、首次或恢复口径');
      const settings = await this.s.getSettings();
      const now = Date.now();
      const detailDays =
        metric === 'detections' ? settings.config.samplesDays : settings.config.eventsDays;
      const detailAvailable = from >= now - detailDays * 86400000;
      const bucketMinutes = Number(query.bucketMinutes || 60);
      if (![10, 20, 30, 60].includes(bucketMinutes))
        throw ApiError.badRequest('时间桶应为 10/20/30/60 分钟');
      if (!detailAvailable && bucketMinutes !== 60)
        throw ApiError.badRequest('此时间范围的明细已超保留期，只能查看小时统计');
      if (to - from > 31 * 86400000 && bucketMinutes < 60)
        throw ApiError.badRequest('细粒度热力图最多查询 31 天');
      if (from < now - settings.config.hourlyDays * 86400000)
        throw ApiError.badRequest('超出统计保留期');
      if (!detailAvailable) {
        from = Math.floor(from / 3600000) * 3600000;
        to = Math.ceil(to / 3600000) * 3600000;
      }
      const filters = parseFilters(query);
      const replacements = { from, to };
      const clauses = [];
      for (const [field, values] of Object.entries(filters)) {
        clauses.push(`body->>'${field}' IN (:f_${field})`);
        replacements[`f_${field}`] = values;
      }
      if (source !== 'all') {
        clauses.push("body->>'source' = :source");
        replacements.source = source;
      }
      const base = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
      const table = detailAvailable
        ? metric === 'detections'
          ? 'inventory_samples'
          : 'inventory_events'
        : 'inventory_hourly';
      const time = detailAvailable ? "(body->>'observedAt')::bigint" : "(body->>'bucket')::bigint";
      const count = detailAvailable ? 'COUNT(*)' : `SUM(COALESCE((body->>'${metric}')::bigint, 0))`;
      const metricClause = detailAvailable
        ? metric === 'detections'
          ? " AND body->>'status' = 'in_stock'"
          : ` AND body->>'kind' = '${metric === 'arrivals' ? 'arrival' : metric}'`
        : '';
      const where = `${time} >= :from AND ${time} < :to${base}${metricClause}`;
      const groups = {
        hours: `EXTRACT(HOUR FROM to_timestamp(${time}/1000.0) AT TIME ZONE 'Asia/Shanghai')::text`,
        configurations: "concat_ws(' · ', body->>'model', body->>'capacity', body->>'color')",
        cities: "body->>'city'",
        stores: "concat_ws(' · ', body->>'city', body->>'storeName')",
        heatmap: `(FLOOR(${time}::numeric / ${bucketMinutes * 60000}) * ${bucketMinutes * 60000})::text`,
      };
      const result = {};
      for (const [name, key] of Object.entries(groups)) {
        const rows = await this.s.db.query(
          `SELECT ${key} AS key, ${count}::bigint AS count FROM ${table} WHERE ${where} GROUP BY ${key} ORDER BY count DESC, key ASC`,
          { type: QueryTypes.SELECT, replacements }
        );
        result[name] = rows.map(r => ({ key: r.key, count: Number(r.count) }));
      }
      // 计划分母来自轮次，不来自成功结果；包含停机压缩记录及暂停失败。
      const roundClauses = [
        "(body->>'plannedAt')::bigint < :to",
        "COALESCE((body->>'plannedAt')::bigint + COALESCE((body->>'plannedCount')::bigint, 1) * (body->>'intervalSeconds')::bigint * 1000, 0) > :from",
      ];
      if (source !== 'all') roundClauses.push("body->>'source' = :source");
      const rounds = await this.s.db.query(
        `SELECT body->>'status' AS status, body->>'plannedAt' AS at, body->>'plannedCount' AS count, body->>'intervalSeconds' AS interval, body->'products' AS products, body->'stores' AS stores FROM inventory_rounds WHERE ${roundClauses.join(' AND ')}`,
        { type: QueryTypes.SELECT, replacements }
      );
      const coverage = new Map();
      let planned = 0;
      let complete = 0;
      const matchScope = (row, fields) =>
        Object.entries(filters)
          .filter(([key]) => fields.includes(key))
          .every(([key, values]) => values.includes(row[key]));
      for (const round of rounds) {
        if (
          !round.products.some(p => matchScope(p, ['sku', 'model', 'capacity', 'color'])) ||
          !round.stores.some(s => matchScope(s, ['city', 'storeCode']))
        )
          continue;
        const step = Number(round.interval) * 1000;
        const countRounds = Number(round.count || 1);
        const start = Math.max(0, Math.ceil((from - Number(round.at)) / step));
        const end = Math.min(countRounds, Math.ceil((to - Number(round.at)) / step));
        for (let i = start; i < end; i += 1) {
          planned += 1;
          if (round.status === 'complete') complete += 1;
          const bucket =
            Math.floor((Number(round.at) + i * step) / (bucketMinutes * 60000)) *
            bucketMinutes *
            60000;
          const item = coverage.get(bucket) || { planned: 0, complete: 0 };
          item.planned += 1;
          item.complete += round.status === 'complete' ? 1 : 0;
          coverage.set(bucket, item);
        }
      }
      const values = new Map(result.heatmap.map(r => [Number(r.key), r.count]));
      result.heatmap = [];
      for (
        let timeBucket = Math.floor(from / (bucketMinutes * 60000)) * bucketMinutes * 60000;
        timeBucket < to;
        timeBucket += bucketMinutes * 60000
      ) {
        const sampleCoverage = coverage.get(timeBucket) || { planned: 0, complete: 0 };
        const known = values.has(timeBucket);
        result.heatmap.push({
          key: String(timeBucket),
          count: known
            ? values.get(timeBucket)
            : sampleCoverage.planned > 0 && sampleCoverage.complete === sampleCoverage.planned
              ? 0
              : null,
          ...sampleCoverage,
          gap: sampleCoverage.planned === 0 || sampleCoverage.complete < sampleCoverage.planned,
        });
      }
      return {
        ...result,
        metric,
        from,
        to,
        bucketMinutes,
        detailAvailable,
        requestedFrom,
        requestedTo,
        coverage: {
          planned,
          complete,
          incomplete: planned - complete,
          ratio: planned ? complete / planned : null,
        },
        notice: detailAvailable
          ? '观测次数，不代表库存台数或销量；灰色为采集缺口。'
          : `明细已超保留期，仅显示完整小时汇总，无法下钻。实际范围：${new Date(from).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 至 ${new Date(to).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`,
      };
    } catch (error) {
      throw inventoryFailure(error);
    }
  }
}
module.exports = InventoryAnalysis;
