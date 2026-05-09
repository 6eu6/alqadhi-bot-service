/**
 * AlQadi Store — Constants
 * Status labels, event metadata, keyboard labels, and static keyboards.
 */

import { Markup } from 'telegraf'

// Order status labels in Arabic
export const ORDER_STATUS_AR: Record<string, string> = {
  PENDING: '⏳ قيد الانتظار',
  PROCESSING: '⚙️ قيد التنفيذ',
  COMPLETED: '✅ مكتمل',
  CANCELLED: '❌ ملغي',
  REJECTED: '🚫 مرفوض',
}

// Payment status labels in Arabic
export const PAYMENT_STATUS_AR: Record<string, string> = {
  PENDING: '⏳ في الانتظار',
  PAID: '✅ مدفوع',
  FAILED: '❌ فشل',
  REFUNDED: '↩️ مسترجع',
  APPROVED: '✅ مقبول',
  REJECTED: '🚫 مرفوض',
}

// Order event types for notifications
// ⚠️ SYNC: Must match BOT_CUSTOMER_EVENTS in al-qadhi-store/src/lib/notification-constants.ts
// Current store values: payment_approved | payment_rejected | order_processing | order_completed | order_cancelled
export type OrderEvent = 'payment_approved' | 'payment_rejected' | 'order_processing' | 'order_completed' | 'order_cancelled'

export const EVENT_META: Record<OrderEvent, { emoji: string; label: string }> = {
  payment_approved:  { emoji: '✅', label: 'تمت الموافقة على الدفع' },
  payment_rejected:  { emoji: '❌', label: 'تم رفض الدفع' },
  order_processing:  { emoji: '⚙️', label: 'جاري التنفيذ والشحن' },
  order_completed:   { emoji: '🎉', label: 'تم تنفيذ الطلب وتسليمه' },
  order_cancelled:   { emoji: '🚫', label: 'تم إلغاء الطلب' },
}

// Webhook event types (from store → bot)
export type WebhookEvent = 'payment_confirmed' | 'receipt_uploaded'

export const WEBHOOK_EVENT_META: Record<WebhookEvent, { emoji: string; label: string }> = {
  payment_confirmed: { emoji: '💰', label: 'طلب جديد — تم تأكيد الدفع' },
  receipt_uploaded:  { emoji: '📨', label: 'إيصال دفع جديد — بانتظار المراجعة' },
}

// Reply keyboard button labels
export const KB = {
  ORDERS: '📬 الطلبات المعلقة',
  STATS: '📊 الإحصائيات',
  ADMINS: '👥 المشرفين',
  SETTINGS: '⚙️ الإعدادات',
  HELP: '📖 دليل الاستخدام',
  ADD_ADMIN: '➕ إضافة مشرف',
  REMOVE_ADMIN: '❌ حذف مشرف',
  PROMOTE: '⬆️ ترقية مشرف',
  DEMOTE: '⬇️ تخفيض مشرف',
} as const

// Regular admin keyboard
export const adminKeyboard = Markup.keyboard([
  [KB.ORDERS, KB.STATS],
  [KB.ADMINS, KB.SETTINGS],
  [KB.HELP],
]).resize(true).oneTime(false)

// Super admin keyboard (includes admin management)
export const superKeyboard = Markup.keyboard([
  [KB.ORDERS, KB.STATS],
  [KB.ADMINS, KB.SETTINGS],
  [KB.ADD_ADMIN, KB.REMOVE_ADMIN],
  [KB.PROMOTE, KB.DEMOTE],
  [KB.HELP],
]).resize(true).oneTime(false)
