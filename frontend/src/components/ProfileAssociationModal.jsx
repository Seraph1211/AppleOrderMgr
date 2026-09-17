import { useState } from 'react';
import { X } from 'lucide-react';
import client from '../api/client';

/** 历史订单关联必须先预览，用户勾选确认后才补齐空关联。 */
export default function ProfileAssociationModal({ onClose, onComplete }) {
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [cursor, setCursor] = useState(0);
  const load = async nextCursor => {
    setBusy(true);
    setError('');
    setDone(null);
    try {
      const response = await client.post('/import/associations/preview', { cursor: nextCursor });
      setPreview(response.data);
      setCursor(nextCursor);
      setSelected([]);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const execute = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await client.post('/import/associations/execute', {
        token: preview.token,
        orderIds: selected,
      });
      setDone(response.data.updated);
      setSelected([]);
      setPreview(previous => ({ ...previous, token: null }));
      await onComplete();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="历史订单关联"
        className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b flex justify-between">
          <h2 className="text-xl font-semibold">历史订单关联预览</h2>
          <button aria-label="关闭" disabled={busy} onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-auto space-y-4">
          <p className="text-sm text-gray-600">
            每批检查 500 条尚未完整关联的订单。取机人需有订单本身的姓名及身份等证据；账号按订单
            Apple ID 匹配。只补空关联，不改已有归属、密码、TAG 或订单快照。
          </p>
          <button
            className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy}
            onClick={() => load(cursor)}
          >
            生成／重新生成预览
          </button>
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          {done !== null && (
            <p role="status" className="text-green-700">
              已补齐 {done} 条订单的空关联。
            </p>
          )}
          {preview && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2">
                        <input
                          aria-label="选择本批可关联订单"
                          type="checkbox"
                          disabled={!preview.token || busy}
                          checked={
                            selected.length > 0 &&
                            selected.length === preview.records.filter(x => x.matchable).length
                          }
                          onChange={e =>
                            setSelected(
                              e.target.checked
                                ? preview.records.filter(x => x.matchable).map(x => x.orderId)
                                : []
                            )
                          }
                        />
                      </th>
                      {['订单号', '候选取机人', '候选账号编号', '结论'].map(x => (
                        <th key={x} className="text-left p-2">
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.records.map(row => (
                      <tr key={row.orderId} className="border-b">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`选择订单 ${row.orderNumber}`}
                            disabled={!row.matchable || !preview.token || busy}
                            checked={selected.includes(row.orderId)}
                            onChange={e =>
                              setSelected(previous =>
                                e.target.checked
                                  ? [...previous, row.orderId]
                                  : previous.filter(id => id !== row.orderId)
                              )
                            }
                          />
                        </td>
                        <td>{row.orderNumber}</td>
                        <td>{row.recipientName || '无新增关联'}</td>
                        <td>{row.appleIdRef || '无新增关联'}</td>
                        <td>{row.matchable ? '待确认' : '证据不足，保持原样'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!preview.records.length && <p className="p-4 text-gray-500">没有待检查订单</p>}
              </div>
              {preview.nextCursor && (
                <button
                  disabled={busy}
                  className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => load(preview.nextCursor)}
                >
                  检查下一批
                </button>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-3">
          <button
            className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy || !preview?.token || !selected.length}
            onClick={execute}
          >
            确认关联选中 {selected.length} 条
          </button>
        </div>
      </div>
    </div>
  );
}
