import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import MobilePickerDialog from './mobilePickerDialog';

/** 从原控件读取标签与选项，保留 optgroup、禁用项、表单验证和原有 change 事件。 */
function selectSnapshot(select) {
  const label =
    select.getAttribute('aria-label') ||
    [...(select.labels || [])]
      .map(item => {
        const clone = item.cloneNode(true);
        clone.querySelectorAll('select, input, button, .text-xs').forEach(node => node.remove());
        return clone.textContent.trim();
      })
      .filter(Boolean)
      .join(' / ') ||
    select.options[0]?.text ||
    '选择选项';
  return {
    label,
    value: select.value,
    options: [...select.options].map(option => ({
      value: option.value,
      label: option.text,
      group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : '',
      disabled:
        option.disabled ||
        (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled),
    })),
  };
}

/** 桌面保留原生单选；手机使用可搜索选项面板，原 select 仍负责表单语义。 */
const ResponsiveSelect = forwardRef(function ResponsiveSelect(
  { children, className = '', ...props },
  forwardedRef
) {
  const nativeRef = useRef(null);
  useImperativeHandle(forwardedRef, () => nativeRef.current);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [snapshot, setSnapshot] = useState(null);
  const [keyword, setKeyword] = useState('');
  const id = useId();
  const enhanced = mobile && !props.multiple && !(props.size > 1);
  const open = () => {
    if (!enhanced || nativeRef.current.matches(':disabled')) return;
    setKeyword('');
    setSnapshot(selectSnapshot(nativeRef.current));
  };
  const close = () => setSnapshot(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => {
      setMobile(query.matches);
      setSnapshot(null);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!enhanced) return undefined;
    const select = nativeRef.current;
    // React 的 touch listener 默认 passive；直接绑定以阻止 iOS 原生菜单。
    const start = event => {
      if (!select.matches(':disabled')) event.preventDefault();
    };
    const end = event => {
      if (!select.matches(':disabled')) {
        event.preventDefault();
        openRef.current();
      }
    };
    select.addEventListener('touchstart', start, { passive: false });
    select.addEventListener('touchend', end, { passive: false });
    return () => {
      select.removeEventListener('touchstart', start);
      select.removeEventListener('touchend', end);
    };
  }, [enhanced]);
  useEffect(() => {
    if (props.disabled) setSnapshot(null);
    else setSnapshot(current => (current ? selectSnapshot(nativeRef.current) : current));
  }, [children, props.value, props.disabled]);
  const intercept = (event, handler) => {
    handler?.(event);
    if (enhanced && !event.defaultPrevented) event.preventDefault();
  };
  const choose = value => {
    const select = nativeRef.current;
    if (!select || select.matches(':disabled')) return;
    const option = [...select.options].find(item => item.value === value);
    if (!option || option.disabled || option.parentElement.disabled) return;
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  };
  const search = keyword.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const options =
    snapshot?.options.filter(option =>
      `${option.group} ${option.label}`
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .includes(search)
    ) || [];
  return (
    <>
      <select
        {...props}
        ref={nativeRef}
        className={`${className}${enhanced ? ' responsive-select-mobile' : ''}`}
        aria-haspopup={enhanced ? 'dialog' : props['aria-haspopup']}
        aria-expanded={enhanced ? Boolean(snapshot) : props['aria-expanded']}
        aria-controls={snapshot ? id : undefined}
        onPointerDown={event => intercept(event, props.onPointerDown)}
        onMouseDown={event => intercept(event, props.onMouseDown)}
        onClick={event => {
          props.onClick?.(event);
          if (enhanced && !event.defaultPrevented) {
            event.preventDefault();
            open();
          }
        }}
        onKeyDown={event => {
          props.onKeyDown?.(event);
          if (
            enhanced &&
            !event.defaultPrevented &&
            ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        }}
      >
        {children}
      </select>
      {snapshot && (
        <MobilePickerDialog
          id={id}
          title={snapshot.label}
          onClose={close}
          returnFocusRef={nativeRef}
        >
          <div>
            {snapshot.options.length > 6 && (
              <label className="mobile-picker-search">
                <Search className="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  className="input min-w-0"
                  aria-label={`搜索${snapshot.label}`}
                  placeholder="输入关键词搜索"
                  value={keyword}
                  onChange={event => setKeyword(event.target.value)}
                />
              </label>
            )}
            <div className="mobile-picker-options" role="listbox" aria-label={snapshot.label}>
              {options.map((option, index) => (
                <button
                  type="button"
                  role="option"
                  key={`${option.value}-${index}`}
                  disabled={option.disabled}
                  aria-selected={option.value === snapshot.value}
                  className="mobile-picker-option"
                  onClick={() => choose(option.value)}
                >
                  <span className="min-w-0 flex-1">
                    {option.group && (
                      <span className="block text-xs text-gray-500">{option.group}</span>
                    )}
                    <span>{option.label}</span>
                  </span>
                  {option.value === snapshot.value && (
                    <Check className="h-5 w-5 shrink-0 text-primary" />
                  )}
                </button>
              ))}
              {!options.length && (
                <p className="p-6 text-center text-sm text-gray-500">没有匹配的选项</p>
              )}
            </div>
          </div>
        </MobilePickerDialog>
      )}
    </>
  );
});
export default ResponsiveSelect;
