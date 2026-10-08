const crypto = require('crypto');
const { performance } = require('perf_hooks');

const LIMITS = Object.freeze({
  bodyBytes: 16384,
  saltBytes: 1024,
  cookieBytes: 4096,
  timeoutMs: 15000,
  operations: 1000000,
  depth: 8,
  maximumTimestampMs: 8640000000000000,
});
const MILLISECONDS_PER_SECOND = 1000;
const COOKIE_EXPIRY_INDEX = 1;
const MIN_COOKIE_PARTS = 3;
const MAX_INT64 = 9223372036854775807n;
const BIGINT_ZERO = 0n;
const BIGINT_ONE = 1n;
const DIGEST_LENGTHS = Object.freeze({ sha256: 64, sha384: 96, sha512: 128 });
const FACTOR_FIELDS = ['low', 'high', 'parts', 'result'];

function fault(code) {
  return Object.assign(new Error(code), { code });
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function parseTimeout(value) {
  if (value === undefined || value === 0) return LIMITS.timeoutMs;
  if (!positiveInteger(value)) throw fault('SHIELD_TIMEOUT_INVALID');
  return Math.min(value, LIMITS.timeoutMs);
}

/**
 * 仅解析 JSON 中明确的挑战类型，不靠正文子串分派，不执行远端脚本。
 * 因数计算支持正整数闭区间 [low, high]、可重复因数；这不是未完整恢复的 IL 等价声明。
 * @param {string} body 有限长度的 JSON 正文。
 * @returns {object} 经校验、可 JSON 序列化的计算输入；不复制 flagskv/jsa。
 */
function parseShieldChallenge(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > LIMITS.bodyBytes)
    throw fault('SHIELD_BODY_INVALID');
  let model;
  try {
    model = JSON.parse(body);
  } catch (_error) {
    throw fault('SHIELD_JSON_INVALID');
  }
  if (!model || typeof model !== 'object' || Array.isArray(model))
    throw fault('SHIELD_MODEL_INVALID');
  const hasAlgorithm = Object.prototype.hasOwnProperty.call(model, 'algorithm');
  const hasFactorField = FACTOR_FIELDS.some(field => Object.hasOwn(model, field));
  const timeoutMs = parseTimeout(model.timeout);
  if (hasAlgorithm) {
    if (hasFactorField) throw fault('SHIELD_TYPE_AMBIGUOUS');
    if (typeof model.algorithm !== 'string' || !/^sha-?(256|384|512)$/i.test(model.algorithm))
      throw fault('SHIELD_ALGORITHM_UNSUPPORTED');
    const algorithm = model.algorithm.toLowerCase().replace('-', '');
    if (
      typeof model.salt !== 'string' ||
      Buffer.byteLength(model.salt) > LIMITS.saltBytes ||
      typeof model.challenge !== 'string' ||
      model.challenge.length !== DIGEST_LENGTHS[algorithm] ||
      !/^[a-f0-9]+$/.test(model.challenge)
    )
      throw fault('SHIELD_HASH_INPUT_INVALID');
    return Object.freeze({
      type: 'hash',
      algorithm,
      salt: model.salt,
      challenge: model.challenge,
      timeoutMs,
    });
  }
  if (Object.hasOwn(model, 'salt') || Object.hasOwn(model, 'challenge'))
    throw fault('SHIELD_TYPE_AMBIGUOUS');
  if (
    !FACTOR_FIELDS.every(field => Object.hasOwn(model, field)) ||
    !positiveInteger(model.low) ||
    !positiveInteger(model.high) ||
    model.low > model.high ||
    !positiveInteger(model.parts, LIMITS.depth) ||
    typeof model.result !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(model.result) ||
    BigInt(model.result) > MAX_INT64
  )
    throw fault('SHIELD_FACTOR_INPUT_INVALID');
  return Object.freeze({
    type: 'factor',
    low: model.low,
    high: model.high,
    parts: model.parts,
    result: model.result,
    timeoutMs,
  });
}

function computationBudget(model, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('SHIELD_BUDGET_INVALID');
  const {
    maxDurationMs = LIMITS.timeoutMs,
    maxOperations = LIMITS.operations,
    maxDepth = LIMITS.depth,
  } = options;
  if (
    Object.keys(options).some(
      key => !['maxDurationMs', 'maxOperations', 'maxDepth'].includes(key)
    ) ||
    !positiveInteger(maxDurationMs, LIMITS.timeoutMs) ||
    !positiveInteger(maxOperations, LIMITS.operations) ||
    !positiveInteger(maxDepth, LIMITS.depth)
  )
    throw fault('SHIELD_BUDGET_INVALID');
  const started = performance.now();
  const duration = Math.min(model.timeoutMs, maxDurationMs);
  let operations = 0;
  let reason = null;
  const elapsed = () => Math.max(0, performance.now() - started);
  const expired = () => {
    if (!reason && elapsed() >= duration) reason = 'TIMEOUT';
    return Boolean(reason);
  };
  return {
    maxDepth,
    step() {
      if (expired()) return false;
      if (operations >= maxOperations) {
        reason = 'OPERATION_LIMIT';
        return false;
      }
      operations += 1;
      return true;
    },
    expired,
    result(number, fallbackReason = 'NOT_FOUND') {
      expired();
      return {
        type: model.type,
        found: number !== null && !reason,
        number: reason ? null : number,
        took: Math.ceil(elapsed()),
        operations,
        reason: reason || (number === null ? fallbackReason : 'FOUND'),
        serverAccepted: null,
      };
    },
  };
}

