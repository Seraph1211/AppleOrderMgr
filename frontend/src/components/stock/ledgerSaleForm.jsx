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
    units.map(unit => ({ ...unit, saleAmount: '', extraExpenseAmount: '' }))
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
            onClick={() => setRows(rows.map(unit => ({ ...unit, saleAmount: value.uniformPrice })))}
          >
            应用到全部
          </button>
        </div>
        <StockTable
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
            ...(can('stock.expenses.edit')
              ? [
                  {
                    key: 'expense',
                    title: '本台费用（元）',
                    render: unit => (
                      <input
                        aria-label={`${unit.serialNumber} 额外费用`}
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
        <LedgerPaymentFields
          value={payment}
          onChange={setPayment}
          catalog={catalog}
          disabled={command.busy}
        />
        <p className="text-xs text-gray-500">
          以上货款状态应用到本次全部机器，只表示每台已核实的全款。费用单独记，不抵扣货款。
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
