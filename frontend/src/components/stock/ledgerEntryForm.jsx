import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { StockFeedback, StockFields, StockModal, StockTable } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { moneyValue, stockOptions } from './stockHelpers';
import { ledgerAmount, ledgerPayment, ledgerProduct, ledgerToday } from './ledgerHelpers';
import {
  LedgerActions,
  LedgerPaymentFields,
  LedgerPeopleFields,
  LedgerProductFields,
} from './ledgerFields';
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
  const [units, setUnits] = useState(
    [...new Set(initialSerials)].map(serialNumber => ({
      serialNumber,
      saleAmount: '',
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
  const add = serials => {
    const next = [...units];
    serials.forEach(serialNumber => {
      if (!next.some(unit => unit.serialNumber === serialNumber))
        next.push({ serialNumber, saleAmount: value.uniformPrice, extraExpenseAmount: '' });
    });
    if (next.length > 100) throw new Error('一次最多登记 100 台');
    setUnits(next);
    return {
      added: next.length - units.length,
      duplicates: serials.length - (next.length - units.length),
    };
  };
  const changeUnit = (serialNumber, key, next) =>
    setUnits(previous =>
      previous.map(unit => (unit.serialNumber === serialNumber ? { ...unit, [key]: next } : unit))
    );
  const submit = async event => {
    event.preventDefault();
    try {
      if (!units.length) throw new Error('请至少加入一个 SN');
      const specification = ledgerProduct(value);
      const payload = {
        units: units.map(unit => ({
          serialNumber: unit.serialNumber,
          ...specification,
          warehouseId: value.warehouseId || null,
          receivedOn: value.receivedOn || null,
          ...(can('stock.source.link') ? { orderNumber: value.orderNumber.trim() || null } : {}),
          ...(can('stock.cost.edit')
            ? {
                officialCostAmount: ledgerAmount(value.officialCostAmount),
                acquiredOn: value.acquiredOn || null,
              }
            : {}),
          ...(can('stock.expenses.edit')
            ? { extraExpenseAmount: ledgerAmount(unit.extraExpenseAmount) }
            : {}),
          ...(historical ? { saleAmount: moneyValue(unit.saleAmount) } : {}),
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
    }
  };
  const label = historical ? '补录历史销售' : '入库登记';
  return (
    <StockModal title={label} onClose={onClose} busy={command.busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500">
          {historical
            ? '直接登记过去已经卖出的机器，保存后进入已售，不增减当前现货。姓名或货款情况不清楚时可明确待补。'
            : '相同规格可以一次录入多台。订单号和官网成本不知道时可以之后补充。'}
        </p>
        <LedgerProductFields
          value={value}
          onChange={setValue}
          catalog={catalog}
          disabled={command.busy}
        />
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
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
              key: 'officialCostAmount',
              label: '每台官网成本（元）',
              money: true,
              hidden: !can('stock.cost.edit'),
              placeholder: '拿货时的官网价，不清楚可留空',
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
              disabled={command.busy}
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
              disabled={command.busy}
            />
          </>
        )}
        <section className="space-y-3 border-t pt-4">
          <h3 className="font-medium">手机 SN</h3>
          <StockSerialInput onSerials={add} disabled={command.busy} />
          {historical && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-sm">
                统一售价（元）
                <input
                  className="input mt-1"
                  inputMode="decimal"
                  value={value.uniformPrice}
                  onChange={event => setValue({ ...value, uniformPrice: event.target.value })}
                  disabled={command.busy}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={command.busy || !value.uniformPrice}
                onClick={() =>
                  setUnits(units.map(unit => ({ ...unit, saleAmount: value.uniformPrice })))
                }
              >
                应用到全部
              </button>
            </div>
          )}
          <StockTable
            rowKey="serialNumber"
            items={units}
            empty="请扫描或输入 SN 后点击“加入”"
            columns={[
              {
                key: 'serialNumber',
                title: `待登记（${units.length} 台）`,
                className: 'font-mono break-all',
              },
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
                          onChange={event =>
                            changeUnit(unit.serialNumber, 'saleAmount', event.target.value)
                          }
                          disabled={command.busy}
                        />
                      ),
                    },
                  ]
                : []),
              ...(can('stock.expenses.edit')
                ? [
                    {
                      key: 'extraExpenseAmount',
                      title: '本台费用（元）',
                      render: unit => (
                        <input
                          className="input min-w-[90px]"
                          aria-label={`${unit.serialNumber} 额外费用`}
                          inputMode="decimal"
                          placeholder="可留空"
                          value={unit.extraExpenseAmount}
                          onChange={event =>
                            changeUnit(unit.serialNumber, 'extraExpenseAmount', event.target.value)
                          }
                          disabled={command.busy}
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
                    disabled={command.busy}
                    onClick={() =>
                      setUnits(units.filter(row => row.serialNumber !== unit.serialNumber))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ),
              },
            ]}
          />
          {can('stock.expenses.edit') && (
            <p className="text-xs text-gray-500">
              费用是这台手机的合计，可之后补录；同一笔快递费请分到各台，不要重复填写。
            </p>
          )}
        </section>
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[{ key: 'notes', label: '备注（可选）', type: 'textarea' }]}
        />
        <p className="text-xs text-gray-500">照片可在保存后打开单台详情继续补充。</p>
        <StockFeedback error={command.error} />
        {command.errorDetails?.existingUnitId && onExisting && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onExisting(command.errorDetails.existingUnitId)}
          >
            查看已有设备记录
          </button>
        )}
        <LedgerActions
          busy={command.busy}
          onClose={onClose}
          disabled={!units.length}
          submitLabel={`确认${historical ? '补录' : '入库'} ${units.length} 台`}
        />
      </form>
    </StockModal>
  );
}
