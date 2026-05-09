/**
 * AlQadi Store — Keyboard Builders
 * All inline and reply keyboard builder functions.
 *
 * ★ CRITICAL: كل دالة تأخذ orderStatus + paymentStatus لتحديد الأزرار الصحيحة
 *   بعد كل إجراء، الأزرار تتحدث حسب الحالة الجديدة:
 *   - PENDING + PENDING  → [✅ تأكيد الاستلام, ❌ رفض الدفع] + [📋 التفاصيل]
 *   - PROCESSING + PAID  → [📦 جاري الشحن, 🎉 تم الشحن] + [📋 التفاصيل]
 *   - COMPLETED          → [📋 التفاصيل] فقط
 *   - REJECTED/CANCELLED → [📋 التفاصيل] فقط
 */

import { Markup } from 'telegraf'
import { WebhookEvent } from './constants.js'

/**
 * ★ Generate inline keyboard for an order based on BOTH order status AND payment status.
 * This is the primary keyboard builder — used by callbacks, order details, and pending orders.
 *
 * Logic:
 * - Terminal states (COMPLETED/REJECTED/CANCELLED): only details button
 * - PENDING + PENDING payment: approve/reject + details
 * - PENDING + PENDING + Stripe: waiting noop + details
 * - PROCESSING (any paymentStatus): ship + done + details
 */
export function orderActionKeyboard(
  orderId: string,
  orderStatus?: string,
  paymentStatus?: string,
  paymentMethod?: string | null,
) {
  const buttons: any[][] = []
  const isStripe = paymentMethod === 'STRIPE'

  // ★ الحالات النهائية — لا أزرار إجراء، فقط التفاصيل
  if (orderStatus === 'COMPLETED' || orderStatus === 'REJECTED' || orderStatus === 'CANCELLED') {
    buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])
    return Markup.inlineKeyboard(buttons)
  }

  // ★ طلب معلق — يحتاج تأكيد/رفض الدفع أولاً
  if (orderStatus === 'PENDING' || (!orderStatus && paymentStatus === 'PENDING')) {
    if (paymentStatus === 'PENDING' && !isStripe) {
      buttons.push([
        Markup.button.callback('✅ تأكيد الاستلام', `pay_approve_${orderId}`),
        Markup.button.callback('❌ رفع الدفع', `pay_reject_${orderId}`),
      ])
    } else if (paymentStatus === 'PENDING' && isStripe) {
      buttons.push([
        Markup.button.callback('⏳ بانتظار تأكيد Stripe تلقائياً', `noop_stripe_${orderId}`),
      ])
    }
  }

  // ★ طلب قيد التنفيذ — أزرار الشحن
  if (orderStatus === 'PROCESSING') {
    buttons.push([
      Markup.button.callback('📦 جاري الشحن', `ship_start_${orderId}`),
      Markup.button.callback('🎉 تم الشحن', `ship_done_${orderId}`),
    ])
  }

  // ★ زر التفاصيل دائماً
  buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])

  return Markup.inlineKeyboard(buttons)
}

/**
 * ★ Build inline keyboard for order after a specific action was performed.
 * This removes the button for the action that was just completed and shows remaining actions.
 *
 * Used after: pay_approve, ship_start, ship_done
 */
