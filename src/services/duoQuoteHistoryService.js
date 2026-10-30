const { Op } = require('sequelize');
const { sequelize, DuoQuotePricingVersion: Version } = require('../models');
const sourceRepository = require('../repositories/quoteSourceRepository');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const duoQuotePricingService = require('./duoQuotePricingService');
const {
  DEFAULT_MARKUP,
  mergeDuoItems,
  normalizeDuoSource,
  sourceUnavailable,
  validateMarkup,
} = require('./duoQuotePricingCore');

const RANGE_DURATIONS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
});
const STORAGE_ORDER = Object.freeze([256, 512, 1024, 2048]);
const COLOR_ORDER = Object.freeze(['夜空色', '星光白色']);
const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const historyCache = new Map();

function identity(storageGb, color) {
  return `${storageGb}|${color}`;
}

function parseRange(query, now) {
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).some(key => key !== 'range')
  ) {
    throw ApiError.badRequest('价格走势查询参数无效');
  }
  const range = query.range === undefined ? '7d' : String(query.range);
  if (!Object.hasOwn(RANGE_DURATIONS, range)) {
    throw ApiError.badRequest('价格走势范围仅支持24h、7d、30d或all');
  }
  const duration = RANGE_DURATIONS[range];
  return {
    range,
    requestedFrom: duration === null ? null : new Date(now.getTime() - duration),
  };
}

function normalizeSnapshot(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length !== 8) throw sourceUnavailable();
  const markups = new Map();
  snapshot.forEach(row => {
    if (
      row?.productModel !== 'Duo' ||
      !STORAGE_ORDER.includes(row.storageGb) ||
      !COLOR_ORDER.includes(row.color)
    ) {
      throw sourceUnavailable();
    }
    const key = identity(row.storageGb, row.color);
    if (markups.has(key)) throw sourceUnavailable();
    try {
      markups.set(key, validateMarkup(row.markup));
    } catch (_error) {
      throw sourceUnavailable();
    }
  });
  return markups;
}

function calculateState(sourceItems, markups) {
  if (!sourceItems.length) return new Map();
  const adjustments = sourceItems.map(item => ({
    productKey: item.productKey,
    markup: markups.get(identity(item.storageGb, item.color)) ?? DEFAULT_MARKUP,
  }));
  const state = new Map();
  mergeDuoItems(sourceItems, adjustments, { allowInvalid: true }).forEach(item => {
    state.set(`retail:${identity(item.storageGb, item.color)}`, item.retailPrice);
    state.set(`official:${identity(item.storageGb, item.color)}`, item.officialPrice);
  });
  return state;
}

function appendPoint(pointsByKey, key, point) {
  if (!pointsByKey.has(key)) pointsByKey.set(key, []);
  const points = pointsByKey.get(key);
  if (points.at(-1)?.changedAt === point.changedAt) {
    points[points.length - 1] = {
      ...point,
      baseline: points.at(-1).baseline || point.baseline,
    };
  } else points.push(point);
}

function appendChangedPoints(pointsByKey, previousState, nextState, changedAt) {
  nextState.forEach((price, key) => {
    if (previousState.has(key) && Object.is(previousState.get(key), price)) return;
    appendPoint(pointsByKey, key, { changedAt, price, baseline: false });
  });
}

function appendBaseline(pointsByKey, state, rangeStart) {
  state.forEach((price, key) => {
    appendPoint(pointsByKey, key, {
      changedAt: rangeStart.toISOString(),
      price,
      baseline: true,
    });
  });
}

function samePoints(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        point.changedAt === right[index].changedAt &&
        point.price === right[index].price &&
        point.baseline === right[index].baseline
    )
  );
}

function seriesForCapacity(storageGb, currentItems, pointsByKey) {
  const products = currentItems
    .filter(item => item.storageGb === storageGb)
    .sort((left, right) => COLOR_ORDER.indexOf(left.color) - COLOR_ORDER.indexOf(right.color));
  const retailSeries = products.map(item => ({
    key: `retail-${item.color === '夜空色' ? 'midnight' : 'starlight'}`,
    label: `${item.color}零售价`,
    productKey: item.productKey,
    productName: item.productName,
    color: item.color,
    points: pointsByKey.get(`retail:${identity(storageGb, item.color)}`) || [],
  }));
  const officialByColor = products.map(item => ({
    key: `official-${item.color === '夜空色' ? 'midnight' : 'starlight'}`,
    label: `${item.color}官网价`,
    color: item.color,
    points: pointsByKey.get(`official:${identity(storageGb, item.color)}`) || [],
  }));
  let officialSeries = officialByColor;
  if (samePoints(officialByColor[0]?.points || [], officialByColor[1]?.points || [])) {
    officialSeries = [
      {
        key: 'official',
        label: '官网价',
        color: null,
        points: officialByColor[0]?.points || [],
      },
    ];
  }
  return { storageGb, retailSeries, officialSeries };
}

