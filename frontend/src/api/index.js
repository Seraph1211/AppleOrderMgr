import client from './client'
import { getOrders, getOrderDetail, refreshOrder, batchRefreshOrders, updateOrder } from './ordersApi'
import { getAppleIds, getAppleIdDetail, createAppleId, updateAppleId, deleteAppleId } from './appleIdsApi'
import { getRecipients, getRecipientDetail, createRecipient, updateRecipient, deleteRecipient } from './recipientsApi'
import { getStats, getAppleIdStats, getRecipientStats, getProductStats } from './dashboardApi'
import { previewImport, executeImport, downloadTemplate } from './importApi'
import { getChannels, getChannelStats, getChannelOrders, updateChannelName } from './channelsApi'
import { getSystemLogs, getAutoRefreshStatus, resumeAutoRefresh } from './systemApi'

export {
  client,

  // Orders
  getOrders,
  getOrderDetail,
  refreshOrder,
  batchRefreshOrders,
  updateOrder,

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

  // Channels
  getChannels,
  getChannelStats,
  getChannelOrders,
  updateChannelName,

  // System
  getSystemLogs,
  getAutoRefreshStatus,
  resumeAutoRefresh,
}
