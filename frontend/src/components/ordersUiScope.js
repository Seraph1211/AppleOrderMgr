import { createContext, useContext } from 'react';

const OrdersUiContext = createContext(false);

/** 订单列表专用实例边界；Context 随 React 子树传递到 Portal。 */
export const OrdersUiProvider = OrdersUiContext.Provider;

/** 将订单实例标识显式传递给脱离路由 DOM 的弹层。 */
export function useOrdersUiScope() {
  return useContext(OrdersUiContext);
}
