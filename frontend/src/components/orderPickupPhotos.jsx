import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Image, X } from 'lucide-react';
import { getPickupEvidenceUrl, getPickupRecords } from '../api/pickupsApi';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';

function PhotoPreview({ orderId, photo, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState({ loading: true, url: '', error: '' });

  useEffect(() => {
    let active = true;
    const load = async () => {
      setPreview({ loading: true, url: '', error: '' });
      try {
        const response = await getPickupEvidenceUrl(orderId, photo.id);
        if (!response.data?.url) throw new Error('未取得照片地址，请重试');
        if (active) setPreview({ loading: true, url: response.data.url, error: '' });
      } catch (error) {
        if (active) setPreview({ loading: false, url: '', error: error.message || '照片加载失败' });
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [orderId, photo.id, attempt]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    const handleKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.click();
      } else if (event.key === 'Tab') {
        const controls = [...dialogRef.current.querySelectorAll('button, a[href]')];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-0 sm:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-pickup-photo-title"
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-xl sm:h-[90dvh] sm:max-w-4xl sm:rounded-lg"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <div className="min-w-0">
            <h2 id="order-pickup-photo-title" className="font-semibold">
              取货照片
            </h2>
            <p className="truncate text-sm text-gray-500" title={photo.originalName}>
              {photo.originalName}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭取货照片"
            className="btn btn-secondary min-h-11 min-w-11 shrink-0 p-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-gray-100 p-3">
          {preview.loading && (
            <p role="status" className="absolute text-sm text-gray-500">
              正在加载照片...
            </p>
          )}
          {preview.error && (
            <div role="alert" className="max-w-full space-y-3 break-words text-center">
              <p className="text-sm text-red-700">{preview.error}</p>
              <button
                type="button"
                className="btn btn-secondary min-h-11"
                onClick={() => setAttempt(value => value + 1)}
              >
                重新加载照片
              </button>
            </div>
          )}
          {preview.url && (
            <img
              key={`${attempt}-${preview.url}`}
              src={preview.url}
              alt={photo.originalName}
              className={`h-full w-full object-contain ${preview.loading ? 'invisible' : ''}`}
              onLoad={() => setPreview(value => ({ ...value, loading: false }))}
              onError={() =>
                setPreview({
                  loading: false,
                  url: '',
                  error: '照片加载失败或链接已过期，请重新加载',
                })
              }
            />
          )}
        </div>
        {preview.url && (
          <div className="shrink-0 border-t border-gray-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex sm:justify-end">
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary inline-flex min-h-11 w-full items-center justify-center gap-2 sm:w-auto"
            >
              <ExternalLink className="h-4 w-4" />
              在新窗口打开
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function PhotoList({ orderId, orderNumber }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ loading: true, photos: [], error: '' });
  const [photo, setPhoto] = useState(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setResult({ loading: true, photos: [], error: '' });
      try {
        if (!orderId || !orderNumber) throw new Error('订单信息不完整，无法加载取货照片');
        // 搜索接口是模糊匹配：逐页查找并核对 ID 和完整订单号，绝不取第一项代替。
        for (let page = 1; active; page += 1) {
          const response = await getPickupRecords({ search: orderNumber, page, pageSize: 100 });
          if (!active) return;
          const data = response.data;
          if (!Array.isArray(data?.items)) throw new Error('取货照片列表响应异常，请重试');
          const record = data.items.find(
            item => String(item.orderId) === String(orderId) && item.orderNumber === orderNumber
          );
          if (record) {
            const photos = (record.evidence || []).filter(
              item => item.kind === 'pickup' && /^image\/(jpeg|png|webp)$/i.test(item.contentType)
            );
            setResult({ loading: false, photos, error: '' });
            return;
          }
          if (page * 100 >= data.total || data.items.length < 100) break;
        }
        if (active) throw new Error('未找到可查看的当前订单取货记录');
      } catch (error) {
        if (active)
          setResult({ loading: false, photos: [], error: error.message || '取货照片加载失败' });
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [orderId, orderNumber, attempt]);

  return (
    <>
      <section className="card" aria-label="取货照片">
        <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <Image className="h-5 w-5 text-primary" />
          取货照片
          {!result.loading && !result.error && (
            <span className="badge bg-blue-50 text-primary">{result.photos.length} 张</span>
          )}
        </h3>
        {result.loading && (
          <p role="status" className="text-sm text-gray-500">
            正在加载取货照片...
          </p>
        )}
        {result.error && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-red-700">{result.error}</p>
            <button
              type="button"
              className="btn btn-secondary min-h-11"
              onClick={() => setAttempt(value => value + 1)}
            >
              重试加载列表
            </button>
          </div>
        )}
        {!result.loading && !result.error && !result.photos.length && (
          <p className="text-sm text-gray-500">暂无取货照片</p>
        )}
        {!!result.photos.length && (
          <ul className="divide-y divide-gray-100">
            {result.photos.map(item => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 break-all text-sm text-gray-700">
                  {item.originalName || '取货照片'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary min-h-11 shrink-0"
                  onClick={() => setPhoto(item)}
                  aria-label={`查看照片 ${item.originalName || item.id}`}
                >
                  查看
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {photo && (
        <PhotoPreview
          key={photo.id}
          orderId={orderId}
          photo={photo}
          onClose={() => setPhoto(null)}
        />
      )}
    </>
  );
}

/** 在订单详情中只读查看当前订单的取货照片，沿用取货权限和签名读取接口。 */
export default function OrderPickupPhotos({ orderId, orderNumber }) {
  const { can, user } = useAuth();
  if (!can(PERMISSIONS.PICKUPS_READ)) return null;
  return (
    <PhotoList
      key={`${user?.id}-${orderId}-${orderNumber}`}
      orderId={orderId}
      orderNumber={orderNumber}
    />
  );
}
