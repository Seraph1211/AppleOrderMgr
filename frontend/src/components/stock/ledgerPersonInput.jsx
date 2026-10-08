import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/** 库存姓名组合框：统一候选样式，允许自由输入并支持键盘和触屏选择。 */
export default function LedgerPersonInput({
  id,
  label,
  value,
  onChange,
  people,
  required,
  disabled,
  hintId,
}) {
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState(null);
  const anchor = useRef(null);
  const input = useRef(null);
  const popup = useRef(null);
  const composing = useRef(false);
  const names = useMemo(
    () => [...new Set(people.map(person => person.name).filter(Boolean))],
    [people]
  );
  const choices = useMemo(
    () =>
      names.filter(
        name => !filtering || name.toLowerCase().includes((value || '').trim().toLowerCase())
      ),
    [names, filtering, value]
  );
  const listId = `${id}-options`;

  useEffect(() => {
    setActive(-1);
  }, [choices]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (!anchor.current?.contains(event.target) && !popup.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const rect = anchor.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = (viewport?.offsetTop || 0) + 8;
      const bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) - 8;
      const left = (viewport?.offsetLeft || 0) + 8;
      const width = Math.min(rect.width, (viewport?.width || window.innerWidth) - 16);
      const above = rect.top - top - 6;
      const below = bottom - rect.bottom - 6;
      const upwards = below < 240 && above > below;
      const scrollArea = anchor.current.closest('.stock-dialog-scroll')?.getBoundingClientRect();
      if (
        scrollArea &&
        (rect.bottom < Math.max(top, scrollArea.top) ||
          rect.top > Math.min(bottom, scrollArea.bottom))
      ) {
        setOpen(false);
        return;
      }
      setPosition({
        left: Math.max(
          left,
          Math.min(rect.left, left + (viewport?.width || window.innerWidth) - width - 16)
        ),
        width,
        maxHeight: Math.max(0, Math.min(256, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
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
    const option = document.getElementById(`${listId}-${active}`);
    if (open && option && popup.current) {
      const offset = option.offsetTop;
      if (offset < popup.current.scrollTop) popup.current.scrollTop = offset;
      else if (
        offset + option.offsetHeight >
        popup.current.scrollTop + popup.current.clientHeight
      ) {
        popup.current.scrollTop = offset + option.offsetHeight - popup.current.clientHeight;
      }
    }
  }, [active, open, listId]);

  const show = () => {
    setFiltering(false);
    setActive(-1);
    setOpen(true);
  };
  const choose = name => {
    onChange(name);
    input.current?.focus({ preventScroll: true });
    setOpen(false);
  };

  return (
    <div ref={anchor} className="relative">
      <input
        ref={input}
        id={id}
        className="input pr-11"
        role="combobox"
        aria-label={label}
        aria-describedby={hintId}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && choices[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value || ''}
        required={required}
        disabled={disabled}
        maxLength={100}
        placeholder={required ? '选择或输入姓名' : '选择或输入姓名，不清楚可留空'}
        onFocus={show}
        onClick={() => {
          if (!open) show();
        }}
        onChange={event => {
          onChange(event.target.value);
          setFiltering(true);
          setActive(-1);
          setOpen(true);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={event => {
          if (
            !anchor.current?.contains(event.relatedTarget) &&
            !popup.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
            if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive(current =>
              choices.length
                ? event.key === 'ArrowDown'
                  ? Math.min(current + 1, choices.length - 1)
                  : Math.max(current - 1, 0)
                : -1
            );
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (choices[active]) choose(choices[active]);
            else setOpen(false);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={`${open ? '收起' : '展开'}${label}候选`}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-gray-400 hover:text-primary disabled:cursor-not-allowed"
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          const next = !open;
          input.current?.focus({ preventScroll: true });
          setFiltering(false);
          setActive(-1);
          setOpen(next);
        }}
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={popup}
            id={listId}
            role="listbox"
            aria-label={`${label}候选`}
            style={position}
            className="fixed z-[70] overflow-y-auto overscroll-contain rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg"
          >
            {choices.map((name, index) => (
              <div
                id={`${listId}-${index}`}
                key={name}
                role="option"
                aria-selected={name === value}
                className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 sm:min-h-9 ${name === value || active === index ? 'bg-primary-50 text-primary' : 'text-gray-700 hover:bg-gray-50'}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(name)}
              >
                <span className="min-w-0 break-words">{name}</span>
                {name === value && <Check aria-hidden="true" className="h-4 w-4 shrink-0" />}
              </div>
            ))}
            {!choices.length && (
              <p className="px-3 py-3 text-sm text-gray-500">
                {value ? '无匹配姓名，可直接使用输入的姓名' : '暂无预置姓名，可直接输入'}
              </p>
            )}
          </div>,
          anchor.current?.closest('[role="dialog"]') || document.body
        )}
    </div>
  );
}
