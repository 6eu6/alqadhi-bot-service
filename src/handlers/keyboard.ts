/**
 * AlQadi Store — Reply Keyboard Handlers
 * Handlers for the main reply keyboard buttons (ORDERS, STATS, ADMINS, SETTINGS, etc.)
 */

import { Telegraf } from 'telegraf'
import { db } from '../database.js'
import { sanitize, escapeCode, formatDate, formatAmount, getText, log, getStoreName } from '../helpers.js'
import { ORDER_STATUS_AR, PAYMENT_STATUS_AR, KB, getPaymentMethodLabel } from '../constants.js'
import { SUPER_ADMIN_CHAT_ID, SERVICE_PORT, WEBHOOK_SECRET } from '../config.js'
import { isSuperAdmin, adminCache, sendKeyboard } from '../admin.js'
import { orderActionKeyboard } from '../keyboards.js'
import { setConversation, clearConversation } from '../conversations.js'

export function registerKeyboardHandlers(bot: Telegraf<any>) {

  // ---------------------------------------------------------------------------
  // 📬 الطلبات المعلقة
  // ---------------------------------------------------------------------------
  bot.hears(KB.ORDERS, async (ctx) => {
    try {
      // Only show orders that need admin action: payment not yet confirmed
      // Exclude orders where payment is already PAID (they are being processed/shipped)
      const orders = await db.order.findMany({
        where: {
          paymentStatus: 'PENDING',
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
        include: {
          user: { select: { name: true, email: true, phone: true, country: true } },
          items: { include: { service: { select: { name: true } }, price: { select: { name: true } } } },
          payment: { select: { status: true, method: true, transactionId: true } },
          localPayment: { select: { status: true, receiptUrl: true, fieldValues: true, method: { select: { name: true, type: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      })

      if (orders.length === 0) {
        return sendKeyboard(ctx, '📭 <b>لا توجد طلبات معلقة حالياً</b>\n\nجميع الطلبات تم معالجتها ✅')
      }

      await sendKeyboard(ctx, `📬 <b>الطلبات بانتظار الدفع (${orders.length})</b>`)

      for (const order of orders) {
        const statusLabel = ORDER_STATUS_AR[order.status] || order.status
        const payStatusLabel = order.payment
          ? PAYMENT_STATUS_AR[order.payment.status] || order.payment.status
          : (order.localPayment ? PAYMENT_STATUS_AR[order.localPayment.status] || order.localPayment.status : '—')

        const itemsList = order.items.map((item: any, i: number) => {
          const svcName = getText(item.service?.name)
          let line = `  • ${sanitize(svcName)} × ${item.quantity}`
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

        let paymentInfo = `💳 الدفع: ${payStatusLabel}`
        if (order.localPayment) {
          const methodName = getText(order.localPayment.method?.name, order.paymentMethod || 'محلي')
          paymentInfo = `💳 الدفع: ${methodName} — ${payStatusLabel}`
          if (order.localPayment.receiptUrl) paymentInfo += `\n🖼 الإيصال: <a href="${order.localPayment.receiptUrl}">عرض الصورة</a>`
          if (order.localPayment.fieldValues && typeof order.localPayment.fieldValues === 'object') {
            const fvMeta = (order.localPayment.fieldValues as any)._meta as Record<string, any> | undefined
            const fvLabels = fvMeta?.fieldLabels as Record<string, string> | undefined
            for (const [key, val] of Object.entries(order.localPayment.fieldValues as Record<string, any>)) {
              if (key === '_meta' || !val) continue
              const label = fvLabels?.[key] || key
              paymentInfo += `\n    ${sanitize(label)}: <code>${escapeCode(String(val))}</code>`
            }
          }
        } else if (order.payment?.transactionId) {
          const gatewayLabel = getPaymentMethodLabel(order.paymentMethod)
          paymentInfo = `💳 الدفع: ${gatewayLabel} — ${payStatusLabel}\n🔢 المعاملة: <code>${escapeCode(order.payment.transactionId)}</code>`
        } else {
          // ★ Guarantee: إذا لا يوجد سجل دفع، اعرض طريقة الدفع من الطلب
          const gatewayLabel = getPaymentMethodLabel(order.paymentMethod)
          paymentInfo = `💳 الدفع: ${gatewayLabel} — ${payStatusLabel}`
        }

        // ★ Guarantee: عرض العملة المحلية + الدولار + طريقة الدفع
        const currency = order.currency || 'USD'
        const priceLine = currency !== 'USD'
          ? `💰 <b>${formatAmount(order.total, currency)}</b>\n💵 بالدولار: ${formatAmount(Number(order.totalUSD || 0), 'USD')}`
          : `💰 <b>${formatAmount(order.total, 'USD')}</b>`
        const exchangeLine = order.exchangeRate && Number(order.exchangeRate) > 0
          ? `\n💱 سعر الصرف: ${Number(order.exchangeRate).toFixed(4)}`
          : ''

        const msg = [
          `📋 <code>${escapeCode(order.orderNumber)}</code> · ${statusLabel}`,
          ``,
          `👤 ${sanitize(order.user.name)}`,
          `📧 ${sanitize(order.user.email)}`,
          order.user.phone ? `📱 ${sanitize(order.user.phone)}` : '',
          ``,
          `─────────────`,
          `🛍 <b>الخدمات:</b>`,
          itemsList,
          ``,
          `─────────────`,
          paymentInfo,
          ``,
          priceLine,
          exchangeLine,
          `🗓 ${formatDate(order.createdAt)}`,
        ].filter(Boolean).join('\n')

        // ★ استخدم orderActionKeyboard مع order.status لعرض الأزرار الصحيحة حسب الحالة
        await ctx.replyWithHTML(msg, orderActionKeyboard(order.id, order.status, order.paymentStatus, order.paymentMethod))
      }
    } catch (err: any) {
      const msg = err?.message || 'Unknown error'
      const code = err?.code || ''
      log('bot', `ERROR orders: ${msg}`, code ? `(${code})` : '', err)
      return sendKeyboard(ctx, `⚠️ <b>خطأ في جلب الطلبات</b>\n\nحدث خطأ داخلي. تحقق من السجلات للحصول على التفاصيل.`)
    }
  })

  // ---------------------------------------------------------------------------
  // 📊 الإحصائيات
  // ---------------------------------------------------------------------------
  bot.hears(KB.STATS, async (ctx) => {
    try {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)

      const [totalOrdersToday, completedToday, revenueToday, totalOrders] = await Promise.all([
        db.order.count({ where: { createdAt: { gte: todayStart, lte: todayEnd } } }),
        db.order.count({ where: { status: 'COMPLETED', createdAt: { gte: todayStart, lte: todayEnd } } }),
        db.order.aggregate({
          where: { status: 'COMPLETED', createdAt: { gte: todayStart, lte: todayEnd } },
          _sum: { totalUSD: true, total: true },
        }),
        db.order.count(),
      ])

      const revenueUSD = revenueToday._sum.totalUSD ? formatAmount(Number(revenueToday._sum.totalUSD), 'USD') : '0.00 USD'
      // Use same definition as "الطلبات المعلقة" list for consistency
      const pendingOrders = await db.order.count({ where: { paymentStatus: 'PENDING', status: { notIn: ['CANCELLED', 'REJECTED'] } } })
      const storeName = await getStoreName()

      return sendKeyboard(ctx, `
📊 <b>إحصائيات ${sanitize(storeName)}</b>

📅 <b>اليوم:</b>
📦 الطلبات الجديدة: <b>${totalOrdersToday}</b>
✅ المكتملة: <b>${completedToday}</b>
💰 الإيرادات: <b>${revenueUSD}</b>

─────────────

📋 <b>الحالة العامة:</b>
📬 الطلبات المعلقة: <b>${pendingOrders}</b>
📊 إجمالي الطلبات: <b>${totalOrders}</b>

⏰ ${formatDate(new Date())}
      `.trim())
    } catch (err: any) {
      const msg = err?.message || 'Unknown error'
      log('bot', `ERROR stats: ${msg}`, err)
      return sendKeyboard(ctx, `⚠️ <b>خطأ في جلب الإحصائيات</b>\n\nحدث خطأ داخلي — تحقق من السجلات`)
    }
  })

  // ---------------------------------------------------------------------------
  // 👥 المشرفين
  // ---------------------------------------------------------------------------
  bot.hears(KB.ADMINS, async (ctx) => {
    try {
      const admins = await db.botAdmin.findMany({
        where: { isActive: true }, orderBy: { addedAt: 'asc' },
      })
      if (admins.length === 0) return sendKeyboard(ctx, '📭 لا يوجد مشرفين مسجلين في قاعدة البيانات')

      const adminList = admins.map((a, i) => {
        const roleIcon = a.role === 'super' ? '👑' : '🔧'
        const name = a.name ? sanitize(a.name) : 'بدون اسم'
        return `${i + 1}. ${roleIcon} <code>${escapeCode(a.chatId)}</code> — ${name}\n   ⏰ ${formatDate(a.addedAt)}`
      }).join('\n\n')

      return sendKeyboard(ctx, `👥 <b>المشرفين (${admins.length})</b>\n\n${adminList}`)
    } catch (err: any) {
      const msg = err?.message || 'Unknown error'
      log('bot', `ERROR admins: ${msg}`, err)
      return sendKeyboard(ctx, `⚠️ خطأ في جلب المشرفين\n\nحدث خطأ داخلي — تحقق من السجلات`)
    }
  })

  // ---------------------------------------------------------------------------
  // ⚙️ الإعدادات
  // ---------------------------------------------------------------------------
  bot.hears(KB.SETTINGS, async (ctx) => {
    try {
      const botInfo = await bot.telegram.getMe()
      const adminCount = adminCache.size
      const settings = [
        ['🤖 اسم البوت', sanitize(botInfo.first_name)],
        ['🆔 معرف البوت', `@${botInfo.username}`],
        ['👑 المالك', `<code>${escapeCode(String(SUPER_ADMIN_CHAT_ID))}</code>`],
        ['👥 المشرفين', `<b>${adminCount}</b>`],
        ['🌐 Port', `<code>${SERVICE_PORT}</code>`],
        ['✅ الحالة', '🟢 متصل'],
        ['💾 قاعدة البيانات', '🔗 Supabase (PostgreSQL)'],
        ['🔗 مرتبط بـ', '🌐 خدمة مستقلة (Standalone)'],
        ['🔔 إشعارات تلقائية', WEBHOOK_SECRET ? '🟢 مفعلة' : '🔴 غير مفعلة'],
        ['📅 وقت التشغيل', formatDate(new Date())],
      ]
      const settingsText = settings.map(([label, value]) => `${label}: ${value}`).join('\n')

      return sendKeyboard(ctx, `⚙️ <b>إعدادات البوت</b>\n\n${settingsText}`)
    } catch (err: any) {
      const msg = err?.message || 'Unknown error'
      log('bot', `ERROR settings: ${msg}`, err)
      return sendKeyboard(ctx, `⚠️ <b>خطأ في جلب الإعدادات</b>\n\nحدث خطأ داخلي — تحقق من السجلات`)
    }
  })

  // ---------------------------------------------------------------------------
  // 📖 دليل الاستخدام
  // ---------------------------------------------------------------------------
  bot.hears(KB.HELP, async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    const isSuper = await isSuperAdmin(chatId)
    const superSection = isSuper ? `
─────────────

👨‍💼 <b>أوامر المالك:</b>

➕ إضافة مشرف — يطلب Chat ID والاسم
❌ حذف مشرف — يطلب Chat ID
⬆️ ترقية مشرف — لترقية إلى مالك 👑
⬇️ تخفيض مشرف — لتخفيض إلى مشرف عادي
` : ''

    const storeName = await getStoreName()
    return sendKeyboard(ctx, `
📖 <b>دليل بوت ${sanitize(storeName)}</b>

🏪 <b>لوحة التحكم:</b>
اضغط على الأزرار بالأسفل مباشرة!
كل زر ينفذ الأمر بدون كتابة.

─────────────

⚡ <b>إدارة الطلبات:</b>

🔔 <b>إشعارات تلقائية:</b>
يصلك إشعار فوري عند:
• تأكيد الدفع الإلكتروني (Stripe وغيرها)
• رفع إيصال دفع محلي يحتاج مراجعة

من أزرار الطلب يمكنك:
✅ تأكيد — تأكيد استلام الدفع (مع إنقاص المخزون)
❌ رفض — رفض الدفع مع كتابة السبب
📦 جاري الشحن — بدء الشحن
🎉 تم الشحن — إكمال الطلب (مع إنقاص المخزون إن لم يُخصم)
📋 التفاصيل — عرض كامل للطلب
${superSection}
─────────────

💡 <b>لمعرفة Chat ID:</b>
أرسل أي رسالة لـ @userinfobot
ثم أرسل الرقم الذي يعطيك إياه
    `.trim())
  })

  // ---------------------------------------------------------------------------
  // ➕ إضافة مشرف (SUPER ONLY)
  // ---------------------------------------------------------------------------
  bot.hears(KB.ADD_ADMIN, async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (!await isSuperAdmin(chatId)) {
      return sendKeyboard(ctx, '⛔ هذا الأمر متاح للمالك فقط 👑')
    }
    const cid = String(chatId)
    setConversation(cid, {
      type: 'add_admin',
      timeout: setTimeout(() => clearConversation(cid), 120_000),
    })
    return sendKeyboard(ctx, '📝 <b>أرسل Chat ID والاسم:</b>\n\n💡 الصيغة: <code>chatId الاسم</code>\n💡 مثال: <code>123456789 أحمد</code>\n\n⏱ لديك دقيقتان للرد\n💡 لمعرفة Chat ID: أرسل رسالة لـ @userinfobot')
  })

  // ---------------------------------------------------------------------------
  // ❌ حذف مشرف (SUPER ONLY)
  // ---------------------------------------------------------------------------
  bot.hears(KB.REMOVE_ADMIN, async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (!await isSuperAdmin(chatId)) {
      return sendKeyboard(ctx, '⛔ هذا الأمر متاح للمالك فقط 👑')
    }
    const cid = String(chatId)
    setConversation(cid, {
      type: 'remove_admin',
      timeout: setTimeout(() => clearConversation(cid), 120_000),
    })
    return sendKeyboard(ctx, '📝 <b>أرسل Chat ID المشرف:</b>\n\n💡 مثال: <code>123456789</code>\n\n⏱ لديك دقيقتان للرد')
  })

  // ---------------------------------------------------------------------------
  // ⬆️ ترقية مشرف (SUPER ONLY)
  // ---------------------------------------------------------------------------
  bot.hears(KB.PROMOTE, async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (!await isSuperAdmin(chatId)) {
      return sendKeyboard(ctx, '⛔ هذا الأمر متاح للمالك فقط 👑')
    }
    const cid = String(chatId)
    setConversation(cid, {
      type: 'promote',
      timeout: setTimeout(() => clearConversation(cid), 120_000),
    })
    return sendKeyboard(ctx, '📝 <b>أرسل Chat ID المشرف:</b>\n\n💡 سيتم ترقيته إلى مالك 👑\n💡 مثال: <code>123456789</code>\n\n⏱ لديك دقيقتان للرد')
  })

  // ---------------------------------------------------------------------------
  // ⬇️ تخفيض مشرف (SUPER ONLY)
  // ---------------------------------------------------------------------------
  bot.hears(KB.DEMOTE, async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (!await isSuperAdmin(chatId)) {
      return sendKeyboard(ctx, '⛔ هذا الأمر متاح للمالك فقط 👑')
    }
    const cid = String(chatId)
    setConversation(cid, {
      type: 'demote',
      timeout: setTimeout(() => clearConversation(cid), 120_000),
    })
    return sendKeyboard(ctx, '📝 <b>أرسل Chat ID المالك:</b>\n\n💡 سيتم تخفيضه إلى مشرف عادي\n💡 مثال: <code>123456789</code>\n\n⏱ لديك دقيقتان للرد')
  })
}
