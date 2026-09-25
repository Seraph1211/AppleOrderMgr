/**
 * 生成订单卡片使用的邮件取货信息文案。
 * @param {Object|null|undefined} pickup - 邮件取货信息
 * @returns {{storeName: string, schedule: string}}
 */
export function getOrderPickupDisplay(pickup) {
  const storeName = pickup?.storeName?.trim() || '门店待确认';
  const time =
    pickup?.appointmentMode === 'business_hours'
      ? '营业时间内'
      : [pickup?.startTime, pickup?.endTime].filter(Boolean).join('–');
  const schedule = [pickup?.pickupDate, time].filter(Boolean).join(' ') || '时间待确认';

  return { storeName, schedule };
}
