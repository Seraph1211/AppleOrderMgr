import { useEffect, useRef, useState } from 'react';
import { stockGet } from '../../api/stockApi';
import { useAuth } from '../../contexts/AuthContext';
import { parseSerialBarcode } from '../../utils/pickupBarcode';
import { StockFeedback, StockFields, StockModal } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { moneyValue, productLabel, stockOptions } from './stockHelpers';
import { ledgerAmount, ledgerPayment, ledgerToday } from './ledgerHelpers';
import { LedgerActions, LedgerPaymentFields, LedgerPeopleFields } from './ledgerFields';
import StockDispatchScanner from './stockDispatchScanner';

/** 单台出库表单：识别只生成草稿，确认后原子入库及售出。 */
export default function LedgerDispatchForm({ catalog, onClose, onSaved }) {
  const { can } = useAuth();
  const command = useStockCommand();
  const [serial, setSerial] = useState('');
  const [preview, setPreview] = useState(null);
  const [checking, setChecking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [reviewReasons, setReviewReasons] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [costEdited, setCostEdited] = useState(false);
  const [receivedEdited, setReceivedEdited] = useState(false);
  const [value, setValue] = useState({
    productId: '',
    warehouseId: '',
    receivedOn: ledgerToday(),
    soldOn: ledgerToday(),
    officialCostAmount: '',
    saleAmount: '',
    settlementAmount: '',
    extraExpenseAmount: '',
    salespersonName: '',
    handlerName: '',
    notes: '',
  });
  const [payment, setPayment] = useState({
    status: '',
    collectorName: '',
    collectedOn: '',
    receivedOn: ledgerToday(),
  });
  const pending = useRef({ generation: 0, controller: null });
  useEffect(
    () => () => {
      pending.current.generation += 1;
      pending.current.controller?.abort();
    },
    []
  );
  const products = catalog.products.filter(product => product.entryEligible);
  const busy = command.busy || checking || scanning;
  const invalidate = () => {
    pending.current.generation += 1;
    pending.current.controller?.abort();
    setPreview(null);
    setChecking(false);
    setConfirmed(false);
    setCostEdited(false);
    setError('');
  };
  const lookup = async (raw, candidate = null) => {
    invalidate();
    const generation = pending.current.generation;
    try {
      const serialNumber = parseSerialBarcode(raw);
      if (!serialNumber) throw new Error('请输入有效的 10 或 12 位 SN');
      setSerial(serialNumber);
      setChecking(true);
      pending.current.controller = new AbortController();
      const result = await stockGet(
        '/ledger/dispatch-preview',
        { serialNumber },
        pending.current.controller.signal
      );
      if (generation !== pending.current.generation) return;
      const existing = result.unit;
      if (
        candidate?.productId &&
        existing?.product?.id &&
        candidate.productId !== existing.product.id
      )
        throw new Error('盒标规格与库存记录不一致，请核对盒标或先更正库存资料');
      const productId = existing?.product?.id || candidate?.productId || '';
      if (productId && !products.some(product => product.id === productId))
        throw new Error('本期只支持预置 iPhone 18 Pro Max 规格');
      const product = products.find(product => product.id === productId);
      setPreview({ ...result, serialNumber });
      setValue(current => ({
        ...current,
        productId,
        officialCostAmount:
          existing?.officialCostAmount ??
          (result.needsReceive ? product?.fixedCostAmount : '') ??
          '',
        warehouseId: existing?.warehouse?.id || '',
        receivedOn: result.needsReceive
          ? receivedEdited
            ? current.receivedOn
            : current.soldOn
          : existing.receivedOn,
      }));
    } catch (failure) {
      if (generation === pending.current.generation) setError(failure.message);
    } finally {
      if (generation === pending.current.generation) setChecking(false);
    }
  };
  const candidateReceived = async candidate => {
    try {
      setReviewReasons(candidate.reviewReasons || []);
      setConfirmed(false);
      setSerial(candidate.serialNumber || '');
      if (candidate.serialNumber) await lookup(candidate.serialNumber, candidate);
      else {
        invalidate();
        setValue(current => ({ ...current, productId: candidate.productId || '' }));
        setError('未识别出唯一 SN，请核对盒标后手工填写并查询');
      }
    } catch (failure) {
      setError(failure.message);
    }
  };
  const changeValue = next => {
    if (next.officialCostAmount !== value.officialCostAmount) setCostEdited(true);
    if (next.receivedOn !== value.receivedOn) setReceivedEdited(true);
    if (next.soldOn !== value.soldOn && !receivedEdited && preview?.needsReceive)
      next = { ...next, receivedOn: next.soldOn };
    if (next.productId !== value.productId && preview?.needsReceive && !costEdited)
      next = {
        ...next,
        officialCostAmount:
          products.find(product => product.id === next.productId)?.fixedCostAmount || '',
      };
    setValue(next);
  };
  const paymentInvalid =
    payment.status === 'company_received' && !String(value.settlementAmount).trim();
  const missingReceivePermission = preview?.needsReceive && !can('stock.receive');
  const submit = async event => {
    event.preventDefault();
    try {
      if (!preview || preview.serialNumber !== serial || busy) return;
      if (!confirmed) throw new Error('请核对并确认 SN 和规格');
      if (paymentInvalid) throw new Error('请先填写结算金额，再登记公司已到账');
      const result = await command.execute('POST', '/ledger/dispatch', {
        unit: {
          serialNumber: preview.serialNumber,
          needsReceive: preview.needsReceive,
          ...(preview.unit ? { id: preview.unit.id, expectedVersion: preview.unit.version } : {}),
          productId: value.productId,
          ...(preview.needsReceive
            ? { warehouseId: value.warehouseId, receivedOn: value.receivedOn }
            : {}),
          ...(costEdited && can('stock.cost.edit')
            ? { officialCostAmount: moneyValue(value.officialCostAmount) }
            : {}),
          ...(can('stock.expenses.edit') && value.extraExpenseAmount !== ''
            ? { extraExpenseAmount: ledgerAmount(value.extraExpenseAmount) }
            : {}),
          saleAmount: moneyValue(value.saleAmount),
          settlementAmount: ledgerAmount(value.settlementAmount),
        },
        salespersonName: value.salespersonName.trim(),
        handlerName: value.handlerName.trim(),
        soldOn: value.soldOn,
        payment: ledgerPayment(payment),
        notes: value.notes.trim() || null,
      });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  const close = () => {
    if (
      (serial || value.saleAmount || value.notes) &&
      !window.confirm('出库登记尚未保存，确定关闭？')
    )
      return;
    onClose();
  };
  return (
    <StockModal title="出库登记" onClose={close} busy={command.busy}>
      <form className="space-y-4" onSubmit={submit}>
        <StockDispatchScanner
          onCandidate={candidateReceived}
          onBusy={setScanning}
          disabled={command.busy || checking}
        />
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-medium text-gray-700">
            序列号（SN）
            <input
              className="input mt-1 font-mono"
              aria-label="序列号（SN）"
              value={serial}
              disabled={busy}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              required
              onChange={event => {
                invalidate();
                setReviewReasons([]);
                setSerial(event.target.value.toUpperCase());
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void lookup(serial);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void lookup(serial)}
            disabled={busy || !serial}
          >
            查询设备
          </button>
        </div>
        <StockFeedback loading={checking} error={error} />
        {!!reviewReasons.length && (
          <p className="text-sm text-amber-700">识别需核对：{reviewReasons.join('；')}</p>
        )}
        {preview && (
          <>
            <p
              role="status"
              className={`rounded border p-3 text-sm ${preview.needsReceive ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-blue-100 bg-blue-50 text-primary'}`}
            >
              {preview.needsReceive
                ? '此设备尚未入库，本次将一并创建入库记录。'
                : `已匹配库存设备 · ${preview.unit.warehouse?.name || ''}`}
            </p>
            {missingReceivePermission && (
              <StockFeedback error="你没有入库权限，请联系有权限人员先入库。" />
            )}
            <StockFields
              value={value}
              onChange={next => {
                setConfirmed(false);
                changeValue(next);
              }}
              disabled={busy}
              fields={[
                {
                  key: 'productId',
                  label: '机器型号 / 容量 / 颜色',
                  type: 'select',
                  required: true,
                  disabled: Boolean(preview.unit?.product?.id),
                  options: stockOptions(products, productLabel),
                },
                {
                  key: 'warehouseId',
                  label: '入库仓库',
                  type: 'select',
                  required: true,
                  hidden: !preview.needsReceive,
                  options: stockOptions(catalog.warehouses, row => row.name),
                },
                {
                  key: 'receivedOn',
                  label: '入库日期',
                  type: 'date',
                  required: true,
                  hidden: !preview.needsReceive,
                },
              ]}
            />
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                disabled={busy || !value.productId}
                onChange={event => setConfirmed(event.target.checked)}
                required
              />
              已核对 SN、型号、容量和颜色，与实物盒标一致
            </label>
            {can('stock.cost.read') && (
              <StockFields
                value={value}
                onChange={changeValue}
                disabled={busy || !can('stock.cost.edit')}
                fields={[
                  {
                    key: 'officialCostAmount',
                    label: '成本价（元）',
                    hint: preview.needsReceive
                      ? '默认官网目录售价，可手工修改'
                      : '默认沿用库存成本，可手工修改',
                    money: true,
                  },
                ]}
              />
            )}
            <LedgerPeopleFields
              value={value}
              onChange={next => {
                setValue(next);
                if (!payment.collectorName || payment.collectorName === value.salespersonName)
                  setPayment({ ...payment, collectorName: next.salespersonName });
              }}
              catalog={catalog}
              disabled={busy}
            />
            <StockFields
              value={value}
              onChange={changeValue}
              disabled={busy}
              fields={[
                { key: 'soldOn', label: '出售日期', type: 'date', required: true },
                { key: 'saleAmount', label: '售价（元）', required: true, money: true },
                {
                  key: 'settlementAmount',
                  label: '结算金额（元，可选）',
                  money: true,
                  hint: '人工填写扣除抽成和费用后的金额，不自动推算',
                },
                {
                  key: 'extraExpenseAmount',
                  label: '其他费用（元，可选）',
                  money: true,
                  hidden: !can('stock.expenses.edit'),
                  hint: '留空保留原值',
                },
              ]}
            />
            <LedgerPaymentFields
              value={payment}
              onChange={setPayment}
              catalog={catalog}
              disabled={busy}
            />
            {paymentInvalid && <StockFeedback error="结算金额为空时，不能登记为公司已到账。" />}
            {payment.status === 'agent_pending' && !value.settlementAmount && (
              <p className="text-sm text-gray-500">
                本次仅记录代收人和日期，收款金额待补；不会按售价推算。
              </p>
            )}
            <StockFields
              value={value}
              onChange={setValue}
              disabled={busy}
              fields={[
                {
                  key: 'notes',
                  label: '备注（可选）',
                  type: 'textarea',
                  hint: '留空保留已有设备备注',
                },
              ]}
            />
          </>
        )}
        <StockFeedback error={command.error} />
        <LedgerActions
          busy={command.busy}
          onClose={close}
          submitLabel="确认出库"
          disabled={busy || !preview || !confirmed || paymentInvalid || missingReceivePermission}
        />
      </form>
    </StockModal>
  );
}
