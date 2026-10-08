import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { recognizeStockBox } from '../../api/stockApi';
import { validateOcrFile } from '../../utils/pickupOcr';

const LABELS = {
  waiting: '等待',
  processing: '处理中',
  done: '已完成',
  failed: '失败',
  removed: '已取消，未登记',
};
/** 单并发队列；暂停、显式重试及代次隔离，预览仅驻留当前表单。 */
export default function StockBoxQueue({ onCandidates, onBusy, onDirty, disabled }) {
  const [jobs, setJobs] = useState([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const state = useRef({
    jobs: [],
    paused: false,
    generation: 0,
    active: false,
    nextAt: 0,
    timer: null,
    urls: [],
    controller: null,
    alive: true,
  });
  const callbacks = useRef({ onCandidates, onBusy, onDirty });
  callbacks.current = { onCandidates, onBusy, onDirty };
  const publish = () => {
    if (state.current.alive) setJobs([...state.current.jobs]);
  };
  const pause = value => {
    state.current.paused = value;
    setPaused(value);
  };
  const runRef = useRef(null);
  const run = async () => {
    const s = state.current;
    if (!s.alive || s.active || s.paused || disabled) return;
    const job = s.jobs.find(item => item.status === 'waiting');
    if (!job) return;
    if (Date.now() < s.nextAt) {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => runRef.current(), s.nextAt - Date.now());
      return;
    }
    s.active = true;
    const generation = s.generation;
    job.status = 'processing';
    publish();
    s.controller = new AbortController();
    try {
      const picture = new Image();
      picture.src = job.url;
      await picture.decode();
      if (
        picture.naturalWidth * picture.naturalHeight > 48000000 ||
        Math.min(picture.naturalWidth, picture.naturalHeight) <= 15 ||
        Math.max(picture.naturalWidth, picture.naturalHeight) >= 8192
      )
        throw new Error('图片尺寸须大于 15、小于 8192 像素且不超过 4800 万像素，请裁剪清晰盒标');
      let barcodes = [];
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all(
          [import('@zxing/browser'), import('@zxing/library')]
        );
        const reader = new BrowserMultiFormatReader(
          new Map([
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]],
            [DecodeHintType.TRY_HARDER, true],
          ])
        );
        // 条码仅在受控尺寸副本上解码，原图仍直接发云端；避免大图阻塞手机主线程。
        const scale = Math.min(1, 1600 / Math.max(picture.naturalWidth, picture.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
        const boundedPicture = new Image();
        boundedPicture.src = canvas.toDataURL('image/png');
        await boundedPicture.decode();
        if (generation !== s.generation || !s.alive) return;
        const result = await reader.decodeFromImageElement(boundedPicture);
        barcodes = [result.getText()];
      } catch (_error) {
        /* 条码不可读仍允许核对文字。 */
      }
      if (generation !== s.generation || !s.alive) return;
      let uploadFile = job.file;
      if (job.file.size > 4 * 1024 * 1024) {
        // 只转换上传副本；保留原图预览与内容摘要，不自动重试计费请求。
        const scale = Math.min(1, 4096 / Math.max(picture.naturalWidth, picture.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(picture, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob) throw new Error('大图压缩失败，请裁剪清晰盒标后重试');
        uploadFile = new File([blob], `${job.file.name.replace(/\.[^.]+$/, '')}.ocr.jpg`, {
          type: 'image/jpeg',
        });
      }
      if (generation !== s.generation || !s.alive) return;
      s.nextAt = Date.now() + 6500;
      const response = await recognizeStockBox(uploadFile, barcodes, s.controller.signal);
      if (generation !== s.generation || !s.alive) return;
      callbacks.current.onCandidates(response.data.candidates, {
        url: job.url,
        name: job.file.name,
      });
      job.status = 'done';
    } catch (failure) {
      if (generation !== s.generation || !s.alive) return;
      job.status = 'failed';
      job.error = failure.message;
      if (
        [
          'OCR_MONTHLY_LIMIT',
          'OCR_NOT_CONFIGURED',
          'OCR_QUOTA_UNAVAILABLE',
          'OCR_RATE_LIMIT',
        ].includes(failure.code) ||
        failure.response?.status === 429
      ) {
        pause(true);
        setError(`${failure.message}；队列已暂停，可手工录入。已发出请求可能已计费。`);
      }
    } finally {
      s.active = false;
      publish();
      if (s.alive) runRef.current();
    }
  };
  runRef.current = run;
  useEffect(() => {
    callbacks.current.onBusy(jobs.some(job => ['waiting', 'processing'].includes(job.status)));
    callbacks.current.onDirty?.(jobs.length > 0);
  }, [jobs]);
  useEffect(() => {
    const s = state.current;
    s.alive = true;
    return () => {
      s.alive = false;
      s.generation += 1;
      clearTimeout(s.timer);
      s.controller?.abort();
      s.urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);
  const select = async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length > 20) {
      setError('每批最多选择 20 张照片');
      return;
    }
    const invalid = files.map(validateOcrFile).find(Boolean);
    if (invalid) {
      setError(invalid);
      return;
    }
    const s = state.current;
    const generation = s.generation;
    callbacks.current.onDirty?.(true);
    callbacks.current.onBusy(true);
    try {
      let duplicates = 0;
      for (const file of files) {
        const key = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
        ]
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
        if (!s.alive || generation !== s.generation) return;
        if (s.jobs.some(job => job.key === key && job.status !== 'removed')) {
          duplicates += 1;
          continue;
        }
        if (s.jobs.filter(job => job.status !== 'removed').length >= 100) {
          setError('当前草稿最多保留 100 张照片，请先完成本批');
          publish();
          return;
        }
        const url = URL.createObjectURL(file);
        s.urls.push(url);
        s.jobs.push({ id: crypto.randomUUID(), key, file, url, status: 'waiting' });
      }
      setError(duplicates ? `${duplicates} 张重复文件未追加` : '');
      publish();
      void run();
    } catch (failure) {
      if (s.alive) setError(failure.message || '图片读取失败，请重新选择');
    } finally {
      if (s.alive) {
        publish();
        void runRef.current();
      }
    }
  };
  return (
    <section className="space-y-2 rounded border border-blue-100 bg-blue-50 p-3">
      <div className="flex flex-wrap gap-2">
        <label className="btn btn-secondary cursor-pointer">
          <ImagePlus className="h-4 w-4" />
          批量图片识别
          <input
            aria-label="选择盒标照片"
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={select}
            disabled={disabled}
          />
        </label>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={disabled}
          onClick={() => {
            pause(!paused);
            if (paused) void run();
          }}
        >
          {paused ? '继续队列' : '暂停队列'}
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={disabled}
          onClick={() => {
            const s = state.current;
            s.generation += 1;
            clearTimeout(s.timer);
            s.controller?.abort();
            s.jobs.forEach(job => {
              if (['waiting', 'processing'].includes(job.status)) job.status = 'removed';
            });
            publish();
          }}
        >
          取消待识别批次
        </button>
      </div>
      <p className="text-xs text-gray-600">
        每批 20 图，单图 10MiB；JPG/PNG/WebP，HEIC
        请转换。大图上传副本自动压缩，保留原图预览。逐张识别，相邻请求至少 6.5
        秒。失败不自动重试；已发送请求可能计费。
      </p>
      <p role="status" className="text-sm">
        已完成 {jobs.filter(job => job.status === 'done').length}，等待{' '}
        {jobs.filter(job => job.status === 'waiting').length}，失败{' '}
        {jobs.filter(job => job.status === 'failed').length}；排队至少约{' '}
        {Math.max(0, jobs.filter(job => job.status === 'waiting').length - 1) * 6.5} 秒
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <ul className="max-h-48 space-y-2 overflow-y-auto">
        {jobs.map(job => (
          <li key={job.id} className="flex flex-wrap items-center gap-2 text-sm">
            <img src={job.url} alt={job.file.name} className="h-10 w-10 rounded object-cover" />
            <span className="min-w-0 flex-1 break-all">
              {job.file.name}：{LABELS[job.status]} {job.error}
            </span>
            {job.status === 'failed' && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={disabled}
                onClick={() => {
                  job.status = 'waiting';
                  job.error = '';
                  publish();
                  void run();
                }}
              >
                重试此图
              </button>
            )}
            {job.status === 'waiting' && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={disabled}
                onClick={() => {
                  job.status = 'removed';
                  publish();
                }}
              >
                移除
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
