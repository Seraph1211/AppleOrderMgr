import MobilePickerDialog from './mobilePickerDialog';
import { Check, ChevronDown, Minus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const EMPTY_LABELS = Object.freeze({});

function getOptionLabel(option, labels) {
  return Object.prototype.hasOwnProperty.call(labels, option) ? labels[option] : option;
}

/**
 * 可搜索下拉多选框，默认用于 TAG，可提供代码到中文标签的映射。
 */
export default function TagMultiSelect({
  options = [],
  value = [],
  onChange,
  ariaLabel = 'TAG 筛选',
  placeholder = '全部 TAG',
  itemLabel = 'TAG',
  optionLabels = EMPTY_LABELS,
  searchLabels = EMPTY_LABELS,
  compareOptions,
  enableSelectAll = false,
  triggerLabel = '',
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const containerRef = useRef(null);
  const triggerRef = useRef(null);

  const closeDropdown = () => {
    setOpen(false);
    setKeyword('');
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => {
      setMobile(query.matches);
      setOpen(false);
      setKeyword('');
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (mobile) return undefined;
    const closeOnOutsideClick = event => {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false);
        setKeyword('');
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [mobile]);

  const normalizedOptions = useMemo(
    () =>
      [...new Set([...options, ...value].filter(Boolean))].sort(
        compareOptions ||
          ((left, right) =>
            getOptionLabel(left, optionLabels).localeCompare(
              getOptionLabel(right, optionLabels),
              'zh-CN'
            ))
      ),
    [options, value, optionLabels, compareOptions]
  );
  const visibleOptions = useMemo(() => {
    const normalizeSearch = text =>
      text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
    const search = normalizeSearch(keyword);
    if (!search) return normalizedOptions;
    return normalizedOptions.filter(option =>
      normalizeSearch(searchLabels[option] || getOptionLabel(option, optionLabels)).includes(search)
    );
  }, [keyword, normalizedOptions, optionLabels, searchLabels]);

  const allVisibleSelected =
    visibleOptions.length > 0 && visibleOptions.every(option => value.includes(option));
  const someVisibleSelected = visibleOptions.some(option => value.includes(option));
  const toggleAllVisible = () => {
    onChange(
      allVisibleSelected
        ? value.filter(option => !visibleOptions.includes(option))
        : [...new Set([...value, ...visibleOptions])]
    );
  };

  const toggleOption = option => {
    onChange(
      value.includes(option) ? value.filter(selected => selected !== option) : [...value, option]
    );
  };

  const panel = (
    <div
      className={
        mobile
          ? 'mobile-picker-multi-panel'
          : 'tag-select-panel absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg'
      }
    >
      <div className="tag-select-search border-b border-gray-100 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            className="input w-full py-2 pl-9 pr-3"
            autoFocus={!mobile}
            placeholder={`搜索 ${itemLabel}`}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeDropdown();
                containerRef.current?.querySelector('button')?.focus();
              }
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </div>
      </div>
      {enableSelectAll && (
        <div className="border-b border-gray-100 p-1">
          <button
            type="button"
            className="btn tag-select-all"
            disabled={!visibleOptions.length}
            onClick={toggleAllVisible}
            aria-pressed={allVisibleSelected ? true : someVisibleSelected ? 'mixed' : false}
            aria-label={`${ariaLabel}${allVisibleSelected ? '取消全选' : '全选'}${keyword.trim() ? '搜索结果' : ''}`}
          >
            <span
              aria-hidden="true"
              className={`tag-select-checkbox flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                someVisibleSelected
                  ? 'border-primary bg-primary text-white'
                  : 'border-gray-300 bg-white'
              }`}
            >
              {allVisibleSelected ? (
                <Check className="h-3 w-3" />
              ) : someVisibleSelected ? (
                <Minus className="h-3 w-3" />
              ) : null}
            </span>
            <span className="flex-1">
              {allVisibleSelected ? '取消全选' : '全选'}
              {keyword.trim() ? '搜索结果' : ''}
            </span>
            <span className="text-xs font-normal text-gray-500">{visibleOptions.length} 项</span>
          </button>
        </div>
      )}
      <div
        className={mobile ? 'mobile-picker-options p-1' : 'max-h-64 overflow-y-auto p-1'}
        role="listbox"
        aria-multiselectable="true"
      >
        {visibleOptions.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-gray-400">
            暂无匹配{itemLabel === 'TAG' ? ' TAG' : itemLabel}
          </p>
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
                  enableSelectAll
                    ? `tag-select-option bg-white text-gray-700 hover:bg-gray-50`
                    : selected
                      ? 'bg-primary-light text-primary'
                      : 'text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => toggleOption(option)}
              >
                <span
                  className={`tag-select-checkbox flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    selected ? 'border-primary bg-primary text-white' : 'border-gray-300 bg-white'
                  }`}
                >
                  {selected && <Check className="h-3 w-3" />}
                </span>
                <span
                  className={mobile ? 'min-w-0 flex-1 whitespace-normal break-words' : 'truncate'}
                  title={getOptionLabel(option, optionLabels)}
                >
                  {getOptionLabel(option, optionLabels)}
                </span>
              </button>
            );
          })
        )}
      </div>
      {(value.length > 0 || (triggerLabel && !mobile)) && (
        <div
          className={`tag-select-footer flex items-center border-t border-gray-100 p-2 ${triggerLabel ? 'justify-between' : 'justify-end'}`}
        >
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            onClick={() => onChange([])}
            disabled={!value.length}
          >
            <X className="h-4 w-4" />
            清空选择
          </button>
          {triggerLabel && !mobile && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                closeDropdown();
                triggerRef.current?.focus();
              }}
            >
              完成
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="relative"
      ref={containerRef}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          closeDropdown();
          containerRef.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`input flex w-full items-center justify-between gap-2 text-left ${triggerLabel ? 'order-filter-trigger' : ''} ${triggerLabel && value.length ? 'is-selected' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup={mobile ? 'dialog' : 'listbox'}
        aria-expanded={open}
        title={
          triggerLabel && value.length
            ? value.map(option => getOptionLabel(option, optionLabels)).join('、')
            : undefined
        }
        onClick={() => {
          if (open) closeDropdown();
          else setOpen(true);
        }}
      >
        {triggerLabel && <span className="order-filter-trigger-label">{triggerLabel}</span>}
        <span
          className={
            triggerLabel
              ? 'order-filter-trigger-value'
              : value.length > 0
                ? 'truncate text-gray-900'
                : 'text-gray-400'
          }
        >
          {value.length === 0
            ? triggerLabel
              ? '不限'
              : placeholder
            : value.length === 1
              ? getOptionLabel(value[0], optionLabels)
              : enableSelectAll
                ? triggerLabel
                  ? `${value.length} 项`
                  : `已选 ${value.length} 项`
                : `已选择 ${value.length} 个${itemLabel === 'TAG' ? ' TAG' : itemLabel}`}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        (mobile ? (
          <MobilePickerDialog
            title={ariaLabel}
            onClose={closeDropdown}
            returnFocusRef={triggerRef}
            footer={
              <button type="button" className="btn btn-primary w-full" onClick={closeDropdown}>
                完成{value.length ? `（已选 ${value.length} 项）` : ''}
              </button>
            }
          >
            {panel}
          </MobilePickerDialog>
        ) : (
          panel
        ))}
    </div>
  );
}
