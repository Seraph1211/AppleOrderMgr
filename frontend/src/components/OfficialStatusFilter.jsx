import TagMultiSelect from './TagMultiSelect';
import { ORDER_STATUS_LABELS } from '../constants/orderStatus';

const STATUS_OPTIONS = Object.keys(ORDER_STATUS_LABELS);

/** 两张付款页面共用的官网订单状态多选筛选。 */
export default function OfficialStatusFilter({ value, onChange }) {
  return (
    <TagMultiSelect
      options={STATUS_OPTIONS}
      optionLabels={ORDER_STATUS_LABELS}
      value={value}
      onChange={onChange}
      ariaLabel="官网状态筛选"
      placeholder="全部官网状态"
      itemLabel="官网状态"
    />
  );
}
