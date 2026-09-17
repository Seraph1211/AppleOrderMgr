import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

/** 展示选中取机人的逐行录入信息，并提供一次性复制。 */
export default function RecipientImportInfoModal({ content, loading, error, onClose }) {
  const [copied, setCopied] = useState(false);

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      setCopied(true);
    }
  };

  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="选中记录的录入信息"
        className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">选中记录的录入信息</h2>
            <p className="text-sm text-gray-500 mt-1">每条记录一行，可直接复制后粘贴使用。</p>
          </div>
          <button aria-label="关闭" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-auto flex-1">
          {loading ? (
            <p className="text-gray-500 py-10 text-center">正在生成录入信息…</p>
          ) : error ? (
            <p role="alert" className="text-red-700 bg-red-50 p-3 rounded">
              {error}
            </p>
          ) : (
            <textarea
              aria-label="录入信息"
              className="input w-full min-h-[320px] font-mono text-sm leading-6 resize-y"
              readOnly
              value={content}
            />
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-3">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn btn-primary flex items-center gap-2"
            disabled={loading || Boolean(error) || !content}
            onClick={copyContent}
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
