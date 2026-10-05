import { useState } from 'react';
import { StockFeedback, StockFields, StockModal } from './StockCommon';
import { useStockCommand } from './stockHooks';
import { ledgerPayment, ledgerToday, LEDGER_PAYMENT_LABELS } from './ledgerHelpers';
import { LedgerActions, LedgerPaymentFields } from './ledgerFields';

/** 核对多台全额货款后一次更新，不要求建立回款单和分摊。 */
export default function LedgerPaymentForm({ units, catalog, onClose, onSaved }) {
  const command = useStockCommand();
  const initial = units.length === 1 ? units[0] : null;
  const [value, setValue] = useState({
    status: initial?.paymentStatus === 'unknown' ? 'unknown' : initial?.paymentStatus || '',
    collectorName: initial?.collectorName || initial?.salespersonName || '',
    collectedOn: initial?.collectedOn || '',
    receivedOn: initial?.companyReceivedOn || ledgerToday(),
  });
  const [reason, setReason] = useState('');
  const submit = async event => {
    event.preventDefault();
    try {
      const result = await command.execute('POST', '/ledger/payment', {
        units: units.map(unit => ({ id: unit.id, expectedVersion: unit.version })),
        payment: ledgerPayment(value),
        reason: reason.trim() || undefined,
      });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  return (
    <StockModal title={`更新货款 · ${units.length} 台`} onClose={onClose} busy={command.busy}>
      <form onSubmit={submit} className="space-y-4">
        <ul className="max-h-36 overflow-y-auto rounded-lg bg-gray-50 p-3 text-sm">
          {units.map(unit => (
            <li key={unit.id} className="flex flex-wrap justify-between gap-2 py-1">
              <span className="font-mono">{unit.serialNumber}</span>
              <span>{LEDGER_PAYMENT_LABELS[unit.paymentStatus] || '—'}</span>
            </li>
          ))}
        </ul>
        <LedgerPaymentFields
          value={value}
          onChange={setValue}
          catalog={catalog}
          historical={units.every(unit => unit.isHistorical)}
          disabled={command.busy}
        />
        <p className="rounded-lg bg-primary-50 p-3 text-sm text-gray-600">
          按每台结算金额核对全款后标记公司到账；未填结算时先编辑补充。只有部分货款时保留待转回，并在备注中说明。
        </p>
        <StockFields
          value={{ reason }}
          onChange={next => setReason(next.reason)}
          disabled={command.busy}
          fields={[
            {
              key: 'reason',
              label: '说明 / 更正原因',
              type: 'textarea',
              hint: '更正已经记录的货款时，请说明原因。',
            },
          ]}
        />
        <StockFeedback error={command.error} />
        <LedgerActions busy={command.busy} onClose={onClose} submitLabel="保存货款状态" />
      </form>
    </StockModal>
  );
}
