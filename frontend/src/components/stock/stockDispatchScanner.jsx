import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus } from 'lucide-react';
import { recognizeStockBox } from '../../api/stockApi';
import { cameraErrorMessage } from '../../utils/pickupBarcode';
import { validateOcrFile } from '../../utils/pickupOcr';
import { StockFeedback } from './StockCommon';

const FRAME_INTERVAL = 6500;
const MAX_FRAMES = 5;

/** 单台盒标自动取帧；停止、离页及切换来源均隔离迟到结果。 */
export default function StockDispatchScanner({ onCandidate, onBusy, disabled }) {
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const video = useRef(null);
  const input = useRef(null);
  const state = useRef({ generation: 0, stream: null, timer: null, controller: null, nextAt: 0 });
  const callbacks = useRef({ onCandidate, onBusy });
  callbacks.current = { onCandidate, onBusy };
  const markBusy = value => {
    setBusy(value);
    callbacks.current.onBusy(value);
  };
  const stop = () => {
    const s = state.current;
    s.generation += 1;
    clearTimeout(s.timer);
    s.stream?.getTracks().forEach(track => track.stop());
    s.stream = null;
    s.controller?.abort();
    if (video.current) video.current.srcObject = null;
    setCamera(false);
    setMessage('已停止识别。');
    markBusy(false);
  };
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
    // 相机生命周期只随组件挂载/卸载变化，回调用 ref 保持最新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (disabled) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);
  const recognize = async (file, generation) => {
    try {
      const s = state.current;
      s.controller = new AbortController();
      s.nextAt = Date.now() + FRAME_INTERVAL;
      const result = await recognizeStockBox(file, [], s.controller.signal);
      if (generation !== s.generation) return null;
      const candidates = result.data.candidates || [];
      if (candidates.length !== 1) throw new Error('请只对准或上传一台设备的完整盒标');
      return candidates[0];
    } catch (failure) {
      if (generation !== state.current.generation) return null;
      throw failure;
    }
  };
  const capture = async (generation, attempt = 0) => {
    try {
      const s = state.current;
      if (generation !== s.generation) return;
      if (!video.current?.videoWidth) {
        if (Date.now() - s.startedAt > 15000)
          throw new Error('未获得可用相机画面，请重新开启或上传照片');
        s.timer = setTimeout(() => void capture(generation, attempt), 300);
        return;
      }
      if (Date.now() < s.nextAt) {
        s.timer = setTimeout(() => void capture(generation, attempt), s.nextAt - Date.now());
        return;
      }
      const canvas = document.createElement('canvas');
      const scale = Math.min(
        1,
        2560 / Math.max(video.current.videoWidth, video.current.videoHeight)
      );
      canvas.width = Math.round(video.current.videoWidth * scale);
      canvas.height = Math.round(video.current.videoHeight * scale);
      canvas.getContext('2d').drawImage(video.current, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (generation !== s.generation) return;
      if (!blob) throw new Error('相机画面不可用，请重新开启或上传照片');
      setMessage(`正在自动识别完整盒标（${attempt + 1}/${MAX_FRAMES}），请保持清晰、稳定…`);
      const candidate = await recognize(
        new File([blob], '盒标.jpg', { type: 'image/jpeg' }),
        generation
      );
      if (generation !== s.generation || !candidate) return;
      const complete =
        candidate.serialNumber && candidate.productId && !candidate.reviewReasons?.length;
      if (complete || attempt + 1 >= MAX_FRAMES) {
        stop();
        setMessage(
          complete ? '识别完成，请核对设备信息。' : '自动识别已停止，请核对或补全识别结果。'
        );
        await callbacks.current.onCandidate(candidate);
      } else {
        setMessage('盒标尚不完整，请将型号、容量、颜色及 SN 一起放入画面，正在自动继续识别…');
        s.timer = setTimeout(
          () => void capture(generation, attempt + 1),
          Math.max(0, s.nextAt - Date.now())
        );
      }
    } catch (failure) {
      if (generation !== state.current.generation) return;
      stop();
      setError(failure.message || '识别失败，请重新开启或上传照片');
    }
  };
  const start = async () => {
    stop();
    const generation = state.current.generation;
    setError('');
    setMessage('请允许使用后置摄像头，并对准一台设备的完整盒标。');
    setCamera(true);
    markBusy(true);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error('实时识别需要 HTTPS 和相机权限，可使用上传照片识别');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
      });
      if (generation !== state.current.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      state.current.stream = stream;
      state.current.startedAt = Date.now();
      video.current.srcObject = stream;
      await video.current.play();
      if (generation !== state.current.generation) return;
      state.current.timer = setTimeout(() => void capture(generation), 1200);
    } catch (failure) {
      if (generation !== state.current.generation) return;
      stop();
      setError(
        failure.name && failure.name !== 'Error' ? cameraErrorMessage(failure) : failure.message
      );
    }
  };
  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    stop();
    const generation = state.current.generation;
    setError('');
    markBusy(true);
    let url;
    try {
      const problem = validateOcrFile(file);
      if (problem) throw new Error(problem);
      if (Date.now() < state.current.nextAt) throw new Error('识别间隔至少 6.5 秒，请稍后重试');
      url = URL.createObjectURL(file);
      const picture = new Image();
      picture.src = url;
      await picture.decode();
      if (generation !== state.current.generation) return;
      if (
        picture.naturalWidth * picture.naturalHeight > 48000000 ||
        Math.min(picture.naturalWidth, picture.naturalHeight) <= 15
      )
        throw new Error('图片尺寸无效，请上传清晰盒标照片');
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 4096 / Math.max(picture.naturalWidth, picture.naturalHeight));
      canvas.width = Math.round(picture.naturalWidth * scale);
      canvas.height = Math.round(picture.naturalHeight * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (generation !== state.current.generation) return;
      if (!blob) throw new Error('图片处理失败');
      setMessage('正在识别盒标…');
      const candidate = await recognize(
        new File([blob], '盒标.jpg', { type: 'image/jpeg' }),
        generation
      );
      if (generation !== state.current.generation || !candidate) return;
      await callbacks.current.onCandidate(candidate);
      setMessage('识别完成，请核对设备信息。');
    } catch (failure) {
      if (generation === state.current.generation) setError(failure.message || '图片识别失败');
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (generation === state.current.generation) markBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-blue-100 bg-blue-50 p-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={camera ? stop : start}
          disabled={disabled || (busy && !camera)}
        >
          <Camera className="h-4 w-4" />
          {camera ? '停止实时识别' : '开启实时识别'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => input.current.click()}
          disabled={disabled || (busy && !camera)}
        >
          <ImagePlus className="h-4 w-4" />
          上传照片识别
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          aria-label="上传盒标照片"
          onChange={upload}
        />
      </div>
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className={camera ? 'max-h-64 w-full rounded bg-gray-100' : 'hidden'}
        aria-label="实时盒标识别画面"
      />
      <p className="text-xs text-gray-600" role="status">
        {message || '一次识别一台；相机自动识别 SN 和完整规格，无需点击拍照。'}
      </p>
      <StockFeedback error={error} />
    </div>
  );
}
