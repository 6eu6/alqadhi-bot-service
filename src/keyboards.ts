/**
 * AlQadi Store — Keyboard Builders
 * All inline and reply keyboard builder functions.
 */

import { Markup } from 'telegraf'
import { WebhookEvent } from './constants.js'

/** Generate inline keyboard for an order based on its payment status and method */
export function orderActionKeyboard(orderId: string, paymentStatus?: string, paymentMethod?: string | null) {
  const buttons: any[][] = []
  const isStripe = paymentMethod === 'STRIPE'

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

  buttons.push([
    Markup.button.callback('📦 جاري الشحن', `ship_start_${orderId}`),
    Markup.button.callback('🎉 تم الشحن', `ship_done_${orderId}`),
  ])
  buttons.push([Markup.button.callback('📋 التفاصيل', `order_details_${orderId}`)])

  return Markup.inlineKeyboard(buttons)
}

/**
 * Build inline keyboard buttons for notification messages (from sendAdminNotification).
 * Returns raw button arrays compatible with Telegram API (not Telegraf Markup).
 */
export function buildNotificationButtons(
  orderId: string,
  event: string,
  paymentMethod?: string | null,
  paymentStatus?: string | null,
): any[][] {
  const buttons: any[][] = []
  const isStripe = paymentMethod === 'STRIPE'

  // Payment approval buttons for pending events
  if (event === 'payment_approved' || event === 'order_processing') {
    // Payment already approved — show shipment + details
    buttons.push([
      { text: '📦 جاري الشحن', callback_data: `ship_start_${orderId}` },
      { text: '🎉 تم الشحن', callback_data: `ship_done_${orderId}` },
    ])
  } else if (paymentStatus === 'PENDING' || event === 'payment_rejected') {
    if (!isStripe) {
      buttons.push([
        { text: '✅ تأكيد الاستلام', callback_data: `pay_approve_${orderId}` },
        { text: '❌ رفض الدفع', callback_data: `pay_reject_${orderId}` },
      ])
    } else {
      buttons.push([
        { text: '⏳ بانتظار تأكيد Stripe تلقائياً', callback_data: `noop_stripe_${orderId}` },
      ])
    }
    buttons.push([
      { text: '📦 جاري الشحن', callback_data: `ship_start_${orderId}` },
      { text: '🎉 تم الشحن', callback_data: `ship_done_${orderId}` },
    ])
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
