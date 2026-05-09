/**
 * AlQadi Store — Notification Functions
 * All notification sending functions for admin and webhook notifications.
 */

import { Telegraf } from 'telegraf'
import { db } from './database.js'
import { sanitize, escapeCode, formatDate, formatAmount, getText, log, getStoreName } from './helpers.js'
import { EVENT_META, WEBHOOK_EVENT_META, OrderEvent, WebhookEvent } from './constants.js'
import { adminCache, superAdminCache } from './admin.js'
import { buildNotificationButtons, buildWebhookNotificationButtons } from './keyboards.js'
import { SUPER_ADMIN_CHAT_ID } from './config.js'

/** Bot instance — set at startup via initNotifications() */
let bot: Telegraf<any> | null = null

/** Initialize the notification module with the bot instance (call once at startup) */
export function initNotifications(botInstance: Telegraf<any>) {
  bot = botInstance
}

/**
 * Get the list of target chat IDs for notifications.
 * Returns all active admins, or falls back to the super admin from env.
 */
function getTargetChatIds(): string[] {
  return adminCache.size > 0
    ? Array.from(adminCache)
    : [String(SUPER_ADMIN_CHAT_ID)]
}

/**
 * Send an inline Telegram notification to the admin chat about an order event.
 * Uses bot.telegram.sendMessage() directly.
 * Used for admin-initiated action confirmations (approve, reject, ship, complete).
 */
export async function sendAdminNotification(
  order: {
    id?: string
    orderNumber: string
    user: { name: string; email: string; phone?: string | null; country?: string | null }
    total: any
    currency: string
    paymentMethod?: string | null
    paymentStatus?: string | null
  },
  event: OrderEvent,
  extraNotes?: string,
): Promise<void> {
  if (!bot) {
    log('notify', 'ERROR Bot instance not initialized — call initNotifications() first')
    return
  }

  try {
    const meta = EVENT_META[event]
    if (!meta) return

    const paymentMethod = order.paymentMethod || 'غير محدد'

    // Fetch store name from settings for dynamic branding
    const storeName = await getStoreName()

    const lines: string[] = [
      `${meta.emoji} ${meta.label} — ${sanitize(storeName)}`,
      ``,
      `📋 الطلب: <code>${escapeCode(order.orderNumber)}</code>`,
      `👤 العميل: ${sanitize(order.user.name)}`,
      `📧 البريد: ${sanitize(order.user.email)}`,
    ]

    if (order.user.phone) {
      lines.push(`📱 الهاتف: ${sanitize(order.user.phone)}`)
    }

    lines.push('')
    lines.push(`─────────────`)
    lines.push(`💰 المبلغ: <b>${formatAmount(Number(order.total), order.currency)}</b>`)
    lines.push(`💳 الدفع: ${sanitize(paymentMethod)}`)

    if (extraNotes && extraNotes.trim().length > 0) {
      lines.push(`📝 ملاحظات: ${sanitize(extraNotes.trim())}`)
    }

    lines.push('')
    lines.push(`⏰ ${formatDate(new Date())}`)

    const message = lines.join('\n')

    // Build inline keyboard for order action buttons
    const extra: any = { parse_mode: 'HTML' }
    if (order.id) {
      extra.reply_markup = {
        inline_keyboard: buildNotificationButtons(order.id, event, order.paymentMethod, order.paymentStatus),
      }
    }

    // إرسال لجميع المشرفين النشطين
    const targetChatIds = getTargetChatIds()

    for (const chatId of targetChatIds) {
      try {
        await bot.telegram.sendMessage(chatId, message, extra)
      } catch (err) {
        log('notify', `ERROR Failed to send notification to ${chatId}:`, err)
      }
    }
  } catch (err) {
    log('notify', 'ERROR Failed to build admin notification:', err)
  }
}

/**
 * Send a detailed order notification to all admins — triggered by webhook from the store.
 * This is the PRIMARY notification mechanism for new orders.
 *
 * Two event types:
 *   - `payment_confirmed`: Stripe/gateway auto-confirmed → show ship/done buttons
 *   - `receipt_uploaded`: Customer uploaded receipt → show approve/reject buttons + receipt link
 *
 * This function fetches the order from DB with full details (items, payment, etc.)
 * and sends a rich notification to every active admin.
 */
