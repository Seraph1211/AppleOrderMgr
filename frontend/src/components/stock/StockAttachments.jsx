import { useState } from 'react';
import { Paperclip, ExternalLink } from 'lucide-react';
import { stockGet } from '../../api/stockApi';
import { StockFeedback } from './StockCommon';
import { useStockCommand } from './stockHooks';

/** 私有凭证上传确认及按需签名查看，不把照片加入公共 URL。 */
export default function StockAttachments({ target, items = [], canWrite, onSaved }) {
  const command = useStockCommand();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState(null);
  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (
        !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) ||
        file.size > 10 * 1024 * 1024
      )
        throw new Error('仅支持不超过 10MiB 的 JPG、PNG、WebP 或 PDF');
      const record = await command.execute('POST', '/attachments/prepare', {
        kind: {
          unit: 'unit_photo',
          sale: 'sale_document',
          collection: 'collection_proof',
          receipt: 'receipt_proof',
          expense: 'expense_proof',
        }[target.type],
        originalName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        targets: [target],
      });
      if (!record) return;
      setPrepared(record);
      const response = await fetch(record.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, ...(record.uploadHeaders || record.headers || {}) },
        body: file,
      });
      if (!response.ok) throw new Error('文件上传未确认，请重新选择文件重试');
      const result = await command.execute(
        'POST',
        `/attachments/${record.attachmentId || record.id}/confirm`,
        { expectedVersion: record.version ?? 0 }
      );
      if (result) {
        setPrepared(null);
        onSaved();
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const retryConfirm = async () => {
    try {
      const result = await command.execute(
        'POST',
        `/attachments/${prepared.attachmentId || prepared.id}/confirm`,
        { expectedVersion: prepared.version ?? 0 }
      );
      if (result) {
        setPrepared(null);
        onSaved();
      }
    } catch (failure) {
      setError(failure.message);
    }
  };
  const view = async item => {
    const tab = window.open('', '_blank');
    try {
      const data = await stockGet(`/attachments/${item.id}/read`);
      if (!data.url && !data.readUrl) throw new Error('未获得凭证访问地址');
      if (tab) {
        tab.opener = null;
        tab.location = data.url || data.readUrl;
      }
    } catch (failure) {
      tab?.close();
      setError(failure.message);
    }
  };
  return (
    <section className="space-y-3 border-t pt-3">
      <h3 className="font-medium">照片与凭证</h3>
      <ul className="space-y-2">
        {items.map(item => (
          <li key={item.id}>
            <button
              type="button"
              className="btn btn-secondary max-w-full"
              onClick={() => view(item)}
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.originalName || '查看凭证'}</span>
            </button>
          </li>
        ))}
      </ul>
      {!items.length && <p className="text-sm text-gray-500">暂无已确认附件</p>}
      {canWrite && (
        <label
          className={`btn btn-secondary cursor-pointer ${busy || command.busy ? 'pointer-events-none opacity-50' : ''}`}
        >
          <Paperclip className="h-4 w-4" />
          {busy ? '上传中…' : '上传照片 / 凭证'}
          <input
            aria-label="上传库存凭证"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            disabled={busy || command.busy}
            onChange={upload}
          />
        </label>
      )}
      {prepared && (
        <button
          type="button"
          className="btn btn-secondary ml-2"
          disabled={busy || command.busy}
          onClick={retryConfirm}
        >
          重试确认已上传文件
        </button>
      )}
      <StockFeedback error={error || command.error} />
    </section>
  );
}
