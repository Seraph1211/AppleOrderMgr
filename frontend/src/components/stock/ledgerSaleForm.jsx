import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { StockFeedback, StockFields, StockModal, StockTable } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { moneyValue } from './stockHelpers';
import { ledgerAmount, ledgerPayment, ledgerToday } from './ledgerHelpers';
import { LedgerActions, LedgerPaymentFields, LedgerPeopleFields } from './ledgerFields';

/** 直接一次售出选中实物，保留各自仓库和售价。 */
export default function LedgerSaleForm({ units, catalog, onClose, onSaved }) {
  const { can } = useAuth();
  const command = useStockCommand();
  const [value, setValue] = useState({
    salespersonName: '',
    handlerName: '',
    soldOn: ledgerToday(),
    notes: '',
    uniformPrice: '',
  });
  const [rows, setRows] = useState(
    units.map(unit => ({ ...unit, saleAmount: '', settlementAmount: '', extraExpenseAmount: '' }))
  );
  const [payment, setPayment] = useState({
    status: 'unpaid',
    collectorName: '',
    collectedOn: '',
    receivedOn: ledgerToday(),
  });
  const submit = async event => {
    event.preventDefault();
    try {
      const result = await command.execute('POST', '/ledger/sell', {
        units: rows.map(unit => ({
          id: unit.id,
          expectedVersion: unit.version,
          saleAmount: moneyValue(unit.saleAmount),
          settlementAmount: ledgerAmount(unit.settlementAmount),
          ...(can('stock.expenses.edit') && unit.extraExpenseAmount !== ''
            ? { extraExpenseAmount: ledgerAmount(unit.extraExpenseAmount) }
            : {}),
        })),
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
  return (
    <StockModal title={`登记售出 · ${units.length} 台`} onClose={onClose} busy={command.busy} wide>
      <form onSubmit={submit} className="space-y-4">
        <LedgerPeopleFields
          value={value}
          onChange={next => {
            setValue(next);
            if (!payment.collectorName || payment.collectorName === value.salespersonName)
              setPayment({ ...payment, collectorName: next.salespersonName });
          }}
          catalog={catalog}
          disabled={command.busy}
        />
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[{ key: 'soldOn', label: '销售日期', type: 'date', required: true }]}
        />
        {rows.length > 1 && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-sm">
              售价（元）
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
                setRows(rows.map(unit => ({ ...unit, saleAmount: value.uniformPrice })))
              }
            >
              应用到全部
            </button>
            <p className="w-full text-xs text-gray-500">
              填写每台售价，点击“应用到全部”；应用后仍可逐台调整。
            </p>
          </div>
        )}
        <StockTable
          mobileFields
          items={rows}
          columns={[
            {
              key: 'serialNumber',
              title: 'SN / 出库仓库',
              className: 'break-all',
              render: unit => (
                <>
                  <div className="font-mono">{unit.serialNumber}</div>
                  <div className="text-xs text-gray-500">{unit.warehouse?.name || '—'}</div>
                </>
              ),
            },
            {
              key: 'saleAmount',
              title: '售价（元）',
              render: unit => (
                <input
                  aria-label={`${unit.serialNumber} 售价`}
                  className="input min-w-[100px]"
                  inputMode="decimal"
                  required
                  value={unit.saleAmount}
                  disabled={command.busy}
                  onChange={event =>
                    setRows(
                      rows.map(row =>
                        row.id === unit.id ? { ...row, saleAmount: event.target.value } : row
                      )
                    )
                  }
                />
              ),
            },
            {
              key: 'settlementAmount',
              title: '结算金额（元）',
              render: unit => (
                <input
                  aria-label={`${unit.serialNumber} 结算金额`}
                  className="input min-w-[110px]"
                  inputMode="decimal"
                  placeholder="人工填写，可待补"
                  value={unit.settlementAmount}
                  disabled={command.busy}
                  onChange={event =>
                    setRows(
                      rows.map(row =>
                        row.id === unit.id ? { ...row, settlementAmount: event.target.value } : row
                      )
                    )
                  }
                />
              ),
            },
            ...(can('stock.expenses.edit')
              ? [
                  {
                    key: 'expense',
                    title: '其他费用（元）',
                    render: unit => (
                      <input
                        aria-label={`${unit.serialNumber} 其他费用`}
                        className="input min-w-[100px]"
                        inputMode="decimal"
                        placeholder="保留原费用"
                        value={unit.extraExpenseAmount}
                        disabled={command.busy}
                        onChange={event =>
                          setRows(
                            rows.map(row =>
                              row.id === unit.id
                                ? { ...row, extraExpenseAmount: event.target.value }
                                : row
                            )
                          )
                        }
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
        <p className="text-xs text-gray-500">
          结算金额＝售价－渠道抽成－其他费用，请按实际结算手工填写；单台毛利＝结算金额－官网售价。其他费用留空保留原值，填写后替换原值。
        </p>
        <LedgerPaymentFields
          value={payment}
          onChange={setPayment}
          catalog={catalog}
          disabled={command.busy}
        />
        <p className="text-xs text-gray-500">
          以上货款状态应用到本次全部机器，按每台结算金额记录已核实的全款；结算已含扣费，不再重复扣减。
        </p>
        <StockFields
          value={value}
          onChange={setValue}
          disabled={command.busy}
          fields={[
            {
              key: 'notes',
              label: '备注（可选）',
              type: 'textarea',
              hint: '填写后更新所选设备备注；留空保留原备注',
            },
          ]}
        />
        <StockFeedback error={command.error} />
        <LedgerActions
          busy={command.busy}
          onClose={onClose}
          submitLabel={`确认售出 ${rows.length} 台`}
        />
      </form>
    </StockModal>
  );
}
