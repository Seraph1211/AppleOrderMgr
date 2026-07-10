/**
 * 状态枚举常量
 * 统一 AppleID 和取机人的状态定义
 */

export const STATUS_OPTIONS = [
  { value: '未使用', label: '未使用', color: 'gray' },
  { value: '使用中', label: '使用中', color: 'green' },
  { value: '已下架', label: '已下架', color: 'red' },
  { value: '异常', label: '异常', color: 'orange' }
]

export const STATUS_BADGE_MAP = {
  '未使用': { text: '未使用', class: 'badge-secondary' },
  '使用中': { text: '使用中', class: 'badge-success' },
  '已下架': { text: '已下架', class: 'badge-error' },
  '异常': { text: '异常', class: 'badge-warning' }
}

// 旧状态映射到新状态（用于数据迁移和兼容）
export const OLD_STATUS_MAP = {
  'active': '使用中',
  'inactive': '已下架',
  'disabled': '已下架',
  'locked': '异常'
}
