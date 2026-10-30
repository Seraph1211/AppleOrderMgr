import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useModalScrollLock from '../components/useModalScrollLock';
import {
  ExternalLink,
  Eye,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { formatStorageCapacity } from '../utils/productStorage';
import {
  getDuoQuotePricing,
  getDuoQuoteVersions,
  previewDuoQuotePricing,
  resetDuoQuoteAdjustments,
  restoreDuoQuoteVersion,
  saveDuoQuoteAdjustments,
} from '../api/quotePricingApi';
import './duoQuotePricing.css';

const currency = value =>
  value === null || value === undefined
    ? '—'
    : `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}`;
const signed = value =>
  value === null || value === undefined
    ? '—'
    : `${value > 0 ? '+' : ''}${currency(value)}`;
const time = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';
const actionLabels = {
  adjust: '设置报价',
  reset: '恢复默认加价',
  restore: '恢复历史加价',
};

/** 报价弹窗：隔离背景、约束焦点，并适配手机可视区域与软键盘。 */
function PricingDialog({
  title,
  busy,
  onClose,
  children,
  footer,
  returnFocusRef,
}) {
  useModalScrollLock();
  const dialogRef = useRef(null);
  const overlayRef = useRef(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };

  useEffect(() => {
    const previousFocus = returnFocusRef.current || document.activeElement;
    const background = document.querySelector('.duo-pricing-page');
    const previousAriaHidden = background?.getAttribute('aria-hidden');
    const wasInert = background?.hasAttribute('inert');
    background?.setAttribute('inert', '');
    background?.setAttribute('aria-hidden', 'true');
    dialogRef.current?.focus({ preventScroll: true });
    const resize = () => {
      const viewport = window.visualViewport;
      if (overlayRef.current) {
        overlayRef.current.style.height = `${viewport?.height || window.innerHeight}px`;
        overlayRef.current.style.top = `${viewport?.offsetTop || 0}px`;
      }
    };
    resize();
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key === 'Tab') {
        const focusable = [
          ...dialogRef.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]'
          ),
        ].filter(node => node.getClientRects().length);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) {
          event.preventDefault();
          dialogRef.current.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !dialogRef.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = event => {
      if (dialogRef.current && !dialogRef.current.contains(event.target))
        dialogRef.current.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      if (!wasInert) background?.removeAttribute('inert');
      if (previousAriaHidden === null)
        background?.removeAttribute('aria-hidden');
      else if (previousAriaHidden !== undefined)
        background?.setAttribute('aria-hidden', previousAriaHidden);
      requestAnimationFrame(() => {
        if (
          previousFocus?.isConnected &&
          !document.querySelector('.duo-pricing-dialog')
        )
          previousFocus.focus({ preventScroll: true });
      });
    };
  }, [returnFocusRef]);

  return createPortal(
    <div
      ref={overlayRef}
      className="duo-pricing duo-pricing-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="duo-pricing-dialog-title"
        aria-describedby="duo-pricing-dialog-description"
        tabIndex={-1}
        className="duo-pricing-dialog"
        aria-busy={busy}
      >
        <header className="duo-pricing-dialog-header">
          <div>
            <h2
              id="duo-pricing-dialog-title"
              className="text-lg font-semibold text-gray-900"
            >
              {title}
            </h2>
            <p
              id="duo-pricing-dialog-description"
              className="mt-1 text-sm text-gray-500"
            >
              先预览并核对，确认后保存加价额。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary duo-pricing-close"
            aria-label="关闭报价设置弹窗"
            disabled={busy}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="duo-pricing-dialog-body">{children}</div>
        <footer className="duo-pricing-dialog-footer">{footer}</footer>
      </section>
    </div>,
    document.body
  );
}

