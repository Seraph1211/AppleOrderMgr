/** 两张付款页面统一的官网状态标签外观，颜色沿用付款状态展示规则。 */
export function getOfficialStatusTagClass(paymentStatus) {
  return `inline-flex items-center rounded-md px-2 py-1 text-sm font-medium ${paymentStatus === 'paid' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-primary'}`;
}
