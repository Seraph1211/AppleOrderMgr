import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import { normalizeOcrSerial, validateOcrFile } from '../utils/pickupOcr';

import { recognizePickupSerial } from '../api/pickupsApi';

/** 拍照或选择图片后通过阿里云 OCR；候选必须经用户核对，不自动绑定。 */
export default function PickupSerialOcr({ orderId, orderNumber, onConfirm, onCancel }) {
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [binding, setBinding] = useState(false);
  const bindingRef = useRef(false);
  const rowIdRef = useRef(0);
  const [reviewReady, setReviewReady] = useState(false);
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const activeRef = useRef(null);
  const previewRef = useRef('');

  const stopJob = () => {
    const job = activeRef.current;
    activeRef.current = null;
    if (job) {
      job.cancelled = true;
      clearTimeout(job.timer);
      job.controller.abort();
    }
  };
  useEffect(
    () => () => {
      stopJob();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    []
  );

  const recognize = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || bindingRef.current) return;
    stopJob();
    setBusy(false);
    setRows([{ id: rowIdRef.current++, serial: '', error: '' }]);
    setReviewReady(false);
    setError('');
    setProgress('');
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
    setPreview('');
    const invalid = validateOcrFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreview(url);
    const job = {
      cancelled: false,
      controller: new AbortController(),
      timer: null,
    };
    activeRef.current = job;
    setBusy(true);
    setProgress('正在准备图片…');
    job.timer = setTimeout(() => {
      if (activeRef.current !== job) return;
      stopJob();
      setBusy(false);
      setProgress('');
      setError('识别超时，请重拍清晰的 Serial No. 一行，或核对图片后手动填写。');
      setReviewReady(true);
    }, 45000);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (job.cancelled) return;
      if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 48000000)
        throw new Error('图片尺寸过大，请裁剪至包装盒标签后重试。');
      if (
        img.naturalWidth >= 8192 ||
        img.naturalHeight >= 8192 ||
        Math.min(img.naturalWidth, img.naturalHeight) <= 15
      )
        throw new Error('图片尺寸过大或过小，请裁剪至清晰的包装盒标签后重试。');
      setProgress('阿里云正在识别，请稍候…');
      const result = await recognizePickupSerial(orderId, file, job.controller.signal);
      if (job.cancelled) return;
      const values = result.data.candidates;
      setRows(
        (values.length ? [...new Set(values)] : ['']).map(serial => ({
          id: rowIdRef.current++,
          serial,
          error: '',
        }))
      );
      setReviewReady(true);
      setProgress(
        values.length
          ? '请对照图片核对序列号，尤其是 O/0、I/1、S/5。'
          : '未找到明确序列号，请重拍标签，或对照图片手动填写。'
      );
    } catch (failure) {
      if (!job.cancelled) {
        setProgress('');
        setError(failure?.message || '图片识别失败，请重试，或对照图片手动填写。');
        setReviewReady(true);
      }
    } finally {
      clearTimeout(job.timer);
      if (activeRef.current === job) {
        activeRef.current = null;
        setBusy(false);
      }
    }
  };

  const normalized = rows.map(row => normalizeOcrSerial(row.serial));
  const duplicate = normalized.some((value, index) => value && normalized.indexOf(value) !== index);
  const canConfirm = rows.length > 0 && normalized.every(Boolean) && !duplicate;

  const confirmRows = async () => {
    if (!canConfirm || bindingRef.current) return;
    bindingRef.current = true;
    setBinding(true);
    setError('');
    setProgress('正在绑定，请勿关闭页面…');
    try {
      const failures = await onConfirm(normalized);
      setRows(
        rows.flatMap((row, index) => {
          const failure = failures.find(item => item.serial === normalized[index]);
          return failure ? [{ ...row, serial: normalized[index], error: failure.message }] : [];
        })
      );
      if (failures.length) {
        setProgress(
          `本次已确认 ${rows.length - failures.length} 台，剩余 ${failures.length} 台未确认绑定。`
        );
      }
    } catch (failure) {
      setProgress('');
      setError(failure.message || '绑定未确认，请重试；重复提交不会重复登记。');
    } finally {
      bindingRef.current = false;
      setBinding(false);
    }
  };

  return (
    <section aria-label="图片文字识别" className="space-y-3 rounded-lg border p-3">
      <p className="text-sm text-gray-600">
        确保每个盒子的 Serial No.
        文字清晰可见，保持水平并避开反光。图片会发送至阿里云进行文字识别，不保存为取货凭证。每月最多
        1000 次，请勿重复提交。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-secondary min-h-[44px]"
          disabled={busy || binding}
          onClick={() => cameraRef.current?.click()}
        >
          <Camera className="h-4 w-4" />
          拍照识别
        </button>
        <button
          className="btn btn-secondary min-h-[44px]"
          disabled={busy || binding}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus className="h-4 w-4" />
          选择图片
        </button>
      </div>
      <input
        ref={cameraRef}
        aria-label="拍摄序列号图片"
        className="hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={recognize}
      />
      <input
        ref={fileRef}
        aria-label="选择序列号图片"
        className="hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={recognize}
      />
      {preview && (
        <img
          src={preview}
          alt="待核对的序列号原图"
          className="max-h-64 w-full rounded border object-contain"
        />
      )}
      {progress && (
        <p role="status" className="text-sm text-primary">
          {progress}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {reviewReady && !busy && (
        <>
          <p className="text-sm font-medium text-gray-900">待绑定 {rows.length} 台</p>
          <p className="text-sm text-gray-600">请核对全部序列号，可修改或删除不需要绑定的项目。</p>
          {rows.length ? (
            <table className="w-full table-fixed text-left text-sm" aria-label="待绑定序列号">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="p-2">Serial No.</th>
                  <th className="w-16 p-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-2 pr-2">
                      <input
                        aria-label={`核对 Serial No. ${index + 1}`}
                        className="input min-h-[44px] min-w-0 w-full font-mono text-base"
                        value={row.serial}
                        disabled={binding}
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={32}
                        onChange={event =>
                          setRows(previous =>
                            previous.map(item =>
                              item.id === row.id
                                ? {
                                    ...item,
                                    serial: event.target.value.toUpperCase(),
                                    error: '',
                                  }
                                : item
                            )
                          )
                        }
                      />
                      {row.error && (
                        <p role="alert" className="mt-1 break-words text-red-600">
                          {row.error}
                        </p>
                      )}
                      {row.serial && !normalized[index] && (
                        <p className="mt-1 text-red-600">请输入含字母的 10 或 12 位序列号</p>
                      )}
                    </td>
                    <td className="py-2 text-right align-top">
                      <button
                        className="btn btn-secondary min-h-[44px] min-w-[44px] px-2"
                        aria-label={`删除序列号 ${index + 1}`}
                        disabled={binding}
                        onClick={() =>
                          setRows(previous => previous.filter(item => item.id !== row.id))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-gray-500">没有待绑定的序列号，可重新识别或手动添加。</p>
          )}
          {duplicate && (
            <p role="alert" className="text-sm text-red-600">
              序列号重复，请删除或修改重复项。
            </p>
          )}
          <button
            className="btn btn-secondary min-h-[44px]"
            disabled={binding || rows.length >= 20}
            onClick={() =>
              setRows(previous => [...previous, { id: rowIdRef.current++, serial: '', error: '' }])
            }
          >
            手动添加序列号
          </button>
          <p className="break-all text-sm text-gray-600">
            确认后将以上 {rows.length} 台设备绑定订单 {orderNumber}。
          </p>
          <button
            className="btn btn-primary min-h-[44px] w-full"
            disabled={!canConfirm || binding}
            onClick={confirmRows}
          >
            {binding ? '正在绑定…' : `确认绑定 ${rows.length} 台`}
          </button>
        </>
      )}
      <button
        className="btn btn-secondary min-h-[44px] w-full"
        disabled={binding}
        onClick={() => {
          stopJob();
          onCancel();
        }}
      >
        {busy ? '取消识别' : '返回条码扫描'}
      </button>
    </section>
  );
}
