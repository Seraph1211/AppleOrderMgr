import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Plus } from 'lucide-react';
import PickupSerialOcr from '../PickupSerialOcr';
import { recognizeStockSerial } from '../../api/stockApi';
import { parseSerialBarcode, cameraErrorMessage } from '../../utils/pickupBarcode';
import { StockFeedback } from './StockCommon';

/** 复用条码解析与 OCR，识别只添加候选，不产生入库或出货。 */
export default function StockSerialInput({ onSerials, disabled = false, hideOcr = false }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [camera, setCamera] = useState(false);
  const [ocr, setOcr] = useState(false);
  const video = useRef(null);
  const stream = useRef(null);
  const controls = useRef(null);
  const generation = useRef(0);
  const onSerialsRef = useRef(onSerials);
  onSerialsRef.current = onSerials;
  const stop = useCallback(() => {
    generation.current += 1;
    controls.current?.stop();
    controls.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setCamera(false);
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [stop]);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);
  const accept = async serials => {
    try {
      const result = await onSerialsRef.current(serials);
      setNotice(
        result?.duplicates
          ? `已加入 ${result.added} 台，另有 ${result.duplicates} 台已在清单内，未重复添加。`
          : `已加入 ${serials.length} 台待确认清单。`
      );
      setValue('');
      setError('');
      return [];
    } catch (failure) {
      setError(failure.message);
      return serials.map(serial => ({ serial, message: failure.message }));
    }
  };
  const add = async () => {
    try {
      const serial = parseSerialBarcode(value);
      if (!serial) throw new Error('请输入含字母的 10 或 12 位 SN，可直接使用扫描枪');
      await accept([serial]);
    } catch (failure) {
      setError(failure.message);
    }
  };
  const start = async () => {
    stop();
    setError('');
    const current = generation.current;
    setCamera(true);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error('浏览器需要 HTTPS 才能使用相机，可先手工输入或扫描枪录入');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (current !== generation.current) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = media;
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      if (current !== generation.current) return;
      const reader = new BrowserMultiFormatReader(
        new Map([
          [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]],
          [DecodeHintType.TRY_HARDER, true],
        ])
      );
      let previous = '';
      let hits = 0;
      const control = await reader.decodeFromStream(media, video.current, result => {
        if (!result || current !== generation.current) return;
        const serial = parseSerialBarcode(result.getText());
        if (!serial) return;
        hits = serial === previous ? hits + 1 : 1;
        previous = serial;
        if (hits < 2) return;
        stop();
        void accept([serial]);
      });
      if (current !== generation.current) control.stop();
      else controls.current = control;
    } catch (failure) {
      if (current === generation.current) {
        stop();
        setError(
          failure.name && failure.name !== 'Error' ? cameraErrorMessage(failure) : failure.message
        );
      }
    }
  };
  if (ocr)
    return (
      <PickupSerialOcr
        recognizeSerial={recognizeStockSerial}
        confirmLabel="加入清单"
        contextLabel="核对后加入当前操作清单，最终保存前不会改变库存。"
        onConfirm={async serials => {
          try {
            const failures = await accept(serials);
            if (!failures.length) setOcr(false);
            return failures;
          } catch (failure) {
            return serials.map(serial => ({
              serial,
              message: failure.message,
            }));
          }
        }}
        onCancel={() => setOcr(false)}
      />
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="扫描或输入 SN"
          className="input min-w-0 flex-1 font-mono"
          placeholder="扫描或输入 SN"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={event => setValue(event.target.value.toUpperCase())}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={add}
          disabled={disabled || !value.trim()}
        >
          <Plus className="h-4 w-4" />
          加入
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={camera ? stop : start}
          disabled={disabled}
        >
          <Camera className="h-4 w-4" />
          {camera ? '关闭相机' : '相机扫码'}
        </button>
        {!hideOcr && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              stop();
              setOcr(true);
            }}
            disabled={disabled}
          >
            <ImagePlus className="h-4 w-4" />
            图片识别
          </button>
        )}
      </div>
      <video
        ref={video}
        playsInline
        autoPlay
        muted
        aria-label="库存 SN 扫码相机"
        className={camera ? 'max-h-64 w-full rounded border bg-gray-100' : 'hidden'}
      />
      <StockFeedback error={error} />
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
    </div>
  );
}
