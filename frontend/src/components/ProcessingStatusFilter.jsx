/** 两张付款页面共用的人工处理状态筛选；空值查询全部（含异常）。 */
export default function ProcessingStatusFilter({ value, onChange }) {
  return (
    <select
      className="input"
      aria-label="处理状态筛选"
      value={value}
      onChange={event => onChange(event.target.value)}
    >
      <option value="">全部处理状态</option>
      <option value="pending">待处理</option>
      <option value="processing">处理中</option>
      <option value="completed">已完成</option>
      <option value="exception">异常</option>
    </select>
  );
}