export async function sendWebhookOrderNotification(
  orderId: string,
  event: WebhookEvent,
): Promise<void> {
  if (!bot) {
    log('webhook-notify', 'ERROR Bot instance not initialized — call initNotifications() first')
    return
  }

  try {
    const meta = WEBHOOK_EVENT_META[event]
    if (!meta) {
      log('webhook-notify', `ERROR Unknown webhook event: ${event}`)
      return
    }

    // Fetch full order details from DB
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { name: true, email: true, phone: true, country: true } },
        items: { include: { service: { select: { name: true } }, price: { select: { name: true } } } },
        payment: { select: { status: true, method: true, transactionId: true } },
        localPayment: {
          select: {
            status: true,
            receiptUrl: true,
            fieldValues: true,
            method: { select: { name: true, type: true } },
          },
        },
      },
    })

    if (!order) {
      log('webhook-notify', `ERROR Order not found: ${orderId}`)
      return
    }

    const storeName = await getStoreName()

    // Build items list — with package/plan name (price.name)
    const itemsList = order.items.map((item: any) => {
      const svcName = getText(item.service?.name)
      const priceName = getText(item.price?.name)
      let line = `  • ${sanitize(svcName)}`
      if (priceName && priceName !== '—') {
        line += `\n    📦 ${sanitize(priceName)} × ${item.quantity}`
      } else {
        line += ` × ${item.quantity}`
      }
      if (item.inputData && typeof item.inputData === 'object') {
        const inputDataMeta = item.inputData._meta as Record<string, any> | undefined
        const fieldLabels = inputDataMeta?.fieldLabels as Record<string, string> | undefined
        for (const [key, val] of Object.entries(item.inputData as Record<string, any>)) {
          if (key === '_meta' || !val) continue
          const label = fieldLabels?.[key] || key
          line += `\n    ${sanitize(label)}: ${sanitize(String(val))}`
        }
      }
      return line
    }).join('\n')

    // Build payment info
    let paymentInfo = ''
    if (event === 'receipt_uploaded' && order.localPayment) {
      const methodName = getText(order.localPayment.method?.name, order.paymentMethod || 'محلي')
      paymentInfo = `💳 الدفع: ${methodName} — ⏳ بانتظار المراجعة`
      // ★ عرض كود الإيصال/المرجع كنص فقط (بدون رابط صورة)
      // fieldValues تحتوي على كود الإيصال ورقم الحوالة وغيرها
      if (order.localPayment.fieldValues && typeof order.localPayment.fieldValues === 'object') {
        const fvMeta = (order.localPayment.fieldValues as any)._meta as Record<string, any> | undefined
        const fvLabels = fvMeta?.fieldLabels as Record<string, string> | undefined
        for (const [key, val] of Object.entries(order.localPayment.fieldValues as Record<string, any>)) {
          if (key === '_meta' || !val) continue
          const label = fvLabels?.[key] || key
          paymentInfo += `\n    ${sanitize(label)}: <code>${escapeCode(String(val))}</code>`
        }
      }
    } else if (event === 'payment_confirmed') {
      const gatewayName = order.paymentMethod || 'بوابة الدفع'
      paymentInfo = `💳 الدفع: ${sanitize(gatewayName)} — ✅ مدفوع ومؤكد`
      if (order.payment?.transactionId) {
        paymentInfo += `\n🔢 المعاملة: <code>${escapeCode(order.payment.transactionId)}</code>`
      }
    }

    // Build full message
    const lines: string[] = [
      `${meta.emoji} ${meta.label} — ${sanitize(storeName)}`,
      ``,
      `📋 الطلب: <code>${escapeCode(order.orderNumber)}</code>`,
      `👤 العميل: ${sanitize(order.user.name)}`,
      `📧 البريد: ${sanitize(order.user.email)}`,
    ]

    if (order.user.phone) {
      lines.push(`📱 الهاتف: ${sanitize(order.user.phone)}`)
    }

    lines.push('')
    lines.push(`─────────────`)
    lines.push(`🛍 <b>الخدمات:</b>`)
    lines.push(itemsList)
    lines.push('')
    lines.push(`─────────────`)
    lines.push(paymentInfo)
    lines.push('')
    lines.push(`💰 المبلغ: <b>${formatAmount(order.total, order.currency)}</b>`)
    lines.push(`⏰ ${formatDate(order.createdAt)}`)

    const message = lines.join('\n')

    // Build inline keyboard with appropriate action buttons
    const extra: any = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buildWebhookNotificationButtons(order.id, event, order.paymentMethod),
      },
    }

    // Send to ALL active admins
    const targetChatIds = getTargetChatIds()

    let sentCount = 0
    for (const chatId of targetChatIds) {
      try {
        await bot.telegram.sendMessage(chatId, message, extra)
        sentCount++
      } catch (err) {
        log('webhook-notify', `ERROR Failed to send to ${chatId}:`, err)
      }
    }

    log('webhook-notify', `Sent ${event} notification for order ${order.orderNumber} to ${sentCount}/${targetChatIds.length} admins`)
  } catch (err) {
    log('webhook-notify', `ERROR Failed to send webhook notification for order ${orderId}:`, err)
  }
}
