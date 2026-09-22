import client from './client';
import {
  getOrders,
  getOrderDetail,
  getOrderLink,
  getOrderFilterOptions,
  exportOrders,
  updateOrder,
} from './ordersApi';
import {
  getAppleIds,
  getAppleIdDetail,
  createAppleId,
  updateAppleId,
  deleteAppleId,
} from './appleIdsApi';
import {
  getRecipients,
  getRecipientFilterOptions,
  getRecipientDetail,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  exportRecipients,
} from './recipientsApi';
import { getStats, getAppleIdStats, getRecipientStats, getProductStats } from './dashboardApi';
import { previewImport, executeImport, downloadTemplate } from './importApi';
import { getChannels, getChannelStats, getChannelOrders, updateChannelName } from './channelsApi';
import {
  getEmailProcessingRecords,
  getEmailProcessingMetrics,
  getEmailProcessingRecord,
  reparseEmailRecord,
  saveEmailDraft,
  ingestEmailRecord,
  batchReparseEmailRecords,
  resolveEmailRecord,
} from './emailProcessingApi';

export {
  client,

  // Orders
  getOrders,
  getOrderDetail,
  getOrderLink,
  getOrderFilterOptions,
  exportOrders,
  updateOrder,

  // Apple IDs
  getAppleIds,
  getAppleIdDetail,
  createAppleId,
  updateAppleId,
  deleteAppleId,

  // Recipients
  getRecipients,
  getRecipientFilterOptions,
  getRecipientDetail,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  exportRecipients,

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

  // Email processing
  getEmailProcessingRecords,
  getEmailProcessingMetrics,
  getEmailProcessingRecord,
  reparseEmailRecord,
  saveEmailDraft,
  ingestEmailRecord,
  batchReparseEmailRecords,
  resolveEmailRecord,
};
