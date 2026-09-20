import { useRef } from 'react';
import TagMultiSelect from './TagMultiSelect';

/** 保留已选零结果项的名称，搜索同时支持来源别名和完整型号。 */
export default function ProductFilter({ options = [], value = [], onChange }) {
  const remembered = useRef(new Map());
  for (const option of options) remembered.current.set(option.value, option);
  const current = new Map(options.map(option => [option.value, option]));
  for (const key of value) {
    if (!current.has(key)) {
      const replacements = options.filter(option => option.keys?.includes(key));
      const replacement = replacements[0];
      if (replacement) {
        if (replacements.length === 1) current.delete(replacement.value);
        current.set(key, {
          ...replacement,
          label:
            replacements.length === 1
              ? replacement.label
              : remembered.current.get(key)?.label || '已选商品（已关联多个型号）',
          count: replacement.keyCounts?.[key] ?? replacement.count,
        });
      }
    }
  }
  const keys = [...new Set([...current.keys(), ...value])];
  const labels = {};
  const searchLabels = {};
  for (const key of keys) {
    const option = current.get(key) || remembered.current.get(key);
    const label = option?.label || '已选商品';
    labels[key] = `${label}（${current.get(key)?.count || 0}）`;
    searchLabels[key] = [label, ...(option?.aliases || [])].join(' ');
  }
  return (
    <TagMultiSelect
      options={keys}
      value={value}
      onChange={onChange}
      optionLabels={labels}
      searchLabels={searchLabels}
      ariaLabel="商品信息筛选"
      itemLabel="商品"
      placeholder="全部商品"
    />
  );
}
