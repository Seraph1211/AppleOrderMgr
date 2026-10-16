/** 展示服务端计算的订单 TAG；来源优先级与身份匹配均由服务端判定。 */
export default function RecipientTag({ value, state, source, showSource = false }) {
  const present =
    (state === 'present' || state == null) && typeof value === 'string' && value.trim() !== '';
  const sourceLabel =
    source === 'aos' ? 'AOS 原始 TAG' : source === 'recipient' ? '取机人 TAG 兜底' : '';
  return (
    <span
      className={`break-words whitespace-pre-wrap ${present ? '' : 'text-gray-500'}`}
      title={
        present
          ? sourceLabel || undefined
          : 'AOS TAG 缺失，且无姓名和身份证后四位唯一匹配的有效取机人 TAG'
      }
    >
      {present ? value : 'TAG 缺失'}
      {present && showSource && sourceLabel && (
        <span className="ml-1 text-xs text-gray-500">（{sourceLabel}）</span>
      )}
    </span>
  );
}
