import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 可搜索的 TAG 下拉多选框。
 */
export default function TagMultiSelect({
  options = [],
  value = [],
  onChange,
  ariaLabel = 'TAG 筛选',
  placeholder = '全部 TAG',
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const containerRef = useRef(null);

  const closeDropdown = () => {
    setOpen(false);
    setKeyword('');
  };

  useEffect(() => {
    const closeOnOutsideClick = event => {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false);
        setKeyword('');
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  const normalizedOptions = useMemo(
    () =>
      [...new Set([...options, ...value].filter(Boolean))].sort((left, right) =>
        left.localeCompare(right, 'zh-CN')
      ),
    [options, value]
  );
  const visibleOptions = useMemo(() => {
    const search = keyword.trim().toLocaleLowerCase('zh-CN');
    if (!search) return normalizedOptions;
    return normalizedOptions.filter(option => option.toLocaleLowerCase('zh-CN').includes(search));
  }, [keyword, normalizedOptions]);

  const toggleOption = option => {
    onChange(
      value.includes(option) ? value.filter(selected => selected !== option) : [...value, option]
    );
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="input flex w-full items-center justify-between gap-2 text-left"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) closeDropdown();
          else setOpen(true);
        }}
      >
        <span className={value.length > 0 ? 'truncate text-gray-900' : 'text-gray-400'}>
          {value.length === 0
            ? placeholder
            : value.length === 1
              ? value[0]
              : `已选择 ${value.length} 个 TAG`}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                className="input w-full py-2 pl-9 pr-3"
                autoFocus
                placeholder="搜索 TAG"
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    closeDropdown();
                  }
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-multiselectable="true">
            {visibleOptions.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-gray-400">暂无匹配 TAG</p>
            ) : (
              visibleOptions.map(option => {
                const selected = value.includes(option);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={option}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      selected ? 'bg-primary-light text-primary' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                    onClick={() => toggleOption(option)}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        selected
                          ? 'border-primary bg-primary text-white'
                          : 'border-gray-300 bg-white'
                      }`}
                    >
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate" title={option}>
                      {option}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {value.length > 0 && (
            <div className="flex justify-end border-t border-gray-100 p-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                onClick={() => onChange([])}
              >
                <X className="h-4 w-4" />
                清空选择
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
