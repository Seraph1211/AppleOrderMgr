import { LEDGER_PAYMENT_LABELS } from './ledgerHelpers';
import { moneyText } from './stockHelpers';

const PAYMENT_BADGES = {
  unpaid: 'badge-error',
  agent_pending: 'badge-warning',
  company_received: 'badge-success',
  unknown: 'bg-gray-100 text-gray-700',
  legacy_partial: 'badge-info',
};

/** 用文字和彩色标签同时表达货款状态，不依赖颜色传达含义。 */
export function StockPaymentBadge({ value }) {
  if (!LEDGER_PAYMENT_LABELS[value]) return '—';
  return (
    <span className={`badge whitespace-nowrap ${PAYMENT_BADGES[value]}`}>
      {LEDGER_PAYMENT_LABELS[value]}
    </span>
  );
}

/** 仅已知毛利金额着色；缺值不当作零，毛利标签保留中性色。 */
export function StockProfitAmount({ unit }) {
  if (unit.grossProfit == null) {
    return <span>{unit.settlementAmount == null ? '待补结算' : '待补官网售价'}</span>;
  }
  const amount = Number(unit.grossProfit);
  return (
    <span className={amount > 0 ? 'text-green-700' : amount < 0 ? 'text-red-700' : 'text-gray-500'}>
      {moneyText(unit.grossProfit)}
    </span>
  );
}
