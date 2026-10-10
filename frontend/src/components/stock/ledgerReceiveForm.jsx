import { useEffect, useRef, useState } from 'react';
import { stockGet } from '../../api/stockApi';
import { useAuth } from '../../contexts/AuthContext';
import { parseSerialBarcode } from '../../utils/pickupBarcode';
import { StockFeedback, StockFields, StockModal } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { productLabel, stockOptions } from './stockHelpers';
import { ledgerToday } from './ledgerHelpers';
import StockDispatchScanner from './stockDispatchScanner';

/** 单台入库：识别与查询只生成草稿，核对确认后才提交库存事务。 */
export default function LedgerReceiveForm({
  catalog,
  initialSerials = [],
  initialProductId = '',
  onClose,
  onSaved,
}) {
  const { can } = useAuth();
  const command = useStockCommand();
  const canLinkOrder = can('stock.source.link') && can('orders.read');
  const initialSerial = initialSerials.length === 1 ? initialSerials[0] : '';
  const [serial, setSerial] = useState(initialSerial);
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [candidate, setCandidate] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [edited, setEdited] = useState(false);
  const [value, setValue] = useState({
    productId: initialProductId,
    warehouseId: '',
    receivedOn: ledgerToday(),
    orderNumber: '',
  });
  const pending = useRef({ generation: 0, controller: null });
  const lookupRef = useRef(null);
  const products = catalog.products.filter(product => product.entryEligible);
  const busy = command.busy || checking || scanning;
  const existingProduct = preview?.unit?.product;
  const productConflict = Boolean(existingProduct?.id && value.productId !== existingProduct.id);
  const eligibleProduct = products.some(product => product.id === value.productId);
  const ready = Boolean(preview?.canReceive && preview.serialNumber === serial);
  const invalidate = () => {
    pending.current.generation += 1;
    pending.current.controller?.abort();
    setChecking(false);
    setPreview(null);
    setConfirmed(false);
    setError('');
    command.setError('');
  };
  const lookup = async (raw, recognized = null) => {
    invalidate();
    const generation = pending.current.generation;
    try {
      const serialNumber = parseSerialBarcode(raw);
      if (!serialNumber) throw new Error('请输入有效的 10 或 12 位 SN，不能填写 IMEI');
      setSerial(serialNumber);
      setChecking(true);
      const controller = new AbortController();
      pending.current.controller = controller;
      const result = await stockGet('/ledger/receive-preview', { serialNumber }, controller.signal);
      if (generation !== pending.current.generation) return;
      if (!result.canReceive) throw new Error('此设备当前不能入库，请查看原记录核对状态');
      setPreview({ ...result, serialNumber });
      setValue(current => ({
        ...current,
        productId: recognized?.productId || result.unit?.product?.id || current.productId,
        // 识别不改变操作人员选择的仓库、日期或待填订单。
      }));
    } catch (failure) {
      if (generation === pending.current.generation) setError(failure.message || '设备查询失败');
    } finally {
      if (generation === pending.current.generation) setChecking(false);
    }
  };
  lookupRef.current = lookup;
  useEffect(() => {
    const request = pending.current;
    if (initialSerial) void lookupRef.current(initialSerial);
    return () => {
      request.generation += 1;
      request.controller?.abort();
    };
    // 初始单个 SN 只在打开表单时查询；用户输入不会触发隐式查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const candidateReceived = async next => {
    try {
      setCandidate(next);
      setEdited(true);
      setConfirmed(false);
      setSerial(next.serialNumber || '');
      setValue(current => ({ ...current, productId: next.productId || '' }));
      if (next.serialNumber) await lookup(next.serialNumber, next);
      else {
        invalidate();
        setError('未识别出唯一 SN，请对照照片补充 SN 后查询设备');
      }
    } catch (failure) {
      setError(failure.message || '识别结果未能应用，请手工核对');
    }
  };
  const changeValue = next => {
    setValue(next);
    setEdited(true);
    setConfirmed(false);
    command.setError('');
  };
  const close = () => {
    if (
      (edited || serial || scanning || candidate) &&
      !window.confirm('入库登记尚未保存，确定关闭？')
    )
      return;
    onClose();
  };
  const submit = async event => {
    event.preventDefault();
    try {
      if (busy || !ready) return;
      if (!confirmed) throw new Error('请核对并确认 SN、规格和入库信息');
      if (!eligibleProduct) throw new Error('请选择本期支持的 iPhone 18 Pro Max 规格');
      if (productConflict) throw new Error('设备规格与已有记录不一致，请核对后再入库');
      const unit = {
        serialNumber: preview.serialNumber,
        expectedVersion: preview.unit?.version ?? null,
        productId: value.productId,
        warehouseId: value.warehouseId,
        receivedOn: value.receivedOn,
        ...(!preview.unit?.orderLinked && canLinkOrder && value.orderNumber.trim()
          ? { orderNumber: value.orderNumber.trim() }
          : {}),
      };
      const result = await command.execute('POST', '/ledger/receive', { units: [unit] });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message || '入库未确认，请核对后重试');
    }
  };
  return (
    <StockModal title="入库登记" onClose={close} busy={command.busy}>
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-gray-500">
          每次登记一台。识别盒标或手工填写 SN，核对型号、容量和颜色后确认入库。
        </p>
        {initialSerials.length > 1 && (
          <p className="text-sm text-amber-700">每次登记一台，请输入本次要登记的 SN。</p>
        )}
        <StockDispatchScanner
          onCandidate={candidateReceived}
          onBusy={active => {
            setScanning(active);
            if (active) {
              setConfirmed(false);
              setEdited(true);
            }
          }}
          disabled={command.busy || checking}
        />
        {candidate?.previewUrl && (
          <figure className="space-y-2">
            <img
              src={candidate.previewUrl}
              alt="本次盒标照片"
              className="max-h-64 w-full rounded-lg border border-gray-200 object-contain"
            />
            <figcaption className="text-xs text-gray-500">
              请对照照片逐字核对 SN 和规格。
            </figcaption>
          </figure>
        )}
        {!!candidate?.reviewReasons?.length && (
          <p className="text-sm text-amber-700">识别需核对：{candidate.reviewReasons.join('；')}</p>
        )}
        {candidate?.serialNumber && serial && candidate.serialNumber !== serial && (
          <p className="text-sm text-amber-700">
            当前 SN 与识别结果不同，请对照照片确认手工修正内容。
          </p>
        )}
        {candidate?.productId && value.productId && candidate.productId !== value.productId && (
          <p className="text-sm text-amber-700">当前规格与识别结果不同，请核对型号、容量和颜色。</p>
        )}
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-medium text-gray-700">
            序列号（SN）
            <input
              aria-label="序列号（SN）"
              className="input mt-1 font-mono"
              value={serial}
              required
              disabled={busy}
              maxLength={32}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={event => {
                invalidate();
                setSerial(event.target.value.toUpperCase());
                setEdited(true);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !busy) {
                  event.preventDefault();
                  void lookup(serial);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !serial}
            onClick={() => void lookup(serial)}
          >
            查询设备
          </button>
        </div>
        <StockFeedback loading={checking} error={error} />
        {ready && (
          <p
            role="status"
            className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-primary"
          >
            {preview.unit
              ? '已匹配未入库设备，确认后登记至所选仓库。'
              : '这是新设备，确认后创建入库记录。'}
          </p>
        )}
        <StockFields
          value={value}
          onChange={changeValue}
          disabled={busy}
          fields={[
            {
              key: 'productId',
              label: '机器型号 / 容量 / 颜色',
              type: 'select',
              required: true,
              options: stockOptions(products, productLabel),
            },
            {
              key: 'warehouseId',
              label: '入库仓库',
              type: 'select',
              required: true,
              options: stockOptions(catalog.warehouses),
            },
            { key: 'receivedOn', label: '入库日期', type: 'date', required: true },
            {
              key: 'orderNumber',
              label: '订单号（可选）',
              placeholder: '填写苹果订单号',
              hidden: !canLinkOrder || Boolean(preview?.unit?.orderLinked),
            },
          ]}
        />
        {preview?.unit?.orderLinked && (
          <p className="text-sm text-gray-600">
            已关联订单：{preview.unit.orderNumber || '已关联（无订单查看权限）'}；保留原关联。
          </p>
        )}
        {productConflict && (
          <StockFeedback
            error={`设备规格与已有记录不一致，原记录为 ${productLabel(existingProduct)}。请核对盒标；原记录有误时先更正资料。`}
          />
        )}
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={confirmed}
            disabled={busy || !ready || !eligibleProduct || productConflict}
            required
            onChange={event => setConfirmed(event.target.checked)}
          />
          已核对 SN、型号、容量、颜色、仓库和入库日期，确认与实物一致
        </label>
        <StockFeedback error={command.error} />
        <div className="ledger-form-actions flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={close}
            disabled={command.busy}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !ready || !confirmed || !eligibleProduct || productConflict}
          >
            确认入库 1 台
          </button>
        </div>
      </form>
    </StockModal>
  );
}
