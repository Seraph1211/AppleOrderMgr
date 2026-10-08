import { useState } from 'react';
import { StockFeedback, StockModal } from './StockCommon';
import { useStockData } from './stockHooks';

/** 按需鉴权获取临时地址，在页面内预览库存留底照片和凭证。 */
export default function StockAttachmentPreview({ item, onClose }) {
  const resource = useStockData(`/attachments/${item.id}/read`);
  const [imageState, setImageState] = useState('loading');
  const data = resource.data;
  const url = data?.readUrl || data?.url;
  const isPdf = (data?.contentType || item.contentType) === 'application/pdf';
  const error = resource.error ||
    (data && !url ? '未获得凭证访问地址，请重试' : '') ||
    (imageState === 'error' ? '照片加载失败，临时地址可能已过期，请重试' : '');
  const retry = () => {
    setImageState('loading');
    resource.reload();
  };
  return (
    <StockModal title="照片与凭证预览" onClose={onClose} wide>
      <p className="mb-3 break-all text-sm text-gray-600">{item.originalName || '库存凭证'}</p>
      <StockFeedback loading={resource.loading} error={error} onRetry={retry} />
      {!resource.loading && url && !error && (
        isPdf ? (
          <>
            <a className="btn btn-secondary mb-3" href={url} target="_blank" rel="noopener noreferrer">
              打开 PDF 凭证
            </a>
            <iframe title="库存 PDF 凭证" src={url} className="h-[65dvh] w-full border-0" />
          </>
        ) : (
          <>
            {imageState === 'loading' && <p role="status" className="text-sm text-gray-500">照片加载中…</p>}
            <img
              key={url}
              src={url}
              alt={item.originalName || '库存留底照片'}
              className="mx-auto max-h-[70dvh] max-w-full object-contain"
              referrerPolicy="no-referrer"
              onLoad={() => setImageState('loaded')}
              onError={() => setImageState('error')}
            />
          </>
        )
      )}
    </StockModal>
  );
}
