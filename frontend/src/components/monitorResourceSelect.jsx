import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import './monitorResourceSelect.css';

/** 服务器／实例单选；展开列表直接占据文档流，桌面与手机使用同一交互。 */
export default function MonitorResourceSelect({
  label,
  placeholder,
  value,
  options,
  disabled,
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const id = useId();
  const keyword = search.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const choices = options.filter(option =>
    option.label.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(keyword)
  );
  const selected = options.find(option => option.value === value);
  useEffect(() => {
    setOpen(false);
    setSearch('');
  }, [disabled, value]);
  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active, id]);
  function close() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }
  function choose(option) {
    onChange(option.value);
    close();
  }
  function handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (['Home', 'End'].includes(event.key) && event.target === searchRef.current) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? choices.length - 1
            : event.key === 'ArrowDown'
              ? Math.min(active + 1, choices.length - 1)
              : Math.max(active - 1, 0);
      setActive(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0 && choices[active]) choose(choices[active]);
    }
  }
  return (
    <div
      ref={rootRef}
      className="monitor-resource-select"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span id={`${id}-label`} className="monitor-resource-label">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        className="input monitor-resource-trigger"
        aria-label={label}
        title={selected?.label || placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => {
          setSearch('');
          setActive(-1);
          setOpen(current => !current);
        }}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setSearch('');
            setActive(-1);
            setOpen(true);
            requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
          } else if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span className="monitor-resource-trigger-content">
          <span
            className={`monitor-resource-trigger-name ${value ? '' : 'monitor-resource-placeholder'}`}
          >
            {selected?.name || selected?.label || placeholder}
          </span>
          {selected?.tag && (
            <span className="monitor-resource-trigger-tag" title={selected.tag}>
              {selected.tag}
            </span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-500 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="monitor-resource-menu" onKeyDown={handleKey}>
          <div className="monitor-resource-search">
            <Search className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
            <input
              ref={searchRef}
              className="input monitor-resource-search-input"
              role="combobox"
              aria-label={`搜索${label}`}
              aria-autocomplete="list"
              aria-controls={`${id}-list`}
              aria-expanded="true"
              aria-activedescendant={active >= 0 && choices[active] ? `${id}-${active}` : undefined}
              placeholder="搜索名称、编号或标签"
              value={search}
              onChange={event => {
                setSearch(event.target.value);
                setActive(-1);
              }}
            />
          </div>
          <div
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="monitor-resource-options"
          >
            {choices.map((option, index) => (
              <button
                key={option.value}
                id={`${id}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                aria-label={option.label}
                data-active={active === index}
                className="monitor-resource-option"
                onClick={() => choose(option)}
              >
                <span className="monitor-resource-option-content">
                  <span className="monitor-resource-option-name">
                    {option.name || option.label}
                  </span>
                  {(option.tag || option.status) && (
                    <span className="monitor-resource-option-details">
                      {option.tag && (
                        <span className="monitor-resource-option-tag">{option.tag}</span>
                      )}
                      {option.status && <span>{option.status}</span>}
                    </span>
                  )}
                </span>
                {option.value === value && (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
              </button>
            ))}
            {!choices.length && (
              <p className="px-3 py-4 text-sm text-gray-500" role="status">
                无匹配选项
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
