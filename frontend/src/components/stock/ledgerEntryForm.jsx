import { useEffect, useRef, useState } from 'react';
import { stockGet } from '../../api/stockApi';
import StockBoxQueue from './StockBoxQueue';
import { normalizeOcrSerial } from '../../utils/pickupOcr';
import { Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { StockFeedback, StockFields, StockModal, StockTable } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { moneyValue, stockOptions } from './stockHelpers';
import { ledgerAmount, ledgerPayment, ledgerToday } from './ledgerHelpers';
import { LedgerActions, LedgerPaymentFields, LedgerPeopleFields } from './ledgerFields';
import StockSerialInput from './StockSerialInput';

/** 入库与历史销售共用设备录入，历史不经过当前库存。 */
export default function LedgerEntryForm({
  catalog,
  historical = false,
  initialSerials = [],
  initialOrderNumber = '',
  onClose,
  onSaved,
  onExisting,
}) {
  const { can } = useAuth();
  const command = useStockCommand();
  const [checking, setChecking] = useState(false);
  const [existingId, setExistingId] = useState(null);
  const busy = command.busy || checking;
  const [units, setUnits] = useState(
    [...new Set(initialSerials)].map(serialNumber => ({
      id: crypto.randomUUID(),
      serialNumber,
      productId: '',
      costMode: 'fixed',
      officialCostAmount: '',
      reviewReasons: [],
      sources: [],
      saleAmount: '',
      settlementAmount: '',
      extraExpenseAmount: '',
    }))
  );
  const [value, setValue] = useState({
    productId: '',
    modelName: '',
    storageGb: '',
    colorName: '',
    warehouseId: '',
    receivedOn: historical ? '' : ledgerToday(),
    soldOn: historical ? '' : ledgerToday(),
    orderNumber: initialOrderNumber,
    officialCostAmount: '',
    acquiredOn: '',
    notes: '',
    salespersonName: '',
    handlerName: '',
    uniformPrice: '',
  });
  const [payment, setPayment] = useState({
    status: historical ? 'unknown' : 'unpaid',
    collectorName: '',
    collectedOn: '',
    receivedOn: '',
  });
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueDirty, setQueueDirty] = useState(false);
  const [removed, setRemoved] = useState(0);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const products = catalog.products.filter(product => product.entryEligible);
  const updateUnits = next => {
    unitsRef.current = next;
    setUnits(next);
  };
  const close = () => {
    if (
      (units.length || queueBusy || queueDirty || removed) &&
      !window.confirm('未保存的清单和照片将丢失，确定关闭？')
    )
      return;
    onClose();
  };
  useEffect(() => {
    const before = event => {
      if (unitsRef.current.length || queueDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [queueDirty]);
  const addCandidates = (candidates, source) => {
    const next = [...unitsRef.current];
    let added = 0;
    candidates.forEach(candidate => {
      const existing =
        candidate.serialNumber && next.find(unit => unit.serialNumber === candidate.serialNumber);
      if (existing) {
        const index = next.indexOf(existing);
        next[index] = {
          ...existing,
          sources: [...existing.sources, ...(source ? [source] : [])],
          reviewReasons: [
            ...new Set([
              ...existing.reviewReasons,
              ...candidate.reviewReasons,
              ...(candidate.productId &&
              existing.productId &&
              candidate.productId !== existing.productId
                ? ['重复 SN 的规格冲突，请核对']
                : []),
            ]),
          ],
        };
      } else {
        next.push({
          id: crypto.randomUUID(),
          serialNumber: candidate.serialNumber || '',
          productId: candidate.productId || '',
          costMode: 'fixed',
          officialCostAmount: '',
          costBasis: '',
          saleAmount: value.uniformPrice,
          extraExpenseAmount: '',
          reviewReasons: candidate.reviewReasons || [],
          sources: source ? [source] : [],
        });
        added += 1;
      }
    });
    if (next.length > 100) throw new Error('一次最多登记 100 台，请移除部分设备后重试');
    updateUnits(next);
    return { added, duplicates: candidates.length - added };
  };
  const add = serials =>
    addCandidates(
      serials.map(serialNumber => ({
        serialNumber,
        productId: value.productId,
        reviewReasons: [],
      }))
    );
  const changeUnit = (id, key, nextValue) =>
    updateUnits(
      unitsRef.current.map(unit => {
        if (unit.id !== id) return unit;
        return {
          ...unit,
          [key]: nextValue,
          ...(key === 'productId' && unit.costMode === 'manual'
            ? {
                reviewReasons: [
                  ...new Set([...unit.reviewReasons, '规格已变更，请重新核对人工成本']),
                ],
              }
            : {}),
        };
      })
    );
  const productSelect = (selected, onChange, label, required = false) => (
    <label className="block text-sm">
      {label}
      <select
        className="input mt-1 min-w-[180px]"
        aria-label={label}
        value={selected}
        onChange={event => onChange(event.target.value)}
        disabled={busy}
        required={required}
      >
        <option value="">请选择容量与颜色</option>
        {products.map(product => (
          <option key={product.id} value={product.id}>
            {product.storageGb >= 1024 ? `${product.storageGb / 1024}TB` : `${product.storageGb}GB`}{' '}
            {product.colorName}
          </option>
        ))}
      </select>
    </label>
  );
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    setChecking(true);
    setExistingId(null);
    try {
      if (!units.length) throw new Error('请至少加入一个 SN');
      if (queueBusy) throw new Error('请等待识别完成或取消待识别图片');
      if (
        units.some(
          unit =>
            unit.reviewReasons.length || !unit.productId || !normalizeOcrSerial(unit.serialNumber)
        )
      )
        throw new Error('请补齐 SN 和规格，并逐台处理待核对项');
      if (new Set(units.map(unit => unit.serialNumber)).size !== units.length)
        throw new Error('清单有重复 SN，请核对');
      const checked = await stockGet('/ledger/check-serials', {
        serials: JSON.stringify(units.map(unit => unit.serialNumber)),
      });
      if (checked.existing.length) {
        setExistingId(checked.existing[0].id);
        throw new Error(`SN ${checked.existing[0].serialNumber} 已登记，请查看原记录`);
      }
      const payload = {
        units: units.map(unit => ({
          serialNumber: unit.serialNumber,
          productId: unit.productId,
          warehouseId: value.warehouseId || null,
          receivedOn: value.receivedOn || null,
          ...(can('stock.source.link') ? { orderNumber: value.orderNumber.trim() || null } : {}),
          ...(can('stock.cost.edit') && unit.costMode !== 'fixed'
            ? {
                officialCostAmount:
                  unit.costMode === 'pending' ? null : ledgerAmount(unit.officialCostAmount),
                costBasis: unit.costBasis || null,
              }
            : {}),
          ...(can('stock.expenses.edit')
            ? { extraExpenseAmount: ledgerAmount(unit.extraExpenseAmount) }
            : {}),
          ...(historical
            ? {
                saleAmount: moneyValue(unit.saleAmount),
                settlementAmount: ledgerAmount(unit.settlementAmount),
              }
            : {}),
          notes: value.notes.trim() || null,
        })),
        ...(historical
          ? {
              salespersonName: value.salespersonName.trim() || null,
              handlerName: value.handlerName.trim() || null,
              soldOn: value.soldOn,
              payment: ledgerPayment(payment),
            }
          : {}),
      };
      const result = await command.execute(
        'POST',
        historical ? '/ledger/history' : '/ledger/receive',
        payload
      );
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    } finally {
      setChecking(false);
    }
  };
  const label = historical ? '补录历史销售' : '入库登记';
  return (
    <StockModal title={label} onClose={close} busy={busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500">
          {historical
            ? '直接登记过去已经卖出的机器，保存后进入已售，不增减当前现货。姓名或货款情况不清楚时可明确待补。'
            : '支持多张盒标和混合规格；每台分别核对。保存时按已确认固定目录生成成本，未知拿货日期保持为空。'}
        </p>
        <p className="font-medium">iPhone 18 Pro Max · 每台独立规格</p>
        {productSelect(
          value.productId,
          productId => setValue({ ...value, productId }),
          '手工或扫码默认规格（可先留空）'
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !value.productId}
          onClick={() => {
            if (units.some(unit => unit.costMode === 'manual')) {
              command.setError('有人工成本行，请逐台修改规格并核对成本');
              return;
            }
            updateUnits(units.map(unit => ({ ...unit, productId: value.productId })));
          }}
        >
          将选中规格应用到全部行
        </button>
        <StockFields
          value={value}
          onChange={setValue}
          disabled={busy}
          fields={[
            {
              key: 'warehouseId',
              label: historical ? '出库仓库（可待补）' : '所在仓库',
              type: 'select',
              required: !historical,
              options: stockOptions(catalog.warehouses),
            },
            {
              key: 'receivedOn',
              label: historical ? '原入库日期（可待补）' : '入库日期',
              type: 'date',
              required: !historical,
            },
            {
              key: 'orderNumber',
              label: '订单号',
              hidden: !can('stock.source.link'),
              placeholder: '苹果订单号，可之后补充',
            },
            {
              key: 'soldOn',
              label: '实际销售日期',
              type: 'date',
              required: true,
              hidden: !historical,
            },
          ]}
        />
        {historical && (
          <>
            <LedgerPeopleFields
              value={value}
              onChange={setValue}
              catalog={catalog}
              historical
              disabled={busy}
            />
            <LedgerPaymentFields
              value={payment}
              onChange={next =>
                setPayment({
                  ...next,
                  collectorName:
                    next.status === 'agent_pending' && !next.collectorName
                      ? value.salespersonName
                      : next.collectorName,
                })
              }
              catalog={catalog}
              historical
              disabled={busy}
            />
          </>
        )}
        <section className="space-y-3 border-t pt-4">
          <h3 className="font-medium">手机 SN</h3>
          <StockSerialInput onSerials={add} disabled={busy} hideOcr />
          <StockBoxQueue
            onCandidates={addCandidates}
            onBusy={setQueueBusy}
            onDirty={setQueueDirty}
            disabled={busy}
          />
          {historical && units.length > 1 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-sm">
                售价（元）
                <input
                  className="input mt-1"
                  inputMode="decimal"
                  value={value.uniformPrice}
                  onChange={event => setValue({ ...value, uniformPrice: event.target.value })}
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !value.uniformPrice}
                onClick={() =>
                  updateUnits(
                    units.map(unit => ({
                      ...unit,
                      saleAmount: value.uniformPrice,
                    }))
                  )
                }
              >
                应用到全部
              </button>
              <p className="w-full text-xs text-gray-500">
                填写每台售价并应用到全部，仍可逐台调整。
              </p>
            </div>
          )}
          {historical && (
            <p className="text-xs text-gray-500">
              结算金额＝售价－渠道抽成－其他费用，由人工填写；未填写时毛利待补结算。
            </p>
          )}
          <StockTable
            rowKey="id"
            items={units}
            empty="请扫描或输入 SN 后点击“加入”"
            columns={[
              {
                key: 'serialNumber',
                title: `待登记（${units.length} 台）`,
                render: unit => (
                  <div className="min-w-[180px] space-y-2">
                    <input
                      aria-label="本台 SN"
                      className="input font-mono"
                      value={unit.serialNumber}
                      onChange={event =>
                        changeUnit(unit.id, 'serialNumber', event.target.value.toUpperCase())
                      }
                      disabled={busy}
                      required
                    />
                    <div className="flex flex-wrap gap-1">
                      {unit.sources.map((source, index) => (
                        <a
                          key={index}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`查看原图 ${source.name}`}
                        >
                          <img
                            src={source.url}
                            alt={source.name}
                            className="h-12 w-12 rounded object-cover"
                          />
                        </a>
                      ))}
                    </div>
                    {unit.reviewReasons.length > 0 && (
                      <>
                        <p className="text-sm text-amber-800">{unit.reviewReasons.join('；')}</p>
                        <button
                          className="btn btn-secondary"
                          type="button"
                          disabled={
                            !unit.productId ||
                            !normalizeOcrSerial(unit.serialNumber) ||
                            command.busy
                          }
                          onClick={() => changeUnit(unit.id, 'reviewReasons', [])}
                        >
                          已逐台核对
                        </button>
                      </>
                    )}
                  </div>
                ),
              },
              {
                key: 'productId',
                title: '本台规格',
                render: unit =>
                  productSelect(
                    unit.productId,
                    next => changeUnit(unit.id, 'productId', next),
                    `${unit.serialNumber || '待补 SN'} 规格`,
                    true
                  ),
              },
              ...(can('stock.cost.read')
                ? [
                    {
                      key: 'cost',
                      title: '本台成本',
                      render: unit => (
                        <div className="min-w-[130px] space-y-1">
                          <p>
                            {unit.costMode === 'fixed'
                              ? products.find(product => product.id === unit.productId)
                                  ?.fixedCostAmount || '待补规格'
                              : unit.costMode === 'pending'
                                ? '待补'
                                : unit.officialCostAmount}{' '}
                            元
                          </p>
                          <p className="text-xs text-gray-500">固定目录价；拿货日期未知</p>
                          {can('stock.cost.edit') && (
                            <>
                              <select
                                aria-label={`${unit.serialNumber} 成本来源`}
                                className="input"
                                value={unit.costMode}
                                onChange={event =>
                                  changeUnit(unit.id, 'costMode', event.target.value)
                                }
                                disabled={busy}
                              >
                                <option value="fixed">固定目录</option>
                                <option value="pending">待补</option>
                                <option value="manual">人工核定</option>
                              </select>
                              {unit.costMode !== 'fixed' && (
                                <input
                                  className="input"
                                  aria-label={`${unit.serialNumber} 成本依据`}
                                  placeholder="核定或待补依据"
                                  value={unit.costBasis}
                                  onChange={event =>
                                    changeUnit(unit.id, 'costBasis', event.target.value)
                                  }
                                  required
                                  disabled={busy}
                                />
                              )}
                              {unit.costMode === 'manual' && (
                                <input
                                  className="input"
                                  aria-label={`${unit.serialNumber} 人工成本`}
                                  inputMode="decimal"
                                  value={unit.officialCostAmount}
                                  onChange={event =>
                                    changeUnit(unit.id, 'officialCostAmount', event.target.value)
                                  }
                                  required
                                  disabled={busy}
                                />
                              )}
                            </>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
              ...(historical
                ? [
                    {
                      key: 'saleAmount',
                      title: '售价（元）',
                      render: unit => (
                        <input
                          className="input min-w-[90px]"
                          aria-label={`${unit.serialNumber} 售价`}
                          inputMode="decimal"
                          required
                          value={unit.saleAmount}
                          onChange={event => changeUnit(unit.id, 'saleAmount', event.target.value)}
                          disabled={busy}
                        />
                      ),
                    },
                  ]
                : []),
              ...(historical
                ? [
                    {
                      key: 'settlementAmount',
                      title: '结算金额（元）',
                      render: unit => (
                        <input
                          aria-label={`${unit.serialNumber} 结算金额`}
                          className="input min-w-[110px]"
                          inputMode="decimal"
                          disabled={busy}
                          placeholder="人工填写，可待补"
                          value={unit.settlementAmount || ''}
                          onChange={event =>
                            changeUnit(unit.id, 'settlementAmount', event.target.value)
                          }
                        />
                      ),
                    },
                  ]
                : []),
              ...(can('stock.expenses.edit')
                ? [
                    {
                      key: 'extraExpenseAmount',
                      title: '其他费用（元）',
                      render: unit => (
                        <input
                          className="input min-w-[90px]"
                          aria-label={`${unit.serialNumber} 其他费用`}
                          inputMode="decimal"
                          placeholder="可留空"
                          value={unit.extraExpenseAmount}
                          onChange={event =>
                            changeUnit(unit.id, 'extraExpenseAmount', event.target.value)
                          }
                          disabled={busy}
                        />
                      ),
                    },
                  ]
                : []),
              {
                key: 'remove',
                title: '操作',
                render: unit => (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`移除 ${unit.serialNumber}`}
                    disabled={busy}
                    onClick={() => (
                      updateUnits(units.filter(row => row.id !== unit.id)),
                      setRemoved(removed + 1)
                    )}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ),
              },
            ]}
          />
          {removed > 0 && (
            <p role="status" className="text-sm text-gray-600">
              已移除 {removed} 台，未登记。
            </p>
          )}
          {can('stock.expenses.edit') && (
            <p className="text-xs text-gray-500">
              其他费用是这台手机的合计，可之后补录；同一笔快递费请分到各台，不要重复填写。
            </p>
          )}
        </section>
        <StockFields
          value={value}
          onChange={setValue}
          disabled={busy}
          fields={[{ key: 'notes', label: '备注（可选）', type: 'textarea' }]}
        />
        <p className="text-xs text-gray-500">照片可在保存后打开单台详情继续补充。</p>
        <StockFeedback error={command.error} />
        {(existingId || command.errorDetails?.existingUnitId) && onExisting && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onExisting(existingId || command.errorDetails.existingUnitId)}
          >
            查看已有设备记录
          </button>
        )}
        <LedgerActions
          busy={busy}
          onClose={close}
          disabled={!units.length || queueBusy}
          submitLabel={`确认${historical ? '补录' : '入库'} ${units.length} 台`}
        />
      </form>
    </StockModal>
  );
}
