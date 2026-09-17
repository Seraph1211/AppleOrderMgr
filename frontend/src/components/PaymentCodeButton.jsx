import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QrCode, X } from 'lucide-react';
import client from '../api/client';
import { getPaymentStageLabel } from '../utils/paymentStage';

/** 按服务端当前任务权限读取付款码；支付宝只显示明确提示。 */
export default function PaymentCodeButton({ taskId, dispatch = false }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const button = useRef(null);
  const dialog = useRef(null);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setData(null);
    setError('');
    const read = async () => {
      try {
        const response = await client.get(
          `${dispatch ? '/payment-dispatch/tasks' : '/payment-tasks'}/${taskId}/payment-code`,
          { signal: abort.signal }
        );
        if (!abort.signal.aborted) setData(response.data);
      } catch (e) {
        if (!abort.signal.aborted) setError(e.message || '付款码读取失败，请关闭后重试');
      }
    };
    read();
    const trigger = button.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    return () => {
      abort.abort();
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open, taskId, dispatch]);
  const stage = data && getPaymentStageLabel(data);
  const expired = !stage && data?.deadlineAt && Date.parse(data.deadlineAt) <= Date.now();
  const warning = stage || (expired ? '付款已过期' : null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-secondary px-2 inline-flex items-center justify-center gap-1"
        onClick={() => setOpen(true)}
      >
        <QrCode aria-hidden="true" className="w-4 h-4 shrink-0" />
        <span>查看付款码</span>
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-3"
            onClick={() => setOpen(false)}
          >
            <section
              ref={dialog}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="查看付款码"
              className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-4 outline-none"
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Tab') {
                  e.preventDefault();
                  dialog.current?.querySelector('button')?.focus();
                }
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">查看付款码</h2>
                <button
                  type="button"
                  className="btn btn-secondary p-2"
                  aria-label="关闭付款码"
                  onClick={() => setOpen(false)}
                >
                  <X aria-hidden="true" className="w-4 h-4" />
                </button>
              </div>
              {!data && !error && (
                <p role="status" className="text-gray-500 py-8 text-center">
                  正在读取付款码…
                </p>
              )}
              {error && (
                <p role="alert" className="text-red-700 py-6">
                  {error}
                </p>
              )}
              {data?.availability === 'unsupported' ? (
                <p role="status" className="text-gray-700 py-8 text-center">
                  支付宝暂无法获取付款码
                </p>
              ) : (
                data && (
                  <>
                    {warning && (
                      <p
                        role="alert"
                        className="bg-amber-50 text-amber-800 border border-amber-200 rounded-lg p-3 mb-3"
                      >
                        {warning}，请勿继续付款。
                      </p>
                    )}
                    <dl className="text-sm divide-y divide-gray-100 text-gray-700">
                      {[
                        ['订单序号（系统 ID）', data.orderId],
                        ['订单号（Apple）', data.orderNumber],
                        [
                          '商品信息',
                          data.products?.map(p => `${p.name} × ${p.quantity}`).join('；') || '—',
                        ],
                        ['金额', data.amount == null ? '待获取' : `¥${data.amount}`],
                        ['支付方式', data.paymentMethod || '—'],
                      ].map(([label, value]) => (
                        <div key={label} className="flex gap-3 py-2">
                          <dt className="text-gray-500 w-32 shrink-0">{label}</dt>
                          <dd className="min-w-0 break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {data.imageDataUrl ? (
                      <div className="text-center mt-4">
                        <img
                          src={data.imageDataUrl}
                          alt={`订单 ${data.orderNumber} 的微信付款码`}
                          className="mx-auto w-[250px] max-w-full h-auto"
                          style={{ imageRendering: 'pixelated', WebkitTouchCallout: 'default' }}
                        />
                        <p className="text-gray-500 text-xs mt-3">
                          请对着屏幕扫码付款，不支持保存到相册后再识别付款
                        </p>
                      </div>
                    ) : (
                      <p role="status" className="text-gray-500 py-8 text-center">
                        {data.message}
                      </p>
                    )}
                  </>
                )
              )}
            </section>
          </div>,
          document.body
        )}
    </>
  );
}
