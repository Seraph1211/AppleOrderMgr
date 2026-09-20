import { AlertCircle, Download, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { orderExportFields } from '../constants/orderExportFields';

const STORAGE_KEY = 'orderExportFields:v1';

function loadSavedFields(defaultFields) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const allowed = new Set(orderExportFields.map(field => field.key));
    const valid = Array.isArray(saved) ? saved.filter(field => allowed.has(field)) : [];
    return valid.length ? [...new Set(valid)] : defaultFields;
  } catch (_error) {
    return defaultFields;
  }
}

/** 选择当前页订单导出的服务端白名单字段。 */
export default function OrderExportModal({ count, defaultFields, onClose, onExport }) {
  const initialFields = useMemo(() => loadSavedFields(defaultFields), [defaultFields]);
  const [selectedFields, setSelectedFields] = useState(initialFields);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const toggleField = key => {
    setSelectedFields(previous =>
      previous.includes(key) ? previous.filter(field => field !== key) : [...previous, key]
    );
    setError('');
  };

  const submit = async () => {
    if (!selectedFields.length) {
      setError('请至少选择一个导出字段');
      return;
    }
    setExporting(true);
    setError('');
    try {
      await onExport(selectedFields);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedFields));
      onClose();
    } catch (exportError) {
      setError(exportError.message || '导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-2xl rounded-lg bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">导出选中订单</h2>
            <p className="mt-1 text-sm text-gray-500">将导出当前页已选择的 {count} 个订单</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={exporting}
            className="text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-50"
            aria-label="关闭导出字段选择"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-sm text-gray-600">已选择 {selectedFields.length} 个字段</span>
            <div className="flex items-center gap-3 text-sm">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setSelectedFields(orderExportFields.map(field => field.key))}
              >
                全选
              </button>
              <button
                type="button"
                className="text-gray-600 hover:text-gray-900 hover:underline"
                onClick={() => setSelectedFields([])}
              >
                清空
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
            {orderExportFields.map(field => (
              <label
                key={field.key}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:border-primary hover:bg-blue-50"
              >
                <input
                  type="checkbox"
                  checked={selectedFields.includes(field.key)}
                  onChange={() => toggleField(field.key)}
                  disabled={exporting}
                />
                <span>{field.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>密码、身份证号、订单链接和付款截图不提供导出；字段选择仅保存在当前浏览器。</p>
          </div>
          {error && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-200 p-4">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={exporting}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary inline-flex items-center gap-2"
            onClick={submit}
            disabled={exporting || selectedFields.length === 0}
          >
            <Download className="h-4 w-4" />
            {exporting ? '正在导出' : '导出 Excel'}
          </button>
        </div>
      </div>
    </div>
  );
}
