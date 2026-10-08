/** CLI 迁移与后台压实共享的 PostgreSQL 会话锁。 */
const MIGRATION_LOCK = 2026100701;
const CERTIFICATION_FIELDS = [
  'verifiedBlockId',
  'verifiedEntries',
  'verifiedGeneration',
  'digest',
  'switchedComplete',
  'switchedGeneration',
  'restoreBlockId',
  'restoredEntries',
  'restoreDigest',
  'restoredComplete',
  'restoredBlockId',
  'restoredAt',
];

/** 生成实例维护及迁移进度键。 @param {string} deviceId 设备 @param {string} localId 实例 @returns {string} 键 */
function migrationProgressName(deviceId, localId) {
  return `migration:${deviceId}:${localId}`;
}

/** 不可变块布局改变后丢弃过期认证，保留历史补齐及维护标记。 @param {Object} progress 进度 @returns {Object} 新进度 */
function invalidateStorageCertification(progress = {}) {
  const result = { ...progress };
  for (const key of CERTIFICATION_FIELDS) delete result[key];
  return result;
}

module.exports = { MIGRATION_LOCK, migrationProgressName, invalidateStorageCertification };