function solveHash(model, budget) {
  for (let candidate = 0; candidate < LIMITS.operations; candidate += 1) {
    if (!budget.step()) return budget.result(null);
    const digest = crypto
      .createHash(model.algorithm)
      .update(`${model.salt}${candidate}`, 'utf8')
      .digest('hex');
    if (digest === model.challenge) return budget.result(candidate);
  }
  return budget.result(null);
}

function solveFactor(model, budget) {
  if (model.parts > budget.maxDepth) return budget.result(null, 'DEPTH_LIMIT');
  const high = BigInt(model.high);
  const highPowers = Array.from(
    { length: model.parts + 1 },
    (_value, power) => high ** BigInt(power)
  );
  const factors = [];
  const search = (remaining, parts, minimum) => {
    if (!budget.step()) return null;
    // 至多八层，所有乘积和整除用 BigInt，避免 Number 精度丢失产生假解。
    if (remaining < minimum ** BigInt(parts) || remaining > highPowers[parts]) return null;
    if (parts === 1) return [...factors, Number(remaining)];
    for (let factor = minimum; factor <= high; factor += BIGINT_ONE) {
      if (!budget.step()) return null;
      if (factor ** BigInt(parts) > remaining) break;
      if (remaining % factor !== BIGINT_ZERO) continue;
      factors.push(Number(factor));
      const found = search(remaining / factor, parts - 1, factor);
      factors.pop();
      if (found || budget.expired()) return found;
    }
    return null;
  };
  return budget.result(search(BigInt(model.result), model.parts, BigInt(model.low)));
}

/**
 * 有界离线计算；只有 found=true 才返回答案，超时/预算耗尽绝不返回未找到的候选。
 * 此函数没有网络或 Cookie 写入；serverAccepted=null 表示尚无服务端接受证据。
 * @param {string} body 原始挑战 JSON；拒绝不支持或混合的类型。
 * @param {object} options 只允许缩小本地时间、操作次数和递归深度预算。
 * @returns {object} 计算结果、耗时、操作数及明确终止原因。
 */
function solveShieldChallenge(body, options = {}) {
  const model = parseShieldChallenge(body);
  const budget = computationBudget(model, options);
  return model.type === 'hash' ? solveHash(model, budget) : solveFactor(model, budget);
}

/**
 * 校验 shld_bt_ck 第二段的到期秒及浏览器 Cookie 到期时间；不验证服务端签名。
 * @param {object|undefined} cookie 浏览器返回的 Cookie 对象。
 * @param {number} nowMs 当前 Unix 毫秒时间。
 * @returns {object} 本地有效性；serverAccepted 始终为 null。
 */
function inspectShieldCookie(cookie, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > LIMITS.maximumTimestampMs)
    throw fault('SHIELD_TIME_INVALID');
  const invalid = reason => ({ valid: false, expiresAt: null, reason, serverAccepted: null });
  if (!cookie || cookie.name !== 'shld_bt_ck') return invalid('COOKIE_MISSING');
  if (typeof cookie.value !== 'string' || Buffer.byteLength(cookie.value) > LIMITS.cookieBytes)
    return invalid('COOKIE_INVALID');
  const parts = cookie.value.split('|');
  if (
    parts.length < MIN_COOKIE_PARTS ||
    parts.some(part => !part) ||
    !/^[1-9]\d{0,12}$/.test(parts[COOKIE_EXPIRY_INDEX])
  )
    return invalid('COOKIE_INVALID');
  let expiresAt = Number(parts[COOKIE_EXPIRY_INDEX]) * MILLISECONDS_PER_SECOND;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > LIMITS.maximumTimestampMs)
    return invalid('COOKIE_INVALID');
  if (cookie.expires !== undefined && cookie.expires !== -1) {
    if (
      typeof cookie.expires !== 'number' ||
      !Number.isFinite(cookie.expires) ||
      cookie.expires < 0
    )
      return invalid('COOKIE_INVALID');
    const browserExpiresAt = Math.floor(cookie.expires * MILLISECONDS_PER_SECOND);
    if (!Number.isSafeInteger(browserExpiresAt) || browserExpiresAt > LIMITS.maximumTimestampMs)
      return invalid('COOKIE_INVALID');
    expiresAt = Math.min(expiresAt, browserExpiresAt);
  }
  return {
    valid: expiresAt > nowMs,
    expiresAt,
    reason: expiresAt > nowMs ? 'LOCALLY_VALID' : 'COOKIE_EXPIRED',
    serverAccepted: null,
  };
}

module.exports = { parseShieldChallenge, solveShieldChallenge, inspectShieldCookie };