export function orderActionKeyboardAfterAction(
  orderId: string,
  completedAction: 'pay_approve' | 'ship_start' | 'ship_done' | 'pay_reject',
  orderStatus?: string,
  paymentStatus?: string,
  paymentMethod?: string | null,
) {
  const buttons: any[][] = []

  // ★ الحالات النهائية — فقط التفاصيل
  if (orderStatus === 'COMPLETED' || orderStatus === 'REJECTED' || orderStatus === 'CANCELLED') {
    buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])
    return Markup.inlineKeyboard(buttons)
  }

  // ★ بعد تأكيد الدفع — انتقل لمرحلة الشحن
  if (completedAction === 'pay_approve') {
    // الدفع مؤكد → أزرار الشحن
    buttons.push([
      Markup.button.callback('📦 جاري الشحن', `ship_start_${orderId}`),
      Markup.button.callback('🎉 تم الشحن', `ship_done_${orderId}`),
    ])
  }

  // ★ بعد بدء الشحن — فقط زر الإكمال
  if (completedAction === 'ship_start') {
    buttons.push([
      Markup.button.callback('🎉 تم الشحن', `ship_done_${orderId}`),
    ])
  }

  // ★ بعد الإكمال أو الرفض — فقط التفاصيل
  if (completedAction === 'ship_done' || completedAction === 'pay_reject') {
    buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])
    return Markup.inlineKeyboard(buttons)
  }

  // ★ زر التفاصيل دائماً
  buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])

  return Markup.inlineKeyboard(buttons)
}

/**
 * Build inline keyboard buttons for notification messages (from sendAdminNotification).
 * Returns raw button arrays compatible with Telegram API (not Telegraf Markup).
 *
 * ★ Buttons are determined by the EVENT (what just happened) + current DB state:
 * - payment_approved  → [📦 جاري الشحن, 🎉 تم الشحن] + [📋 التفاصيل]
 * - order_processing  → [🎉 تم الشحن] + [📋 التفاصيل]
 * - order_completed   → [📋 التفاصيل] فقط
 * - payment_rejected  → [📋 التفاصيل] فقط
 * - order_cancelled   → [📋 التفاصيل] فقط
 */
export function buildNotificationButtons(
  orderId: string,
  event: string,
  paymentMethod?: string | null,
  paymentStatus?: string | null,
  orderStatus?: string | null,
): any[][] {
  const buttons: any[][] = []

  // ★ بعد تأكيد الدفع — أزرار الشحن
  if (event === 'payment_approved') {
    buttons.push([
      { text: '📦 جاري الشحن', callback_data: `ship_start_${orderId}` },
      { text: '🎉 تم الشحن', callback_data: `ship_done_${orderId}` },
    ])
  }

  // ★ بعد بدء الشحن — فقط زر الإكمال
  if (event === 'order_processing') {
    buttons.push([
      { text: '🎉 تم الشحن', callback_data: `ship_done_${orderId}` },
    ])
  }

  // ★ بعد الإكمال أو الرفض أو الإلغاء — فقط التفاصيل
  if (event === 'order_completed' || event === 'payment_rejected' || event === 'order_cancelled') {
    buttons.push([{ text: '📋 التفاصيل', callback_data: `order_details_${orderId}` }])
    return buttons
  }

  // Details button always
  buttons.push([{ text: '📋 التفاصيل', callback_data: `order_details_${orderId}` }])

  return buttons
}

/**
 * Build inline keyboard for webhook-triggered notifications.
 * These are new order notifications that arrive from the store.
 *
 * For `payment_confirmed` (Stripe/gateway auto-confirmed):
 *   → Show ship + done + details buttons
 *
 * For `receipt_uploaded` (local payment awaiting review):
 *   → Show approve + reject + details buttons
 */
export function buildWebhookNotificationButtons(
  orderId: string,
  event: WebhookEvent,
  paymentMethod?: string | null,
): any[][] {
  const buttons: any[][] = []

  if (event === 'receipt_uploaded') {
    // Local payment — admin needs to approve/reject the receipt
    buttons.push([
      { text: '✅ تأكيد الاستلام', callback_data: `pay_approve_${orderId}` },
      { text: '❌ رفض الدفع', callback_data: `pay_reject_${orderId}` },
    ])
  }

  // For confirmed payments, show ship/done buttons
  if (event === 'payment_confirmed') {
    buttons.push([
      { text: '📦 جاري الشحن', callback_data: `ship_start_${orderId}` },
      { text: '🎉 تم الشحن', callback_data: `ship_done_${orderId}` },
    ])
  }

  // Details button always
  buttons.push([{ text: '📋 التفاصيل', callback_data: `order_details_${orderId}` }])

  return buttons
}
