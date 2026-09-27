import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, RotateCcw, X } from 'lucide-react';
import { getPickupDevices, bindPickupDevice, unbindPickupDevice } from '../api/pickupsApi';
import { parseSerialBarcode, cameraErrorMessage } from '../utils/pickupBarcode';

import PickupSerialOcr from './PickupSerialOcr';

/** 当前订单的逐台扫码窗口；序列号连续识别一致后自动绑定。 */
export default function PickupDeviceScanner({ order, canEdit, onClose, onSaved }) {
  const [ocrOpen, setOcrOpen] = useState(false);
  const [devices, setDevices] = useState([]);
  const [removing, setRemoving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [phase, setPhase] = useState('idle');
  const [scanData, setScanData] = useState({ serialBarcode: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const controlsRef = useRef(null);
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const stopCamera = useCallback(() => {
    runRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (mountedRef.current) {
      setScanning(false);
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const visibility = () => {
      if (document.hidden) {
        stopCamera();
        setNotice('相机已暂停，返回页面后可继续扫描。');
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mountedRef.current = false;
      stopCamera();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [stopCamera]);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await getPickupDevices(order.orderId);
      if (mountedRef.current) setDevices(response.data.items);
    } catch (failure) {
      if (mountedRef.current) setLoadError(failure.message || '设备列表加载失败，请重试');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [order.orderId]);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const saveDevice = async values => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopCamera();
    setPhase('saving');
    setError('');
    setNotice('正在绑定当前订单，请稍候…');
    try {
      const response = await bindPickupDevice(order.orderId, values);
      if (!mountedRef.current) return;
      const { device, alreadyBound } = response.data;
      setDevices(previous => [...previous.filter(item => item.id !== device.id), device]);
      setPhase('saved');
      setNotice(alreadyBound ? '该设备已绑定本订单，无需重复登记。' : '设备已成功绑定当前订单。');
      onSaved();
    } catch (failure) {
      if (mountedRef.current) {
        setPhase('saveFailed');
        setNotice('');
        setError(failure.message || '保存未确认，请重试；重复提交不会重复登记。');
      }
    } finally {
      busyRef.current = false;
    }
  };

  const saveOcrDevices = async serials => {
    if (busyRef.current) throw new Error('正在保存，请稍后重试。');
    busyRef.current = true;
    stopCamera();
    setPhase('saving');
    setError('');
    setNotice('');
    const failures = [];
    let saved = 0;
    try {
      for (const serial of serials) {
        if (!mountedRef.current) break;
        try {
          const response = await bindPickupDevice(order.orderId, {
            serialBarcode: serial,
          });
          const { device } = response.data;
          saved += 1;
          if (mountedRef.current) {
            setDevices(previous => [...previous.filter(item => item.id !== device.id), device]);
          }
        } catch (failure) {
          failures.push({
            serial,
            message: failure.message || '保存未确认，请重试；重复提交不会重复登记。',
          });
        }
      }
      if (mountedRef.current) {
        setPhase(failures.length ? 'idle' : 'saved');
        if (!failures.length) {
          setOcrOpen(false);
          setNotice(`已确认 ${saved} 台设备绑定当前订单。`);
        }
        if (saved) onSaved();
      }
      return failures;
    } catch (failure) {
      if (mountedRef.current) setPhase('idle');
      throw failure;
    } finally {
      busyRef.current = false;
    }
  };

  const removeDevice = async () => {
    if (!removeTarget || busyRef.current) return;
    busyRef.current = true;
    setRemoving(true);
    setError('');
    try {
      await unbindPickupDevice(order.orderId, removeTarget.id);
      if (!mountedRef.current) return;
      setDevices(previous => previous.filter(device => device.id !== removeTarget.id));
      setRemoveTarget(null);
      setScanData({ serialBarcode: '' });
      setPhase('idle');
      setNotice('已解除绑定，可在正确订单重新扫码登记。');
      onSaved();
    } catch (failure) {
      if (mountedRef.current) setError(failure.message || '解除未确认，请重试。');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setRemoving(false);
    }
  };

  const startCamera = async () => {
    stopCamera();
    const run = runRef.current;
    setStarting(true);
    setPhase('serial');
    setError('');
    setNotice('正在启动相机…');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice('');
      setError('当前浏览器无法调用相机，请通过 HTTPS 地址在 Safari / Chrome 中打开本网站。');
      setStarting(false);
      return;
    }
    let stream;
    try {
      // 先申请相机，避免库下载时间影响手机浏览器的手势授权。
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (run !== runRef.current || !mountedRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      if (run !== runRef.current || !mountedRef.current) return;
      const hints = new Map([
        [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]],
        [DecodeHintType.TRY_HARDER, true],
      ]);
      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 160,
        delayBetweenScanSuccess: 160,
      });
      let previous = '';
      let hits = 0;
      let lastHit = 0;
      const controls = await reader.decodeFromStream(stream, videoRef.current, result => {
        if (!result || run !== runRef.current || !mountedRef.current) return;
        const raw = result.getText().trim();
        const parsed = parseSerialBarcode(raw);
        if (!parsed) {
          previous = '';
          hits = 0;
          setNotice('请对准 (S) Serial No. 对应条码。');
          return;
        }
        const now = Date.now();
        hits = previous === raw && now - lastHit < 1800 ? hits + 1 : 1;
        previous = raw;
        lastHit = now;
        if (hits < 2) return;
        stopCamera();
        const values = { serialBarcode: raw };
        setScanData(values);
        void saveDevice(values);
      });
      if (run !== runRef.current || !mountedRef.current) {
        controls.stop();
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      controlsRef.current = controls;
      setStarting(false);
      setScanning(true);
      setNotice('将 Serial No. 条码放在画面中央，保持清晰。');
    } catch (failure) {
      stream?.getTracks().forEach(track => track.stop());
      if (run === runRef.current && mountedRef.current) {
        stopCamera();
        setNotice('');
        setError(cameraErrorMessage(failure));
      }
    }
  };

  useEffect(() => {
    if (!scanning) return undefined;
    const timer = window.setTimeout(
      () => setNotice('暂未识别：请靠近标签、避开反光，并让目标条码完整清晰地进入画面。'),
      15000
    );
    return () => window.clearTimeout(timer);
  }, [scanning]);

  const reset = () => {
    stopCamera();
    setScanData({ serialBarcode: '' });
    setPhase('idle');
    setError('');
    setNotice('');
  };
  const close = () => {
    stopCamera();
    onClose();
  };
  const saving = phase === 'saving' || removing;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-device-title"
        className="flex h-[100dvh] w-full min-w-0 flex-col bg-white sm:max-h-[92dvh] sm:max-w-xl sm:rounded-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b p-4">
          <h2 id="pickup-device-title" className="font-semibold text-gray-900">
            设备扫码登记
          </h2>
          <button
            className="btn btn-secondary min-h-[44px]"
            aria-label="关闭设备扫码"
            onClick={close}
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="break-words rounded-lg bg-primary-50 p-3 text-sm text-gray-700">
            <p className="font-semibold text-primary">
              {order.recipientName || '取机人未填写'} · 尾号 {order.orderNumber?.slice(-4)}
            </p>
            <p className="mt-1">
              {order.orderNumber} · #{order.orderId}
            </p>
            <p className="mt-1">
              {(order.products || [])
                .map(item => `${item.name || item.model || '商品'} ×${item.quantity ?? '-'}`)
                .join('、')}
            </p>
          </div>
          {canEdit && !ocrOpen && (
            <>
              <p className="text-sm text-gray-600">
                一次扫描一个盒子的 Serial No. 条码，识别成功后自动保存到此订单。
              </p>
              <div
                className={`relative overflow-hidden rounded-lg border bg-gray-100 ${scanning || starting ? '' : 'hidden'}`}
              >
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  className="aspect-[4/3] w-full object-cover"
                  aria-label="包装盒条码相机画面"
                />
                {!scanning && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-500">
                    {saving ? '正在保存…' : '点击下方按钮开始扫描'}
                  </div>
                )}
              </div>
              <dl className="space-y-2 rounded-lg border p-3 text-sm">
                <div>
                  <dt className="text-gray-500">Serial No.</dt>
                  <dd className="break-all font-mono text-gray-900">
                    {parseSerialBarcode(scanData.serialBarcode) || '待扫描'}
                  </dd>
                </div>
              </dl>
            </>
          )}
          {canEdit && ocrOpen && (
            <PickupSerialOcr
              orderId={order.orderId}
              orderNumber={order.orderNumber}
              onCancel={() => setOcrOpen(false)}
              onConfirm={saveOcrDevices}
            />
          )}
          {removeTarget && (
            <div
              role="alertdialog"
              aria-label="确认解除设备绑定"
              className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
            >
              <p>确认解除订单 {order.orderNumber} 的设备绑定？</p>
              <p className="break-all font-mono font-semibold">
                Serial No. {removeTarget.serialNumber}
              </p>
              <p>将保留操作历史，解除后可在正确订单重新扫码。</p>
              <div className="flex gap-2">
                <button
                  className="btn btn-secondary min-h-[44px]"
                  disabled={removing}
                  onClick={() => setRemoveTarget(null)}
                >
                  取消
                </button>
                <button
                  className="btn btn-primary min-h-[44px]"
                  disabled={removing}
                  onClick={removeDevice}
                >
                  {removing ? '正在解除…' : '确认解除绑定'}
                </button>
              </div>
            </div>
          )}
          {notice && (
            <p role="status" className="text-sm text-primary">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-gray-500">正在加载已登记设备…</p>
          ) : loadError ? (
            <div>
              <p role="alert" className="text-sm text-red-600">
                {loadError}
              </p>
              <button className="btn btn-secondary mt-2" onClick={loadDevices}>
                重新加载
              </button>
            </div>
          ) : (
            <>
              <h3 className="text-sm font-semibold">已登记 {devices.length} 台</h3>
              {!devices.length ? (
                <p className="text-sm text-gray-500">此订单尚未登记设备。</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 text-gray-500">
                      <tr>
                        <th className="p-2">Serial No.</th>
                        {canEdit && <th className="p-2">操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map(device => (
                        <tr key={device.id} className="border-t">
                          <td className="break-all p-2 font-mono">{device.serialNumber}</td>
                          {canEdit && (
                            <td className="p-2">
                              <button
                                className="btn btn-secondary min-h-[44px] whitespace-nowrap"
                                disabled={saving || ocrOpen || Boolean(removeTarget)}
                                onClick={() => {
                                  stopCamera();
                                  setRemoveTarget(device);
                                  setError('');
                                  setNotice('');
                                }}
                              >
                                解除绑定
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        {canEdit && !removeTarget && !ocrOpen && (
          <footer className="shrink-0 space-y-2 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {['idle', 'serial', 'saved'].includes(phase) && (
              <button
                className="btn btn-primary min-h-[44px] w-full"
                disabled={loading || Boolean(loadError) || scanning || starting}
                onClick={() => {
                  setScanData({ serialBarcode: '' });
                  void startCamera();
                }}
              >
                <Camera className="h-4 w-4" />
                {phase === 'saved' ? '扫描下一台' : '扫描 Serial No.'}
              </button>
            )}
            {['idle', 'serial', 'saved'].includes(phase) && (
              <button
                className="btn btn-secondary min-h-[44px] w-full"
                disabled={loading || Boolean(loadError)}
                onClick={() => {
                  stopCamera();
                  setPhase('idle');
                  setError('');
                  setNotice('');
                  setOcrOpen(true);
                }}
              >
                <ImagePlus className="h-4 w-4" />
                拍照 / 图片识别 Serial No.
              </button>
            )}
            {phase === 'saveFailed' && (
              <button
                className="btn btn-primary min-h-[44px] w-full"
                onClick={() => saveDevice(scanData)}
              >
                重试保存本台设备
              </button>
            )}
            {saving && (
              <button className="btn btn-primary min-h-[44px] w-full" disabled>
                正在绑定订单…
              </button>
            )}
            {!['idle', 'saved', 'saving'].includes(phase) && (
              <button className="btn btn-secondary min-h-[44px] w-full" onClick={reset}>
                <RotateCcw className="h-4 w-4" />
                重扫本台设备
              </button>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}
