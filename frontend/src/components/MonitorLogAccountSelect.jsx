import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';

/** 日志账号单选：保留自由输入，统一候选外观、键盘操作及视口内定位。 */
export default function MonitorLogAccountSelect({
  value,
  onChange,
  options,
  loading,
  error,
  disabled,
  nextCursor,
  hasPrevious,
  onNext,
  onFirst,
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState(null);
  const anchorRef = useRef(null);
  const popupRef = useRef(null);
  const inputRef = useRef(null);
  const id = useId();
  const choices = ['', ...options];

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => setActive(-1), [value, options]);
  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (!anchorRef.current?.contains(event.target) && !popupRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    function measure() {
      const rect = anchorRef.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const start = (viewport?.offsetTop ?? 0) + 8;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
      const above = rect.top - start - 4;
      const below = bottom - rect.bottom - 4;
      const upwards = below < 220 && above > below;
      const width = Math.min(rect.width, (viewport?.width ?? window.innerWidth) - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, (viewport?.width ?? window.innerWidth) - width - 8)),
        width,
        maxHeight: Math.max(80, Math.min(320, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open]);
  useEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open, id]);

  function choose(account) {
    onChange(account);
    setOpen(false);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div ref={anchorRef} className="relative mt-1">
      <input
        ref={inputRef}
        className="input min-h-11 w-full pr-16 text-base sm:min-h-0 sm:text-sm"
        role="combobox"
        aria-label="账号编号"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        autoComplete="off"
        placeholder="全部账号，或搜索编号"
        disabled={disabled}
        value={value}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={event => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onBlur={event => {
          if (
            !popupRef.current?.contains(event.relatedTarget) &&
            !anchorRef.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive(current =>
              event.key === 'ArrowDown'
                ? Math.min(current + 1, choices.length - 1)
                : Math.max(current - 1, 0)
            );
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (active >= 0) choose(choices[active]);
            else setOpen(false);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        {value && (
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            disabled={disabled}
            aria-label="清空账号编号"
            onClick={() => choose('')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          disabled={disabled}
          aria-label={open ? '收起账号候选' : '展开账号候选'}
          onClick={() => {
            inputRef.current?.focus({ preventScroll: true });
            setOpen(!open);
          }}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open &&
        position &&
        createPortal(
          <div
            ref={popupRef}
            style={position}
            className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white text-sm shadow-lg"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
                inputRef.current?.focus({ preventScroll: true });
              }
            }}
            onBlur={event => {
              if (
                !popupRef.current?.contains(event.relatedTarget) &&
                !anchorRef.current?.contains(event.relatedTarget)
              )
                setOpen(false);
            }}
          >
            <div className="shrink-0 border-b border-gray-100 px-3 py-2 text-xs text-gray-500">
              选择账号，或直接输入编号
            </div>
            <div
              id={id}
              role="listbox"
              aria-label="账号候选"
              aria-busy={loading}
              className="min-h-0 overflow-y-auto overscroll-contain p-1"
            >
              {choices.map((account, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${id}-${index}`}
                  key={account || '__all__'}
                  aria-selected={value === account}
                  className={`flex min-h-11 w-full sm:min-h-9 items-center justify-between rounded-md px-3 py-2 text-left ${value === account || active === index ? 'bg-primary-50 text-primary' : 'text-gray-700 hover:bg-gray-50'}`}
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => choose(account)}
                >
                  <span className={account ? 'font-mono' : ''}>{account || '全部账号'}</span>
                  {value === account && <Check className="h-4 w-4" />}
                </button>
              ))}
              {loading ? (
                <p role="status" className="px-3 py-3 text-xs text-gray-500">
                  正在读取账号…
                </p>
              ) : error ? (
                <p role="alert" className="px-3 py-3 text-xs text-amber-700">
                  {error}，可直接输入编号查询
                </p>
              ) : (
                !options.length && (
                  <p className="px-3 py-3 text-xs text-gray-500">
                    暂无匹配候选，可直接输入编号查询
                  </p>
                )
              )}
            </div>
            {(hasPrevious || nextCursor) && (
              <div className="flex shrink-0 justify-between gap-2 border-t border-gray-100 px-2 py-1">
                {hasPrevious && (
                  <button
                    type="button"
                    className="btn btn-secondary text-xs"
                    disabled={loading}
                    onPointerDown={event => event.preventDefault()}
                    onClick={onFirst}
                  >
                    账号候选首页
                  </button>
                )}
                {nextCursor && (
                  <button
                    type="button"
                    className="btn btn-secondary ml-auto text-xs"
                    disabled={loading}
                    onPointerDown={event => event.preventDefault()}
                    onClick={onNext}
                  >
                    下一组账号候选
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
