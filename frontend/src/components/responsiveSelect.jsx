import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import MobilePickerDialog from './mobilePickerDialog';

/** 从原控件读取标签与选项，保留 optgroup、禁用项、表单验证和原有 change 事件。 */
function selectSnapshot(select, props = {}) {
  const label =
    props['aria-label'] ||
    select.getAttribute('aria-label') ||
    [
      ...new Set(
        [
          ...(select.labels || []),
          select.closest('label'),
          ...[...document.querySelectorAll('label')].filter(
            item => props.id && item.htmlFor === props.id
          ),
        ].filter(Boolean)
      ),
    ]
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
    selectedLabel: select.selectedOptions[0]?.text || '请选择',
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
  const ariaLabel = props['aria-label'];
  const nativeRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const triggerRef = useRef(null);
  const [field, setField] = useState(null);
  const [invalid, setInvalid] = useState(false);
  useImperativeHandle(forwardedRef, () => nativeRef.current);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [snapshot, setSnapshot] = useState(null);
  const [keyword, setKeyword] = useState('');
  const id = useId();
  const enhanced = mobile && !props.multiple && !(props.size > 1);
  const open = () => {
    if (!enhanced || nativeRef.current.matches(':disabled')) return;
    setKeyword('');
    setSnapshot(selectSnapshot(nativeRef.current, props));
  };
  const close = () => setSnapshot(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => {
      setMobile(query.matches);
      setSnapshot(null);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    if (!enhanced) return;
    const next = selectSnapshot(nativeRef.current, propsRef.current);
    setField(next);
    if (nativeRef.current.validity.valid) setInvalid(false);
    setSnapshot(current => (props.disabled ? null : current ? next : null));
  }, [enhanced, children, props.value, props.disabled, props.id, ariaLabel]);
  useEffect(() => {
    const select = nativeRef.current;
    let frame;
    const reset = () => {
      frame = requestAnimationFrame(() => {
        setField(selectSnapshot(select, propsRef.current));
        setInvalid(false);
        setSnapshot(null);
      });
    };
    select.form?.addEventListener('reset', reset);
    return () => {
      select.form?.removeEventListener('reset', reset);
      cancelAnimationFrame(frame);
    };
  }, [props.id, ariaLabel]);
  const choose = value => {
    const select = nativeRef.current;
    if (!select || select.matches(':disabled')) return;
    const option = [...select.options].find(item => item.value === value);
    if (!option || option.disabled || option.parentElement.disabled) return;
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setField(selectSnapshot(select, props));
    setInvalid(!select.validity.valid);
    close();
  };
  const search = keyword.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const options =
    snapshot?.options
      .filter(option => !(props.required && option.value === ''))
      .filter(option =>
        `${option.group} ${option.label}`
          .normalize('NFKC')
          .toLocaleLowerCase('zh-CN')
          .includes(search)
      ) || [];
  return (
    <>
      {enhanced && (
        <button
          ref={triggerRef}
          id={props.id}
          type="button"
          style={props.style}
          hidden={props.hidden}
          tabIndex={props.tabIndex}
          title={field?.selectedLabel}
          className={`${className} responsive-select-trigger`}
          disabled={props.disabled}
          aria-label={field?.label || props['aria-label'] || '选择选项'}
          aria-describedby={props['aria-describedby']}
          aria-haspopup="dialog"
          aria-expanded={Boolean(snapshot)}
          aria-controls={snapshot ? id : undefined}
          aria-required={props.required || undefined}
          aria-invalid={invalid || undefined}
          onClick={open}
          onKeyDown={event => {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault();
              open();
            }
          }}
        >
          <span className={`min-w-0 flex-1 ${field?.value === '' ? 'text-gray-400' : ''}`}>
            {field?.selectedLabel || '请选择'}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
        </button>
      )}
      <select
        {...props}
        ref={nativeRef}
        id={enhanced && props.id ? `${props.id}-native` : props.id}
        hidden={enhanced || props.hidden}
        className={className}
        tabIndex={enhanced ? -1 : props.tabIndex}
        aria-hidden={enhanced ? true : props['aria-hidden']}
        aria-label={enhanced ? undefined : props['aria-label']}
        data-responsive-select={enhanced ? field?.label || '' : undefined}
        onInvalid={event => {
          props.onInvalid?.(event);
          if (enhanced) {
            event.preventDefault();
            setInvalid(true);
            const select = nativeRef.current;
            const firstInvalid = select.form?.querySelector(
              'input:invalid, select:invalid, textarea:invalid'
            );
            if (!firstInvalid || firstInvalid === select) {
              triggerRef.current?.focus({ preventScroll: true });
              open();
            }
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
          returnFocusRef={triggerRef}
        >
          <div>
            {invalid && (
              <p role="alert" className="px-4 pt-3 text-sm text-red-600">
                请选择{snapshot.label}
              </p>
            )}
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
