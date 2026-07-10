import client from './client'
import { getOrders, getOrderDetail, refreshOrder, batchRefreshOrders } from './ordersApi'
import { getAppleIds, getAppleIdDetail, createAppleId, updateAppleId, deleteAppleId } from './appleIdsApi'
import { getRecipients, getRecipientDetail, createRecipient, updateRecipient, deleteRecipient } from './recipientsApi'
import { getStats, getAppleIdStats, getRecipientStats, getProductStats } from './dashboardApi'
import { previewImport, executeImport, downloadTemplate } from './importApi'

export {
  client,

  // Orders
  getOrders,
  getOrderDetail,
  refreshOrder,
  batchRefreshOrders,

  // Apple IDs
  getAppleIds,
  getAppleIdDetail,
  createAppleId,
  updateAppleId,
  deleteAppleId,

  // Recipients
  getRecipients,
  getRecipientDetail,
  createRecipient,
  updateRecipient,
  deleteRecipient,

  // Dashboard
  getStats,
  getAppleIdStats,
  getRecipientStats,
  getProductStats,

  // Import
  previewImport,
  executeImport,
  downloadTemplate,
}