async function loadPricingEvents(rangeEnd) {
  const rows = await sequelize.transaction({ readOnly: true }, transaction =>
    Version.findAll({
      attributes: ['revision', 'snapshot', 'createdAt'],
      where: { createdAt: { [Op.lte]: rangeEnd } },
      order: [
        ['createdAt', 'ASC'],
        ['revision', 'ASC'],
      ],
      transaction,
    })
  );
  return rows.map(row => ({
    at: new Date(row.createdAt),
    type: 'pricing',
    markups: normalizeSnapshot(row.snapshot),
  }));
}

async function buildHistory(current, range, requestedFrom, now) {
  const sourceHistory = await sourceRepository.fetchDuoHistory({
    from: requestedFrom,
    to: now,
  });
  const availableFrom = sourceHistory.availableFrom ? new Date(sourceHistory.availableFrom) : null;
  if (!availableFrom || !Number.isFinite(availableFrom.getTime())) throw sourceUnavailable();
  const rangeStart = requestedFrom && requestedFrom > availableFrom ? requestedFrom : availableFrom;
  const sourceEvents = sourceHistory.batches.map(batch => ({
    at: new Date(batch.sourceUpdatedAt),
    type: 'source',
    items: normalizeDuoSource(batch),
  }));
  const pricingEvents = await loadPricingEvents(now);
  const events = [...sourceEvents, ...pricingEvents].sort(
    (left, right) =>
      left.at.getTime() - right.at.getTime() ||
      (left.type === right.type ? 0 : left.type === 'source' ? -1 : 1)
  );

  let sourceItems = [];
  let markups = new Map();
  let previousState = new Map();
  let baselineAdded = false;
  const pointsByKey = new Map();
  events.forEach(event => {
    if (!baselineAdded && event.at >= rangeStart) {
      appendBaseline(pointsByKey, previousState, rangeStart);
      baselineAdded = true;
    }
    if (event.type === 'source') sourceItems = event.items;
    else markups = event.markups;
    const nextState = calculateState(sourceItems, markups);
    if (event.at >= rangeStart && event.at <= now) {
      appendChangedPoints(pointsByKey, previousState, nextState, event.at.toISOString());
    }
    previousState = nextState;
  });
  if (!baselineAdded) appendBaseline(pointsByKey, previousState, rangeStart);

  return {
    enabled: true,
    version: current.version,
    range,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: now.toISOString(),
    availableFrom: availableFrom.toISOString(),
    updatedAt: new Date(current.updatedAt).toISOString(),
    lastCheckedAt: current.lastCheckedAt ? new Date(current.lastCheckedAt).toISOString() : null,
    stale: current.stale,
    capacities: STORAGE_ORDER.map(storageGb =>
      seriesForCapacity(storageGb, current.items, pointsByKey)
    ),
  };
}

function contextKey(range, current) {
  return `${range}:${current.version}:${new Date(current.sourceUpdatedAt).toISOString()}`;
}

/**
 * 重建无需登录的Duo零售价与官网价走势，不泄露批发价或加价规则。
 * @param {Object} query 查询参数
 * @returns {Promise<Object>} 公开价格走势
 */
async function getPublicDuoQuoteHistory(query = {}) {
  try {
    if (process.env.QUOTE_DUO_PUBLIC_ENABLED !== 'true') {
      throw new ApiError(503, 'QUOTE_PAGE_PAUSED', '报价页面暂未开放');
    }
    const now = new Date();
    const { range, requestedFrom } = parseRange(query, now);
    let current = await duoQuotePricingService.getAdminQuotes();
    let key = contextKey(range, current);
    const cached = historyCache.get(key);
    if (cached && now.getTime() - cached.cachedAt < CACHE_TTL_MS) return cached.data;

    let data = await buildHistory(current, range, requestedFrom, now);
    const latest = await duoQuotePricingService.getAdminQuotes();
    const latestKey = contextKey(range, latest);
    if (latestKey !== key) {
      current = latest;
      key = latestKey;
      data = await buildHistory(current, range, requestedFrom, now);
    }
    if (historyCache.size >= MAX_CACHE_ENTRIES) historyCache.clear();
    historyCache.set(key, { cachedAt: now.getTime(), data });
    return data;
  } catch (error) {
    if (error instanceof ApiError && [400, 503].includes(error.statusCode)) throw error;
    logger.error('读取Duo价格走势失败', {
      errorType: error.name,
      errorCode: error.code || null,
    });
    throw sourceUnavailable();
  }
}

module.exports = {
  getPublicDuoQuoteHistory,
  buildHistory,
  parseRange,
};
