/** Apple ID 专用状态配色，避免改变取机人状态。 */
export const APPLE_ID_STATUS_BADGES = {
  未使用: { text: '未使用', class: 'badge-info' },
  使用中: { text: '使用中', class: 'badge-success' },
  已下架: { text: '已下架', class: 'bg-gray-100 text-gray-700 border-gray-200' },
  异常: { text: '异常', class: 'badge-error' },
};

/** 返回 Apple ID 状态徽章；未知值使用灰色。 */
export function getAppleIdStatusBadge(status) {
  return (
    APPLE_ID_STATUS_BADGES[status] || {
      text: status || '未知',
      class: 'bg-gray-100 text-gray-700 border-gray-200',
    }
  );
}
