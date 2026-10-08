const { createHash } = require('crypto');

const MAX_PERIOD = 8;
const MIN_REPEATS = 4;
const MAX_QUERY_POINTS = 200;
const MAX_MESSAGE_POINTS = 1048576;
const MAX_TOTAL_POINTS = 1048576;
const MAX_MESSAGES = 32768;
const MAX_KEYS = 256;
const MAX_CACHED_CYCLES = MAX_KEYS * MAX_PERIOD;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;

function primitiveLength(cycle) {
  for (let size = 1; size <= cycle.length; size++) {
    if (cycle.length % size) continue;
    let equal = true;
    for (let index = size; index < cycle.length; index++) {
      if (cycle[index] !== cycle[index % size]) {
        equal = false;
        break;
      }
    }
    if (equal) return size;
  }
  return cycle.length;
}

function canonicalCycle(cycle) {
  const size = primitiveLength(cycle);
  let first = 0;
  for (let start = 1; start < size; start++) {
    for (let index = 0; index < size; index++) {
      const next = cycle[(start + index) % size];
      const prior = cycle[(first + index) % size];
      if (next === prior) continue;
      if (next < prior) first = start;
      break;
    }
  }
  return Array.from({ length: size }, (_, index) => cycle[(first + index) % size]);
}

function cycleKey(cycle) {
  return createHash('sha256').update(JSON.stringify(cycle)).digest('hex');
}

/**
 * 全词短原周期查询的可选必要条件；不改变原字面包含匹配。
 * Unicode按codepoint数值处理，不做大小写或NFC折叠。
 * @param {string} keyword 完整关键词，最多200个codepoint
 * @returns {{key: string, repeats: number}|null} 非完整至少四次短周期重复时禁用
 */
function repeatQuery(keyword) {
  try {
    if (typeof keyword !== 'string') return null;
    const points = [];
    for (const point of keyword) {
      if (points.length >= MAX_QUERY_POINTS) return null;
      const code = point.codePointAt(0);
      if (code >= FIRST_SURROGATE && code <= LAST_SURROGATE) return null;
      points.push(code);
    }
    const maximum = Math.min(MAX_PERIOD, Math.floor(points.length / MIN_REPEATS));
    for (let size = 1; size <= maximum; size++) {
      if (points.length % size) continue;
      let equal = true;
      for (let index = size; index < points.length; index++) {
        if (points[index] !== points[index % size]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        return {
          key: cycleKey(canonicalCycle(points.slice(0, size))),
          repeats: points.length / size,
        };
      }
    }
    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * 完整扫描每条消息的所有重叠短周期run，返回保守重复上界；不跨消息拼接。
 * 对距离p相等的最大连续run，正文区间从首个比较点前p点开始，长equalRun+p。
 * 因而任何真实全词重复子串都被其primitive周期的run覆盖；旋转后key一致。
 * 比较O(8n)，先逐字元计数才分配单消息Uint32Array，最多4MiB字元数组。
 * @param {string[]} messages 已按原v1语义规范化的逐条正文
 * @returns {Object<string, number>|null} 完整无候选为{}；预算超限或异常为安全fallback null
 */
function repeatLimits(messages) {
  try {
    if (!Array.isArray(messages)) return null;
    const messageCount = messages.length;
    if (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > MAX_MESSAGES)
      return null;
    const limits = {};
    const cache = new Map();
    let keys = 0;
    let totalPoints = 0;
    for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
      const message = messages[messageIndex];
      if (typeof message !== 'string') return null;
      // 不先Array.from整条异常大正文：计数超预算立即返回null，不分配字元数组。
      let count = 0;
      const iterator = message[Symbol.iterator]();
      let next = iterator.next();
      while (!next.done) {
        const code = next.value.codePointAt(0);
        // 原v1正文应已UTF8规范化；异常孤立surrogate必须禁用而非漏判UTF16子串。
        if (code >= FIRST_SURROGATE && code <= LAST_SURROGATE) return null;
        count++;
        if (count > MAX_MESSAGE_POINTS || totalPoints + count > MAX_TOTAL_POINTS) return null;
        next = iterator.next();
      }
      totalPoints += count;
      if (count < MIN_REPEATS) continue;
      const points = new Uint32Array(count);
      let offset = 0;
      for (const point of message) points[offset++] = point.codePointAt(0);
      const record = (start, length, period) => {
        if (length < MIN_REPEATS * period) return true;
        const cycle = Array.from(points.subarray(start, start + period));
        const cacheKey = cycle.join(',');
        let normalized = cache.get(cacheKey);
        if (!normalized) {
          if (cache.size >= MAX_CACHED_CYCLES) return false;
          const canonical = canonicalCycle(cycle);
          normalized = { key: cycleKey(canonical), size: canonical.length };
          cache.set(cacheKey, normalized);
        }
        if (limits[normalized.key] === undefined) {
          if (keys >= MAX_KEYS) return false;
          keys++;
          limits[normalized.key] = 0;
        }
        limits[normalized.key] = Math.max(
          limits[normalized.key],
          Math.floor(length / normalized.size)
        );
        return true;
      };
      const maximum = Math.min(MAX_PERIOD, Math.floor(count / MIN_REPEATS));
      for (let period = 1; period <= maximum; period++) {
        let equalRun = 0;
        for (let index = period; index < count; index++) {
          if (points[index] === points[index - period]) {
            equalRun++;
          } else {
            if (equalRun && !record(index - equalRun - period, equalRun + period, period))
              return null;
            equalRun = 0;
          }
        }
        if (equalRun && !record(count - equalRun - period, equalRun + period, period)) return null;
      }
    }
    return limits;
  } catch (_error) {
    return null;
  }
}

module.exports = { repeatLimits, repeatQuery };
