/** 展示服务端提供的当前取机人 TAG 与缺失状态，不使用来源记录回退。 */
export default function RecipientTag({ value, state }) {
  const label = state === 'unlinked' ? '未关联取机人' : '未设置 TAG';
  const present =
    (state === 'present' || state == null) && typeof value === 'string' && value.trim() !== '';
  return (
    <span className={`break-words whitespace-pre-wrap ${present ? '' : 'text-gray-500'}`}>
      {present ? value : label}
    </span>
  );
}
