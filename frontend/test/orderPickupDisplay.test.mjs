import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrderPickupDisplay } from '../src/utils/orderPickupDisplay.js';

test('取货信息显示固定日期和时间段', () => {
  assert.deepEqual(
    getOrderPickupDisplay({
      storeName: ' Apple 长沙国金中心 ',
      pickupDate: '2026-09-25',
      startTime: '18:30',
      endTime: '18:45',
      appointmentMode: 'fixed',
    }),
    {
      storeName: 'Apple 长沙国金中心',
      schedule: '2026-09-25 18:30–18:45',
    }
  );
});

test('营业时间取货保留日期，缺失字段显示待确认', () => {
  assert.deepEqual(
    getOrderPickupDisplay({ pickupDate: '2026-09-26', appointmentMode: 'business_hours' }),
    {
      storeName: '门店待确认',
      schedule: '2026-09-26 营业时间内',
    }
  );
  assert.deepEqual(getOrderPickupDisplay(null), {
    storeName: '门店待确认',
    schedule: '时间待确认',
  });
});
