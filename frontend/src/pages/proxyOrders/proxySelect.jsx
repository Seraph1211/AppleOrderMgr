import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import MobilePickerDialog from '../../components/mobilePickerDialog';

const PROXY_STATES = ['pending', 'rushing', 'succeeded', 'cancelled'];

function stateName(value) {
  return PROXY_STATES.includes(value) ? value : undefined;
}

/** 代抢状态标记，与状态选择器共用圆点和颜色语义。 */
export function ProxyStatusBadge({ status, children }) {
  return (
    <span className="proxy-status-chip" data-proxy-status={stateName(status)}>
      <span className="proxy-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function readField(select, label, id) {
  const parentLabel = select.closest('label');
  const linkedLabel = id
    ? [...document.querySelectorAll('label')].find(item => item.htmlFor === id)
    : null;
  const labelNode = parentLabel || linkedLabel;
  const clone = labelNode?.cloneNode(true);
  clone?.querySelectorAll('select, button, input, .text-xs').forEach(node => node.remove());
  return {
    label: label || clone?.textContent.trim() || '选择选项',
    selected: select.selectedOptions[0]?.text || '请选择',
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

/** 本页专属单选：桌面浮层、手机选项面板；保留原生字段与 change/required 语义。 */
const ProxySelect = forwardRef(function ProxySelect(
  { children, className = '', statusOptions = false, statusChip = false, ...props },
  forwardedRef
) {
  const generatedId = useId();
  const fieldId = props.id || generatedId;
  const panelId = `${generatedId}-options`;
  const nativeRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [field, setField] = useState({
    label: props['aria-label'] || '选择选项',
    selected: '',
    options: [],
  });
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({});
  const [invalid, setInvalid] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useImperativeHandle(forwardedRef, () => nativeRef.current);

  useLayoutEffect(() => {
    setField(readField(nativeRef.current, propsRef.current['aria-label'], propsRef.current.id));
    if (nativeRef.current.validity.valid) setInvalid(false);
    if (props.disabled || props.hidden) setOpen(false);
  }, [children, props.value, props.disabled, props.hidden, props.id]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => {
      setMobile(query.matches);
      setOpen(false);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    const select = nativeRef.current;
    let frame;
    const reset = () => {
      frame = requestAnimationFrame(() => {
        setField(readField(select, propsRef.current['aria-label'], propsRef.current.id));
        setOpen(false);
        setInvalid(false);
      });
    };
    select.form?.addEventListener('reset', reset);
    return () => {
      select.form?.removeEventListener('reset', reset);
      cancelAnimationFrame(frame);
    };
  }, []);

  const searchable = field.options.length > 6;
  const query = keyword.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const options = field.options
    .filter(option => !(props.required && option.value === ''))
    .filter(option =>
      `${option.group} ${option.label}`.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query)
    );
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const show = () => {
    if (props.disabled) return;
    const snapshot = readField(nativeRef.current, props['aria-label'], props.id);
    setField(snapshot);
    setKeyword('');
    setActive(
      Math.max(
        0,
        snapshot.options
          .filter(option => !(props.required && option.value === ''))
          .findIndex(option => option.value === nativeRef.current.value)
      )
    );
    setOpen(true);
  };
  const choose = option => {
    if (!option || option.disabled || nativeRef.current.matches(':disabled')) return;
    const native = nativeRef.current;
    if (native.value !== option.value) {
      native.value = option.value;
      native.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setField(readField(native, props['aria-label'], props.id));
    setInvalid(!native.validity.valid);
    close(!mobile);
  };

  useLayoutEffect(() => {
    if (!open || mobile) return undefined;
    const place = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      const panel = panelRef.current;
      const borderHeight = panel.offsetHeight - panel.clientHeight;
      const height = Math.min(panel.scrollHeight + borderHeight, 344, window.innerHeight - 24);
      const width = Math.min(Math.max(rect.width, 208), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const top =
        below >= height || below >= rect.top - 12
          ? rect.bottom + 6
          : Math.max(12, rect.top - height - 6);
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(80, Math.min(height, window.innerHeight - top - 12)),
      });
    };
    const scroll = event => {
      if (!panelRef.current?.contains(event.target)) place();
    };
    const outside = event => {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current.contains(event.target))
        setOpen(false);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside, true);
    (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, mobile, searchable]);

  useEffect(() => {
    if (open) document.getElementById(`${panelId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, panelId]);

  const keyboard = event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active]);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === searchRef.current && ['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!options.some(option => !option.disabled)) return;
    const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
    let next = event.key === 'Home' ? -1 : event.key === 'End' ? options.length : active;
    do {
      next = (next + direction + options.length) % options.length;
    } while (options[next].disabled);
    setActive(next);
  };

  const content = (
    <div className="proxy-select-content" onKeyDown={keyboard}>
      {searchable && (
        <label className="proxy-select-search">
          <Search className="w-4 h-4" aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={`搜索${field.label}`}
            placeholder="搜索选项…"
            value={keyword}
            onChange={event => {
              setKeyword(event.target.value);
              setActive(0);
            }}
            aria-controls={panelId}
            aria-activedescendant={options[active] ? `${panelId}-${active}` : undefined}
          />
        </label>
      )}
      {invalid && (
        <p className="proxy-select-invalid" role="alert">
          请选择{field.label}
        </p>
      )}
      <div
        ref={listRef}
        id={panelId}
        role="listbox"
        aria-label={field.label}
        tabIndex={-1}
        aria-activedescendant={options[active] ? `${panelId}-${active}` : undefined}
        className="proxy-select-options"
      >
        {options.map((option, index) => (
          <button
            type="button"
            role="option"
            id={`${panelId}-${index}`}
            key={option.value}
            tabIndex={-1}
            aria-selected={String(props.value ?? '') === option.value}
            disabled={option.disabled}
            data-active={index === active}
            data-proxy-status={statusOptions ? stateName(option.value) : undefined}
            className="proxy-select-option"
            onMouseMove={() => setActive(index)}
            onClick={() => choose(option)}
          >
            {statusOptions && stateName(option.value) && (
              <span className="proxy-status-dot" aria-hidden="true" />
            )}
            <span className="proxy-select-option-label">
              {option.group && <span className="proxy-select-group">{option.group}</span>}
              {option.label}
            </span>
            {String(props.value ?? '') === option.value && (
              <Check className="w-4 h-4 proxy-select-check" aria-hidden="true" />
            )}
          </button>
        ))}
        {!options.length && <p className="proxy-select-empty">没有匹配的选项</p>}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={fieldId}
        title={field.selected}
        disabled={props.disabled}
        hidden={props.hidden}
        style={props.style}
        tabIndex={props.tabIndex}
        className={`${className} proxy-select-trigger ${statusChip ? 'proxy-status-chip' : ''}`}
        data-proxy-status={statusChip ? stateName(String(props.value)) : undefined}
        aria-label={field.label}
        aria-describedby={props['aria-describedby']}
        aria-haspopup={mobile ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-invalid={invalid || undefined}
        aria-required={props.required || undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            show();
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {statusChip && <span className="proxy-status-dot" aria-hidden="true" />}
        <span className="proxy-select-value">{field.selected || '请选择'}</span>
        <ChevronDown className="w-4 h-4 proxy-select-chevron" aria-hidden="true" />
      </button>
      <select
        {...props}
        ref={nativeRef}
        id={`${fieldId}-native`}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        aria-label={undefined}
        data-responsive-select={field.label}
        className={className}
        onInvalid={event => {
          props.onInvalid?.(event);
          event.preventDefault();
          setInvalid(true);
          show();
        }}
      >
        {children}
      </select>
      {open &&
        (mobile ? (
          <MobilePickerDialog
            title={field.label}
            onClose={() => close()}
            returnFocusRef={triggerRef}
          >
            {content}
          </MobilePickerDialog>
        ) : (
          createPortal(
            <div ref={panelRef} className="proxy-select-menu" style={position}>
              {content}
            </div>,
            triggerRef.current?.closest('[role="dialog"]') || document.body
          )
        ))}
    </>
  );
});

export default ProxySelect;