/** 管理员 Duo 八款商品的随行加价和历史版本。 */
export default function Iphone18QuotePricing() {
  const [data, setData] = useState(null);
  const [versions, setVersions] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [mode, setMode] = useState('markup');
  const [amount, setAmount] = useState('50');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const [dialog, setDialog] = useState(null);
  const previewRef = useRef(null);
  const pending = useRef(false);
  const returnFocusRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pricing, history] = await Promise.all([
        getDuoQuotePricing(),
        getDuoQuoteVersions(),
      ]);
      setData(pricing.data);
      setVersions(history.data.items);
      setHistoryTotal(history.data.total ?? history.data.items.length);
      setSelected(
        previous =>
          new Set(
            [...previous].filter(key =>
              pricing.data.items.some(item => item.productKey === key)
            )
          )
      );
      setPreview(null);
      setNeedsReview(false);
      setError('');
      return true;
    } catch (failure) {
      setError(failure.message || '读取报价管理数据失败');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items || [];
  const disabled = loading || Boolean(busy);
  const allSelected =
    items.length > 0 && items.every(item => selected.has(item.productKey));
  const missingBase = items.some(
    item => selected.has(item.productKey) && item.wholesalePrice == null
  );

  function changeDraft(update) {
    setPreview(null);
    setNotice('');
    update();
  }

  function toggleOne(key) {
    changeDraft(() =>
      setSelected(previous => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      })
    );
  }

  function handleFailure(failure) {
    setPreview(null);
    if (failure.response?.status === 409) {
      setNeedsReview(true);
      setError(
        '报价来源或设置版本已变化。输入已保留，请点击“刷新并核对”，核对最新批发价后重新预览。'
      );
    } else {
      setError(failure.message || '操作失败，请稍后重试');
    }
  }

  async function createPreview(operation, versionId) {
    if (pending.current || disabled || needsReview || !data) return;
    if (operation !== 'restore' && !selected.size) {
      setError('请先选择需要设置的商品');
      return;
    }
    if (operation === 'adjust') {
      if (
        !/^-?\d+(\.\d{1,2})?$/.test(amount) ||
        !Number.isFinite(Number(amount))
      ) {
        setError('请输入金额，最多保留两位小数');
        return;
      }
      if (
        (mode === 'markup' && Math.abs(Number(amount)) > 100000) ||
        (mode === 'retail' &&
          (Number(amount) < 0 || Number(amount) > 99999999.99))
      ) {
        setError(
          mode === 'markup'
            ? '加价额应在 -100000 至 100000 元之间'
            : '零售价应在 0 至 99999999.99 元之间'
        );
        return;
      }
      if (mode === 'retail' && missingBase) {
        setError('所选商品缺少批发价，无法按零售价换算加价额');
        return;
      }
    }
    const body = {
      expectedVersion: data.version,
      expectedSourceVersion: data.sourceVersion,
      ...(operation === 'restore'
        ? { versionId }
        : { productKeys: [...selected] }),
      ...(operation === 'adjust' ? { mode, amount } : {}),
    };
    pending.current = true;
    setBusy('preview');
    setError('');
    setNotice('');
    setPreview(null);
    try {
      const result = await previewDuoQuotePricing({ operation, ...body });
      setPreview({ operation, body, data: result.data });
      requestAnimationFrame(() =>
        previewRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        })
      );
    } catch (failure) {
      handleFailure(failure);
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

  async function savePreview() {
    if (!preview || disabled || pending.current || needsReview) return;
    pending.current = true;
    setBusy('save');
    setError('');
    try {
      const { operation, body } = preview;
      if (operation === 'adjust') await saveDuoQuoteAdjustments(body);
      else if (operation === 'reset') await resetDuoQuoteAdjustments(body);
      else {
        const { versionId, ...tokens } = body;
        await restoreDuoQuoteVersion(versionId, tokens);
      }
      setPreview(null);
      const refreshed = await load();
      setDialog(null);
      setNotice(
        refreshed
          ? '已保存加价额，Duo 公开报价已生效。'
          : '已保存加价额；最新数据读取失败，请刷新核对。'
      );
    } catch (failure) {
      handleFailure(failure);
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

  async function loadMoreHistory() {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy('history');
    setError('');
    try {
      const result = await getDuoQuoteVersions(20, versions.length);
      setVersions(previous => [...previous, ...result.data.items]);
      setHistoryTotal(result.data.total);
    } catch (failure) {
      setError(failure.message || '读取更多历史失败，请重试');
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

  async function refresh() {
    if (pending.current || disabled) return;
    pending.current = true;
    setPreview(null);
    setNotice('');
    try {
      if (await load())
        setNotice('已读取最新报价。输入与选择已保留，请核对后重新预览。');
    } finally {
      pending.current = false;
    }
  }

  function openEditor(item, trigger) {
    if (disabled) return;
    returnFocusRef.current = trigger || document.activeElement;
    setPreview(null);
    setNotice('');
    if (!needsReview) setError('');
    if (item) {
      setSelected(new Set([item.productKey]));
      const currentAmount = mode === 'markup' ? item.markup : item.retailPrice;
      setAmount(currentAmount == null ? '' : String(currentAmount));
    } else {
      setAmount('');
    }
    setDialog({ type: 'edit' });
  }

  function closeDialog() {
    if (disabled || pending.current) return;
    setDialog(null);
    setPreview(null);
    if (!needsReview) setError('');
  }

  function openHistory(version, trigger) {
    returnFocusRef.current = trigger || document.activeElement;
    setDialog({
      type: 'restore',
      versionId: version.id,
      revision: version.revision,
      changes: version.changes || [],
    });
    createPreview('restore', version.id);
  }

  const selectedItems =
    dialog?.type === 'restore'
      ? items
      : items.filter(item => selected.has(item.productKey));
  const summaryItems = preview
    ? preview.data.items.filter(item => item.selected)
    : selectedItems;
  const errorBanner = error && (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
    >
      {error}
    </div>
  );
  const noticeBanner = notice && (
    <div
      role="status"
      className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900"
    >
      {notice}
    </div>
  );

  return (
    <>
      <div
        className={`duo-pricing duo-pricing-page space-y-4 ${selected.size ? 'duo-pricing-has-selection' : ''} ${dialog ? 'duo-pricing-dialog-open' : ''}`}
        aria-busy={disabled}
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">报价管理</h1>
            <p className="text-gray-500 mt-1 text-sm">
              iPhone Duo · 8 款商品 · 默认加价 +50 元
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href="/quote/duo"
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
            >
              <ExternalLink className="w-4 h-4" />
              查看公开报价
            </a>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={disabled}
              onClick={refresh}
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              />
              刷新并核对
            </button>
          </div>
        </header>
        <div className="duo-pricing-times text-sm text-gray-500">
          <p>
            批发价更新时间：
            <span className="text-gray-700">
              <time dateTime={data?.sourceUpdatedAt || undefined}>
                {time(data?.sourceUpdatedAt)}
              </time>
            </span>
          </p>
          <p>
            最近调价时间：
            <span className="text-gray-700">
              {data?.pricingUpdatedAt
                ? time(data.pricingUpdatedAt)
                : '暂未调价'}
            </span>
          </p>
        </div>
        {!dialog && errorBanner}
        {!dialog && noticeBanner}
        {data?.stale && (
          <p role="alert" className="text-sm text-amber-700">
            批发报价更新延迟，请核对批发价更新时间后操作。
          </p>
        )}
        <section
          className="rounded-xl border border-gray-200 bg-white overflow-hidden"
          aria-label="Duo 报价列表"
        >
          <div className="duo-pricing-list-toolbar">
            <span className="text-sm text-gray-500">
              已选 <strong className="text-primary">{selected.size}</strong> /{' '}
              {items.length} 款
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || !selected.size}
              onClick={event => openEditor(undefined, event.currentTarget)}
              aria-label={`批量设置（已选 ${selected.size} 款）`}
            >
              批量设置{selected.size ? `（${selected.size}）` : ''}
            </button>
          </div>
          <div className="duo-pricing-list-wrap">
            {items.length ? (
              <table className="duo-pricing-list w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="duo-pricing-mobile duo-pricing-product-heading">
                      <label className="duo-pricing-check">
                        <input
                          type="checkbox"
                          aria-label="全选 Duo 商品"
                          checked={allSelected}
                          disabled={disabled || !items.length}
                          onChange={() =>
                            changeDraft(() =>
                              setSelected(
                                allSelected
                                  ? new Set()
                                  : new Set(items.map(item => item.productKey))
                              )
                            )
                          }
                        />
                        <span>商品</span>
                      </label>
                    </th>
                    <th className="duo-pricing-mobile text-right">价格摘要</th>
                    <th className="duo-pricing-desktop px-3 py-3">
                      <label className="duo-pricing-check">
                        <input
                          type="checkbox"
                          aria-label="全选 Duo 商品"
                          checked={allSelected}
                          disabled={disabled || !items.length}
                          onChange={() =>
                            changeDraft(() =>
                              setSelected(
                                allSelected
                                  ? new Set()
                                  : new Set(items.map(item => item.productKey))
                              )
                            )
                          }
                        />
                      </label>
                    </th>
                    {[
                      '容量',
                      '颜色',
                      '批发价',
                      '官网价',
                      '加价额',
                      '零售价',
                      '溢价额',
                    ].map(label => (
                      <th
                        key={label}
                        className={`duo-pricing-desktop px-3 py-3 ${label === '容量' || label === '颜色' ? 'text-left' : 'text-right'}`}
                      >
                        {label}
                      </th>
                    ))}
                    <th className="duo-pricing-action-heading text-right">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map(item => (
                    <tr key={item.productKey} className="hover:bg-gray-50">
                      <td className="duo-pricing-mobile">
                        <div className="duo-pricing-mobile-product">
                          <label className="duo-pricing-check">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${formatStorageCapacity(item.storageGb)} ${item.color}`}
                              checked={selected.has(item.productKey)}
                              disabled={disabled}
                              onChange={() => toggleOne(item.productKey)}
                            />
                          </label>
                          <span>
                            <strong>
                              {formatStorageCapacity(item.storageGb)}
                            </strong>
                            <span className="block text-gray-500">
                              {item.color}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="duo-pricing-mobile duo-pricing-mobile-price">
                        <strong className="block text-primary">
                          {currency(item.retailPrice)}
                        </strong>
                        <span>批发 {currency(item.wholesalePrice)}</span>
                        <span>加价 {signed(item.markup)}</span>
                        {item.pricingError && (
                          <span className="text-amber-700">零售价异常</span>
                        )}
                      </td>
                      <td className="duo-pricing-desktop px-3">
                        <label className="duo-pricing-check">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${formatStorageCapacity(item.storageGb)} ${item.color}`}
                            checked={selected.has(item.productKey)}
                            disabled={disabled}
                            onChange={() => toggleOne(item.productKey)}
                          />
                        </label>
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 font-medium text-gray-900">
                        {formatStorageCapacity(item.storageGb)}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-gray-600">
                        {item.color}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-right text-gray-600">
                        {currency(item.wholesalePrice)}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-right text-gray-500">
                        {currency(item.officialPrice)}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-right text-gray-900">
                        {signed(item.markup)}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-right font-semibold text-primary">
                        {currency(item.retailPrice)}
                        {item.pricingError && (
                          <div className="mt-1 text-xs font-normal text-amber-700">
                            零售价异常，请调整加价
                          </div>
                        )}
                      </td>
                      <td className="duo-pricing-desktop px-3 py-3 text-right text-gray-600">
                        {signed(item.premiumAmount)}
                      </td>
                      <td className="duo-pricing-action">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={disabled}
                          aria-label={`设置 ${formatStorageCapacity(item.storageGb)} ${item.color}`}
                          onClick={event =>
                            openEditor(item, event.currentTarget)
                          }
                        >
                          设置
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div
                role="status"
                className="flex min-h-32 items-center justify-center p-6 text-center text-sm text-gray-500"
              >
                {loading
                  ? '正在加载报价…'
                  : error
                    ? '报价读取失败，请刷新重试'
                    : '暂无 Duo 商品'}
              </div>
            )}
          </div>
        </section>
        <p className="text-xs text-gray-500">
          零售价随批发价涨跌；按零售价设置时，仅将本次输入换算为加价额。
        </p>
        <section
          className="rounded-xl border border-gray-200 bg-white overflow-hidden"
          aria-label="报价历史"
        >
          <h2 className="p-4 flex items-center gap-2 font-semibold text-gray-900">
            <History className="w-5 h-5" />
            调价历史
          </h2>
          <div className="overflow-x-auto">
            {versions.length ? (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="duo-pricing-history-mobile">
                      版本 / 操作人
                    </th>
                    <th className="duo-pricing-history-mobile">变更摘要</th>
                    {['版本 / 时间', '操作人', '变更'].map(label => (
                      <th
                        key={label}
                        className="duo-pricing-history-desktop px-4 py-3 whitespace-nowrap"
                      >
                        {label}
                      </th>
                    ))}
                    <th className="duo-pricing-history-action">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {versions.map(version => (
                    <tr key={version.id} className="hover:bg-gray-50">
                      <td className="duo-pricing-history-mobile">
                        <strong className="text-gray-900">
                          版本 {version.revision}
                        </strong>
                        <time
                          className="block text-gray-500"
                          dateTime={version.createdAt}
                        >
                          {time(version.createdAt)}
                        </time>
                        <span className="block text-gray-600">
                          {version.actorName || '—'}
                        </span>
                      </td>
                      <td className="duo-pricing-history-mobile">
                        <p>{actionLabels[version.action] || version.action}</p>
                        <p className="mt-1 text-gray-500">
                          {version.changes?.length
                            ? `${version.changes.length} 款加价额变更`
                            : '加价额无变化'}
                        </p>
                      </td>
                      <td className="duo-pricing-history-desktop px-4 py-3 whitespace-nowrap">
                        <span className="font-medium text-gray-900">
                          版本 {version.revision}
                        </span>
                        <div className="mt-1 text-gray-500">
                          {time(version.createdAt)}
                        </div>
                      </td>
                      <td className="duo-pricing-history-desktop px-4 py-3 whitespace-nowrap text-gray-600">
                        {version.actorName || '—'}
                      </td>
                      <td className="duo-pricing-history-desktop px-4 py-3 text-gray-600">
                        <div>
                          {actionLabels[version.action] || version.action}
                        </div>
                        {version.changes?.length ? (
                          <ul className="mt-1 space-y-1">
                            {version.changes.map(change => (
                              <li key={change.productKey}>
                                {formatStorageCapacity(change.storageGb)}{' '}
                                {change.color}：{signed(change.previousMarkup)}{' '}
                                → {signed(change.markup)}
                                <div className="text-gray-500">
                                  零售价：{currency(change.previousRetailPrice)}{' '}
                                  → {currency(change.retailPrice)}（当时批发价{' '}
                                  {currency(change.wholesalePrice)}）
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1 text-gray-500">加价额无变化</p>
                        )}
                      </td>
                      <td className="duo-pricing-history-action">
                        <button
                          type="button"
                          className="btn btn-secondary whitespace-nowrap"
                          disabled={disabled || needsReview}
                          aria-label={`预览恢复版本 ${version.revision}`}
                          onClick={event =>
                            openHistory(version, event.currentTarget)
                          }
                        >
                          <span className="duo-pricing-history-desktop">
                            预览恢复
                          </span>
                          <span className="duo-pricing-history-mobile">
                            恢复
                          </span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div
                role="status"
                className="flex min-h-32 items-center justify-center p-6 text-center text-sm text-gray-500"
              >
                {loading ? '正在加载历史…' : '暂无调价历史'}
              </div>
            )}
          </div>
          <div className="p-4 flex flex-wrap justify-between items-center gap-2 text-sm text-gray-500">
            <span>
              已显示 {versions.length} / {historyTotal} 条
            </span>
            {versions.length < historyTotal && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={disabled}
                onClick={loadMoreHistory}
              >
                {busy === 'history' ? '正在加载…' : '加载更多历史'}
              </button>
            )}
          </div>
        </section>
      </div>
      {dialog && (
        <PricingDialog
          title={
            dialog.type === 'restore'
              ? `恢复历史版本 ${dialog.revision}`
              : selected.size === 1
                ? '设置单款报价'
                : `批量设置 ${selected.size} 款报价`
          }
          busy={disabled}
          returnFocusRef={returnFocusRef}
          onClose={closeDialog}
          footer={
            needsReview ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={disabled}
                onClick={refresh}
              >
                <RefreshCw className="w-4 h-4" />
                刷新并核对
              </button>
            ) : preview ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabled}
                  onClick={() => setPreview(null)}
                >
                  取消预览
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={disabled}
                  onClick={savePreview}
                >
                  {busy === 'save' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  确认保存加价额
                </button>
              </>
            ) : dialog.type === 'restore' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={disabled}
                onClick={() => createPreview('restore', dialog.versionId)}
              >
                <Eye className="w-4 h-4" />
                重新预览恢复
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabled || !selected.size}
                  onClick={() => createPreview('reset')}
                >
                  <RotateCcw className="w-4 h-4" />
                  恢复默认 +50
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    disabled ||
                    !selected.size ||
                    (mode === 'retail' && missingBase)
                  }
                  onClick={() => createPreview('adjust')}
                >
                  <Eye className="w-4 h-4" />
                  预览设置
                </button>
              </>
            )
          }
        >
          {errorBanner}
          {noticeBanner}
          <div className="duo-pricing-dialog-times text-xs text-gray-500">
            <p>
              批发价更新时间：
              <time dateTime={data?.sourceUpdatedAt || undefined}>
                {time(data?.sourceUpdatedAt)}
              </time>
            </p>
            <p>
              最近调价时间：
              {data?.pricingUpdatedAt
                ? time(data.pricingUpdatedAt)
                : '暂未调价'}
            </p>
          </div>
          {dialog.type === 'edit' && (
            <section aria-label="设置报价">
              <fieldset disabled={disabled} className="flex flex-wrap gap-x-4">
                <legend className="sr-only">设置方式</legend>
                {[
                  ['markup', '按加价额设置'],
                  ['retail', '按零售价设置'],
                ].map(([value, label]) => (
                  <label key={value} className="duo-pricing-choice">
                    <input
                      type="radio"
                      name="duo-pricing-mode"
                      value={value}
                      checked={mode === value}
                      onChange={() =>
                        changeDraft(() => {
                          setMode(value);
                          setAmount('');
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="block mt-2 text-sm font-medium text-gray-700">
                {mode === 'markup' ? '加价额（元）' : '零售价（元）'}
                <input
                  className="input mt-2 duo-pricing-amount-input"
                  aria-label={
                    mode === 'markup' ? '加价额（元）' : '零售价（元）'
                  }
                  inputMode="decimal"
                  value={amount}
                  disabled={disabled}
                  placeholder={
                    mode === 'markup' ? '例如 50 或 -20' : '请输入零售价'
                  }
                  onChange={event =>
                    changeDraft(() => setAmount(event.target.value))
                  }
                />
              </label>
              <p className="mt-2 text-xs text-gray-500">
                仅保存加价额，后续零售价随批发价涨跌。批量输入同一零售价时，逐款换算不同加价额。
              </p>
              {mode === 'retail' && missingBase && (
                <p role="alert" className="mt-2 text-sm text-amber-700">
                  所选商品缺少批发价，无法按零售价换算；可按加价额设置。
                </p>
              )}
            </section>
          )}
          {busy === 'preview' && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-gray-500"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              正在生成预览…
            </p>
          )}
          {preview && (
            <section
              ref={previewRef}
              aria-label="报价变更预览"
              className="duo-pricing-preview"
            >
              <h3 className="font-semibold text-gray-900">
                确认变更 · {actionLabels[preview.operation]}
              </h3>
              <p className="mt-1 mb-3 text-xs text-gray-500">
                共 {preview.data.selectedCount}{' '}
                款；确认后保存以下加价额。恢复历史按最新批发价重算零售价。
              </p>
              <table className="duo-pricing-preview-table">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>加价额</th>
                    <th>零售价</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryItems.map(item => (
                    <tr key={item.productKey}>
                      <td>
                        <strong>{formatStorageCapacity(item.storageGb)}</strong>
                        <span className="block">{item.color}</span>
                      </td>
                      <td>
                        <span className="block text-gray-500">
                          {signed(item.previousMarkup)}
                        </span>
                        <strong className="block text-primary">
                          → {signed(item.markup)}
                        </strong>
                      </td>
                      <td>
                        <span className="block text-gray-500">
                          {currency(item.previousRetailPrice)}
                        </span>
                        <strong className="block text-primary">
                          → {currency(item.retailPrice)}
                        </strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {dialog.type === 'restore' && (
            <details className="duo-pricing-history-details">
              <summary className="text-sm font-medium text-primary">
                查看该次历史完整变更（{dialog.changes.length} 款）
              </summary>
              <table className="duo-pricing-summary-table">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>当时的变更</th>
                  </tr>
                </thead>
                <tbody>
                  {dialog.changes.map(change => (
                    <tr key={change.productKey}>
                      <td>
                        {formatStorageCapacity(change.storageGb)}
                        <span className="block">{change.color}</span>
                      </td>
                      <td>
                        <p>
                          加价 {signed(change.previousMarkup)} →{' '}
                          {signed(change.markup)}
                        </p>
                        <p>
                          零售 {currency(change.previousRetailPrice)} →{' '}
                          {currency(change.retailPrice)}
                        </p>
                        <p>当时批发 {currency(change.wholesalePrice)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <section aria-label="选中商品报价摘要">
            <h3 className="font-semibold text-gray-900">
              {preview ? '拟保存商品摘要' : '当前商品摘要'}
            </h3>
            <table className="duo-pricing-summary-table">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>报价摘要</th>
                </tr>
              </thead>
              <tbody>
                {summaryItems.map(item => (
                  <tr key={item.productKey}>
                    <td>
                      <strong>{formatStorageCapacity(item.storageGb)}</strong>
                      <span className="block">{item.color}</span>
                    </td>
                    <td>
                      <p className="font-semibold text-primary">
                        零售 {currency(item.retailPrice)}
                      </p>
                      <p>
                        批发 {currency(item.wholesalePrice)} · 加价{' '}
                        {signed(item.markup)}
                      </p>
                      <p>
                        官网 {currency(item.officialPrice)} · 溢价{' '}
                        {signed(item.premiumAmount)}
                      </p>
                      {item.pricingError && (
                        <p className="text-amber-700">零售价异常，请调整加价</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-gray-500">
              溢价额为零售价减官网价后向下取整至十元。
            </p>
          </section>
        </PricingDialog>
      )}
    </>
  );
}
