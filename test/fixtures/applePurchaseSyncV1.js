const crypto = require('crypto');

const OBSERVATION_ID = 'synthetic-observation-0001';
const MONITOR_EVENT_ID = 'synthetic-monitor-event-0001';

/** 构造冻结 v1 合成批次；所有 ID 和业务值均不对应真实库存。 @returns {Object} 批次 */
function makeBatch(overrides = {}) {
  const terminalId = overrides.terminalId || crypto.randomUUID();
  const observedAt = '2026-11-05T08:09:10.123Z';
  const changedAt = '2026-11-05T08:08:00.456Z';
  return {
    contractVersion: '1',
    batchId: overrides.batchId || crypto.randomUUID(),
    sentAt: '2026-11-05T08:09:12.345Z',
    mode: 'live',
    sourceHistory: {
      observations: {
        availableFrom: '2026-11-03T02:00:00.000Z',
        completeness: 'complete_from_available_from',
      },
      monitorChanges: {
        availableFrom: '2026-11-05T07:55:00.000Z',
        completeness: 'complete_from_available_from',
      },
    },
    observations: [
      {
        observationId: OBSERVATION_ID,
        sourceSequence: '7449',
        responseReceivedAt: observedAt,
        responseReceivedAtMs: Date.parse(observedAt),
        city: '合成城市',
        storeId: 'apple-store:SYNTHETIC',
        officialStoreId: 'SYNTH',
        storeName: '合成门店',
        partNumber: 'SYNTHETIC-PART-NUMBER',
        productId: 'apple-product:SYNTHETIC-PART-NUMBER',
        productName: '合成机型',
        specification: '合成机型 256GB 合成颜色',
        officialTitle: null,
        color: '合成颜色',
        storage: '256GB',
        family: 'synthetic_family',
        availability: 'available',
      },
    ],
    monitorChanges: [
      {
        eventId: MONITOR_EVENT_ID,
        sourceSequence: '1',
        monitorId: 'monitor-synthetic',
        monitorName: '合成监控',
        changeType: 'configuration_updated',
        changedAt,
        changedAtMs: Date.parse(changedAt),
        previousRevision: 3,
        revision: 4,
        before: { storeIds: ['apple-store:SYNTHETIC'], partNumbers: ['SYNTHETIC-OLD'] },
        after: {
          storeIds: ['apple-store:SYNTHETIC'],
          partNumbers: ['SYNTHETIC-PART-NUMBER'],
        },
        changes: [
          {
            field: 'partNumbers',
            before: ['SYNTHETIC-OLD'],
            after: ['SYNTHETIC-PART-NUMBER'],
          },
        ],
        source: 'user',
        taskId: null,
      },
    ],
    ...overrides,
    terminalId,
  };
}

module.exports = { MONITOR_EVENT_ID, OBSERVATION_ID, makeBatch };
