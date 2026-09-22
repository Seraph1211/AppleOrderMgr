import TagMultiSelect from './TagMultiSelect';
import { EMAIL_ORDER_STATUS_LABELS } from '../constants/orderStatus';

const STATUS_OPTIONS = Object.keys(EMAIL_ORDER_STATUS_LABELS);

/** 两张付款页面共用的邮件订单状态多选筛选。 */
export default function EmailStatusFilter({ value, onChange }) {
  return (
    <TagMultiSelect
      options={STATUS_OPTIONS}
      optionLabels={EMAIL_ORDER_STATUS_LABELS}
      value={value}
      onChange={onChange}
      ariaLabel="邮件状态筛选"
      placeholder="全部邮件状态"
      itemLabel="邮件状态"
    />
  );
}
