/**
 * AlQadi Store — Inline Callback Handlers
 * Handlers for inline button callbacks (pay_approve, pay_reject, ship, order_details, etc.)
 *
 * ★ CRITICAL: كل handler يتحقق من الحالة الحالية للطلب من قاعدة البيانات
 *   قبل وبعد استدعاء store API. هذا يضمن:
 *   1. لا تكرار إجراءات (idempotent)
 *   2. إذا فشل store API، المشرف يرى رسالة واضحة
 *   3. الأزرار تتحدث حسب الحالة الفعلية للطلب — كل زر يختفي بعد تنفيذ إجراءه
 */

import { Telegraf, Markup } from 'telegraf'
import { db } from '../database.js'
import { isValidOrderId, sanitize, escapeCode, sanitizeUrl, formatDate, formatAmount, getText, log } from '../helpers.js'
import { ORDER_STATUS_AR, PAYMENT_STATUS_AR, getPaymentMethodLabel } from '../constants.js'
import { getEffectiveChatId, sendKeyboard, isSuperAdmin, refreshAdminCache } from '../admin.js'
import { SUPER_ADMIN_CHAT_ID } from '../config.js'
import { orderActionKeyboard, orderActionKeyboardAfterAction } from '../keyboards.js'
import { callStoreOrderApi } from '../store-api.js'
import { setConversation, clearConversation } from '../conversations.js'
import { auditLog } from '../audit.js'
// ★ sendAdminNotification تم إزالته — إجراءات المشرف لا توصل إشعارات لبقية المشرفين
// كل مشرف يتفاعل مع رسالته فقط، بدون إشعارات متقاطعة

/**
 * ★ Helper: جلب الحالة الحالية للطلب من قاعدة البيانات بعد إجراء
 * هذا يضمن أن الإجراء تم تطبيقه فعلاً وليس فقط أن API أعاد نجاح
 */
async function verifyOrderStatus(orderId: string): Promise<{
  status: string
  paymentStatus: string
  paymentMethod: string | null
} | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, paymentStatus: true, paymentMethod: true },
  })
  return order ? { status: order.status, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod } : null
}

export function registerCallbackHandlers(bot: Telegraf<any>) {

  // ---------------------------------------------------------------------------
  // ⏳ Stripe noop — just acknowledge, no action needed
  // ---------------------------------------------------------------------------
  bot.action(/^noop_stripe_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⏳ سيتم التأكيد تلقائياً عبر Stripe')
      log('callback', `noop_stripe orderId=${ctx.match![1]}`)
    } catch (err: any) {
      log('callback', `ERROR noop_stripe: ${err?.message}`, err)
    }
  })

  // ---------------------------------------------------------------------------
  // ✅ تأكيد الدفع (pay_approve)
  // ★ بعد التأكيد: يختفي زر التأكيد والرفض → تظهر أزرار الشحن
  // ---------------------------------------------------------------------------
  bot.action(/^pay_approve_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⚙️ جاري التأكيد...')
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT pay_approve: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `pay_approve orderId=${orderId}`)

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: {
          user: { select: { id: true, name: true, email: true, country: true, phone: true } },
          localPayment: true,
          payment: true,
        },
      })
      if (!order) {
        return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })
      }

      // ★ تحقق: الطلب مدفوع فعلاً؟ (ضغط زر قديم)
      if (order.paymentStatus === 'PAID') {
        const currentStatus = ORDER_STATUS_AR[order.status] || order.status
        return ctx.editMessageText(
          `ℹ️ <b>تم تأكيد هذا الطلب بالفعل</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ${currentStatus}\n💳 الدفع: ✅ مؤكد`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // Delegate to store's centralized API (atomic: order + payment + stock + notification)
      const result = await callStoreOrderApi(orderId, 'approve', { actorId: String(ctx.from?.id || 'unknown') })

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `pay_approve FAILED: ${errMsg}`)
        try {
          await ctx.editMessageText(
            `❌ <b>فشل تأكيد الدفع</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}\n\n💡 حاول مرة أخرى أو تحقق من السجلات`,
            {
              parse_mode: 'HTML',
              // ★ حتى عند الفشل، أظهر الأزرار الأصلية للمحاولة مرة أخرى
              ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
            },
          )
        } catch {
          try { await ctx.replyWithHTML(`⚠️ خطأ في تأكيد الدفع\n\n${errMsg}`) } catch { /* ignore */ }
        }
        return
      }

      // ★ تحقق من قاعدة البيانات أن التغيير تم فعلاً
      const verified = await verifyOrderStatus(orderId)
      if (!verified || verified.paymentStatus !== 'PAID') {
        log('callback', `CRITICAL: pay_approve API returned success but DB still shows paymentStatus=${verified?.paymentStatus}`)
        try {
          await ctx.editMessageText(
            `⚠️ <b>تحذير: قد لا يكون التأكيد قد حُفظ</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 حالة الدفع في DB: ${verified?.paymentStatus || 'غير معروف'}\n\n💡 تحقق من السجلات أو حاول مرة أخرى`,
            {
              parse_mode: 'HTML',
              ...orderActionKeyboard(orderId, verified?.status || order.status, verified?.paymentStatus || order.paymentStatus, order.paymentMethod),
            },
          )
        } catch { /* ignore */ }
        return
      }

      // ★ لا إشعار للمشرفين الآخرين — كل مشرف يتفاعل مع رسالته فقط
      // المشرف الفعّال شاف النتيجة عبر ctx.editMessageText()
      // المشرفين الآخرين يقدرون يضغطون أي زر في رسالتهم ويشوفون الحالة الحالية

      // ★ تحديث الرسالة مع كيبورد جديد — أزرار الشحن بدل أزرار التأكيد
      await ctx.editMessageText(
        `✅ <b>تم تأكيد استلام الدفع!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ قيد التنفيذ\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
        {
          parse_mode: 'HTML',
          ...orderActionKeyboardAfterAction(orderId, 'pay_approve', verified.status, verified.paymentStatus, order.paymentMethod),
        },
      )
      log('callback', `pay_approve SUCCESS orderId=${orderId} — verified paymentStatus=PAID in DB`)

      // ★ AUDIT: تسجيل تأكيد الدفع
      auditLog({
        action: 'approve_payment',
        actorId: String(ctx.from?.id || 'unknown'),
        targetType: 'order',
        targetId: orderId,
        details: { orderNumber: order.orderNumber, paymentMethod: order.paymentMethod },
      })
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR pay_approve: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
      try {
        await ctx.replyWithHTML(`⚠️ خطأ في تأكيد الدفع\n\nحدث خطأ داخلي — تحقق من السجلات`)
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // ❌ رفض الدفع (pay_reject) — يعرض تأكيد/تراجع أولاً
  // ---------------------------------------------------------------------------
  bot.action(/^pay_reject_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery()
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT pay_reject: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `pay_reject orderId=${orderId}`)

      // ★ تحقق من الحالة الحالية أولاً
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, paymentStatus: true, status: true, paymentMethod: true },
      })

      if (!order) {
        return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })
      }

      // ★ إذا الطلب مدفوع/مؤكد — لا يمكن رفضه
      if (order.paymentStatus === 'PAID') {
        const statusLabel = ORDER_STATUS_AR[order.status] || order.status
        return ctx.editMessageText(
          `ℹ️ <b>لا يمكن رفض طلب تم تأكيد دفعه</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ${statusLabel}\n💳 الدفع: ✅ مؤكد`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // ★ إذا الطلب مرفوض/ملغي — لا يمكن رفضه مرة أخرى
      if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
        return ctx.editMessageText(
          `ℹ️ <b>هذا الطلب ${order.status === 'REJECTED' ? 'مرفوض' : 'ملغي'} بالفعل</b>`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      const displayNumber = order.orderNumber || orderId

      // عرض أزرار تأكيد/تراجع
      return ctx.editMessageText(
        `❌ <b>رفض الدفع</b>\n\n📋 <code>${escapeCode(displayNumber)}</code>\n\n⚠️ هل أنت متأكد من رفض هذا الطلب؟\nسيتم رفض الطلب وإبلاغ العميل بالسبب.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ تأكيد الرفض', `reject_confirm_${orderId}`),
            Markup.button.callback('↩️ تراجع', `reject_cancel_${orderId}`),
          ],
        ]),
      )
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR pay_reject: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // ✅ تأكيد الرفض (reject_confirm) — يطلب سبب الرفض
  // ---------------------------------------------------------------------------
  bot.action(/^reject_confirm_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery()
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT reject_confirm: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `reject_confirm orderId=${orderId}`)

      const chatId = getEffectiveChatId(ctx)
      if (!chatId) {
        log('callback', `ERROR reject_confirm: no chat ID found`)
        return ctx.editMessageText('⚠️ تعذر تحديد المحادثة', { parse_mode: 'HTML' })
      }

      // جلب حالة الدفع الحالية للطلب قبل بدء المحادثة + تحقق إضافي
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { paymentStatus: true, paymentMethod: true, status: true },
      })
      if (order?.paymentStatus === 'PAID') {
        return ctx.editMessageText(
          '⚠️ لا يمكن رفض طلب تم تأكيد دفعه بالفعل',
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      const cid = String(chatId)
      setConversation(cid, {
        orderId,
        type: 'reject_reason',
        paymentStatus: order?.paymentStatus || undefined,
        paymentMethod: order?.paymentMethod || undefined,
        timeout: setTimeout(() => clearConversation(cid), 120_000),
      })

      return ctx.editMessageText(
        `📝 <b>اكتب سبب الرفض:</b>\n\nسيتم رفض الطلب وإبلاغ العميل بالسبب.\n⏱ لديك دقيقتان للرد`,
        { parse_mode: 'HTML' },
      )
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR reject_confirm: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // ↩️ تراجع عن الرفض (reject_cancel) — يرجع الأزرار الأصلية
  // ---------------------------------------------------------------------------
  bot.action(/^reject_cancel_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('↩️ تم التراجع')
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT reject_cancel: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `reject_cancel orderId=${orderId}`)

      // جلب بيانات الطلب لإرجاع الأزرار
      const order = await db.order.findUnique({
        where: { id: orderId },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          items: { include: { service: { select: { name: true } }, price: { select: { name: true } } } },
          payment: { select: { status: true, method: true, transactionId: true } },
          localPayment: { select: { status: true, receiptUrl: true, fieldValues: true, method: { select: { name: true, type: true } } } },
        },
      })

      if (!order) {
        return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })
      }

      const statusLabel = ORDER_STATUS_AR[order.status] || order.status
      const payStatusLabel = order.payment
        ? PAYMENT_STATUS_AR[order.payment.status] || order.payment.status
        : (order.localPayment ? PAYMENT_STATUS_AR[order.localPayment.status] || order.localPayment.status : '—')

      const itemsList = order.items.map((item: any, i: number) => {
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

      let paymentInfo = `💳 الدفع: ${payStatusLabel}`
      if (order.localPayment) {
        const localMethodName = getText(order.localPayment.method?.name)
        const gatewayLabel = getPaymentMethodLabel(order.paymentMethod)
        const displayMethod = localMethodName !== '—' ? localMethodName : gatewayLabel
        paymentInfo = `💳 الدفع: ${displayMethod} — ${payStatusLabel}`
        if (order.localPayment.receiptUrl) {
          const safeUrl = sanitizeUrl(order.localPayment.receiptUrl)
          if (safeUrl) paymentInfo += `\n🖼 الإيصال: <a href="${safeUrl}">عرض الصورة</a>`
        }
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
      }

      const msg = [
        `📋 <code>${escapeCode(order.orderNumber)}</code> · ${statusLabel}`,
        ``,
        `👤 ${sanitize(order.user.name)}`,
        `📧 ${sanitize(order.user.email)}`,
        order.user.phone ? `📱 ${sanitize(order.user.phone)}` : '📱 لايوجد رقم هاتف مُدخل',
        ``,
        `─────────────`,
        `🛍 <b>الخدمات:</b>`,
        itemsList,
        ``,
        `─────────────`,
        paymentInfo,
        ``,
        `💰 <b>${formatAmount(order.total, order.currency)}</b>`,
        `🗓 ${formatDate(order.createdAt)}`,
      ].filter(Boolean).join('\n')

      // ★ استخدم orderActionKeyboard مع order.status
      return ctx.editMessageText(msg, {
        parse_mode: 'HTML',
        ...orderActionKeyboard(order.id, order.status, order.paymentStatus, order.paymentMethod),
      })
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR reject_cancel: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // 📦 جاري الشحن (ship_start)
  // ★ بعد بدء الشحن: يختفي زر جاري الشحن → يبقى فقط زر تم الشحن
  // ---------------------------------------------------------------------------
  bot.action(/^ship_start_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⚙️ جاري التحديث...')
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT ship_start: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `ship_start orderId=${orderId}`)

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: { user: { select: { name: true, email: true, country: true, phone: true } } },
      })
      if (!order) return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })

      // ★ تحقق: الطلب مكتمل فعلاً؟
      if (order.status === 'COMPLETED') {
        return ctx.editMessageText(
          `ℹ️ <b>هذا الطلب مكتمل بالفعل</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ✅ مكتمل`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // ★ تحقق: الطلب مرفوض أو ملغي؟
      if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
        const statusLabel = ORDER_STATUS_AR[order.status] || order.status
        return ctx.editMessageText(
          `ℹ️ <b>لا يمكن الشحن — الطلب ${statusLabel}</b>`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // ★ تحقق: الطلب قيد التنفيذ فعلاً (بعد تأكيد الدفع)
      if (order.status === 'PROCESSING') {
      // ★ لا إشعار للمشرفين الآخرين
      // ★ حدث الكيبورد — أزل زر جاري الشحن، أبقِ زر تم الشحن
      return ctx.editMessageText(
          `📦 <b>الطلب قيد التنفيذ والشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ جاري التنفيذ\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboardAfterAction(orderId, 'ship_start', order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // Payment check before shipping
      const isUnpaid = order.paymentStatus !== 'PAID'
      const ONLINE_PAYMENT_METHODS = ['STRIPE', 'MOYASAR', 'PAYTABS', 'PAYPAL']

      if (isUnpaid) {
        if (ONLINE_PAYMENT_METHODS.includes(order.paymentMethod || '')) {
          log('callback', `BLOCK ship_start: order ${orderId} uses online payment (${order.paymentMethod}) but is not PAID`)
          return ctx.editMessageText(
            `🚫 <b>لا يمكن الشحن — الدفع غير مؤكد</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n💳 طريقة الدفع: ${order.paymentMethod}\n📊 حالة الدفع: ${order.paymentStatus}\n\n⚠️ يجب تأكيد الدفع من بوابة الدفع الإلكترونية أولاً قبل الشحن.\nإذا تم الدفع بالفعل، تحقق من حالة الويب هوك أو اضغط "تأكيد الاستلام".`,
            {
              parse_mode: 'HTML',
              ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
            },
          )
        }
        log('callback', `WARN ship_start: order ${orderId} is unpaid. Allowing with warning.`)
      }

      // Delegate to store's centralized API
      const result = await callStoreOrderApi(orderId, 'process', { actorId: String(ctx.from?.id || 'unknown') })

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `ship_start FAILED: ${errMsg}`)
        try {
          await ctx.editMessageText(
            `❌ <b>فشل تحديث حالة الشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}`,
            {
              parse_mode: 'HTML',
              // ★ حتى عند الفشل، أظهر الأزرار الأصلية للمحاولة مرة أخرى
              ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
            },
          )
        } catch {
          try { await ctx.replyWithHTML(`⚠️ خطأ\n\n${errMsg}`) } catch { /* ignore */ }
        }
        return
      }

      // ★ تحقق من قاعدة البيانات أن التغيير تم فعلاً
      const verified = await verifyOrderStatus(orderId)

      // ★ لا إشعار للمشرفين الآخرين — كل مشرف يتفاعل مع رسالته فقط

      const unpaidWarning = isUnpaid
        ? '\n\n⚠️ <b>تنبيه:</b> الطلب لم يتم تأكيد دفعه بعد! يرجى تأكيد الدفع عبر زر "تأكيد الاستلام" أولاً.'
        : ''

      // ★ حدث الكيبورد — أزل زر جاري الشحن، أبقِ فقط زر تم الشحن
      await ctx.editMessageText(
        `📦 <b>تم تحديث: جاري الشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ جاري التنفيذ والشحن${verified ? ` (✅ موثق: ${PAYMENT_STATUS_AR[verified.paymentStatus] || verified.paymentStatus})` : ''}\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل${unpaidWarning}`,
        {
          parse_mode: 'HTML',
          ...orderActionKeyboardAfterAction(orderId, 'ship_start', verified?.status || 'PROCESSING', verified?.paymentStatus || order.paymentStatus, order.paymentMethod),
        },
      )
      log('callback', `ship_start SUCCESS orderId=${orderId} — verified status=${verified?.status} paymentStatus=${verified?.paymentStatus}`)

      // ★ AUDIT: تسجيل بدء الشحن
      auditLog({
        action: 'ship_start',
        actorId: String(ctx.from?.id || 'unknown'),
        targetType: 'order',
        targetId: orderId,
        details: { orderNumber: order.orderNumber },
      })
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR ship_start: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
      try {
        await ctx.replyWithHTML(`⚠️ خطأ\n\nحدث خطأ داخلي — تحقق من السجلات`)
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // 🎉 تم الشحن (ship_done)
  // ★ بعد الإكمال: تختفي كل أزرار الإجراءات → يبقى فقط زر التفاصيل
  // ---------------------------------------------------------------------------
  bot.action(/^ship_done_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⚙️ جاري التحديث...')
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT ship_done: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `ship_done orderId=${orderId}`)

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: { user: { select: { name: true, email: true, country: true, phone: true } } },
      })
      if (!order) return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })

      // ★ تحقق: الطلب مكتمل فعلاً؟
      if (order.status === 'COMPLETED') {
        return ctx.editMessageText(
          `ℹ️ <b>هذا الطلب مكتمل بالفعل</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ✅ مكتمل ومشحون\n💳 الدفع: ✅ مؤكد`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // ★ تحقق: الطلب مرفوض أو ملغي؟
      if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
        return ctx.editMessageText(
          `ℹ️ <b>لا يمكن إكمال طلب ${ORDER_STATUS_AR[order.status] || order.status}</b>`,
          {
            parse_mode: 'HTML',
            ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
          },
        )
      }

      // Delegate to store's centralized API (handles: order update + idempotent stock decrement)
      const result = await callStoreOrderApi(orderId, 'complete', { actorId: String(ctx.from?.id || 'unknown') })

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `ship_done FAILED: ${errMsg}`)
        try {
          await ctx.editMessageText(
            `❌ <b>فشل إكمال الطلب</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}`,
            {
              parse_mode: 'HTML',
              ...orderActionKeyboard(orderId, order.status, order.paymentStatus, order.paymentMethod),
            },
          )
        } catch {
          try { await ctx.replyWithHTML(`⚠️ خطأ\n\n${errMsg}`) } catch { /* ignore */ }
        }
        return
      }

      // ★ تحقق من قاعدة البيانات أن التغيير تم فعلاً
      const verified = await verifyOrderStatus(orderId)

      // ★ لا إشعار للمشرفين الآخرين — كل مشرف يتفاعل مع رسالته فقط

      // ★ حدث الكيبورد — كل أزرار الإجراءات تختفي، فقط التفاصيل
      await ctx.editMessageText(
        `🎉 <b>تم الشحن بنجاح!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ✅ مكتمل ومشحون${verified ? ` (✅ موثق)` : ''}\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
        {
          parse_mode: 'HTML',
          ...orderActionKeyboardAfterAction(orderId, 'ship_done', verified?.status || 'COMPLETED', verified?.paymentStatus || 'PAID', order.paymentMethod),
        },
      )
      log('callback', `ship_done SUCCESS orderId=${orderId} — verified status=${verified?.status} paymentStatus=${verified?.paymentStatus}`)

      // ★ AUDIT: تسجيل إكمال الطلب
      auditLog({
        action: 'ship_done',
        actorId: String(ctx.from?.id || 'unknown'),
        targetType: 'order',
        targetId: orderId,
        details: { orderNumber: order.orderNumber },
      })
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR ship_done: ${msg}`, err)
      try {
        await ctx.answerCbQuery('❌ حدث خطأ')
      } catch { /* ignore */ }
      try {
        await ctx.replyWithHTML(`⚠️ خطأ\n\nحدث خطأ داخلي — تحقق من السجلات`)
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // 📋 تفاصيل الطلب (order_details)
  // ---------------------------------------------------------------------------
  bot.action(/^order_details_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery()
      const orderId = ctx.match![1]
      if (!isValidOrderId(orderId)) {
        log('security', `REJECT order_details: invalid orderId format: ${orderId}`)
        return ctx.answerCbQuery('⚠️ معرّف طلب غير صالح')
      }
      log('callback', `order_details orderId=${orderId}`)

      const order = await db.order.findUnique({
        where: { id: orderId },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          items: { include: { service: { select: { name: true } }, price: { select: { name: true } } } },
          payment: { select: { status: true, method: true, transactionId: true } },
          localPayment: { select: { status: true, receiptUrl: true, fieldValues: true, reviewNotes: true, method: { select: { name: true } } } },
        },
      })
      if (!order) return ctx.replyWithHTML('⚠️ الطلب غير موجود')

      const statusLabel = ORDER_STATUS_AR[order.status] || order.status
      const payStatusLabel = order.payment
        ? PAYMENT_STATUS_AR[order.payment.status] || order.payment.status
        : (PAYMENT_STATUS_AR[order.paymentStatus] || order.paymentStatus)

      const itemsList = order.items.map((item: any, i: number) => {
        const svcName = getText(item.service?.name)
        const priceName = getText(item.price?.name)
        let line = `  • ${sanitize(svcName)}\n    📦 ${sanitize(priceName)} × ${item.quantity} — ${formatAmount(item.unitPrice, order.currency)}`
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
        const localMethodName = getText(order.localPayment.method?.name)
        const gatewayLabel = getPaymentMethodLabel(order.paymentMethod)
        const displayMethod = localMethodName !== '—' ? localMethodName : gatewayLabel
        paymentInfo = `💳 الدفع: ${displayMethod} — ${payStatusLabel}`
        if (order.localPayment.receiptUrl) {
          const safeUrl = sanitizeUrl(order.localPayment.receiptUrl)
          if (safeUrl) paymentInfo += `\n🖼 الإيصال: <a href="${safeUrl}">عرض الصورة</a>`
        }
        if (order.localPayment.reviewNotes) paymentInfo += `\n📝 ملاحظات: ${sanitize(order.localPayment.reviewNotes)}`
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
        const gatewayLabel = getPaymentMethodLabel(order.paymentMethod)
        paymentInfo = `💳 الدفع: ${gatewayLabel} — ${payStatusLabel}`
      }

      // ★ Guarantee: العملة والسعر بالدولار دائماً ظاهرين
      const currencyLines: string[] = []
      if (order.currency !== 'USD') {
        currencyLines.push(`   المجموع: ${formatAmount(order.subtotal, order.currency)}`)
        if (Number(order.discount) > 0) currencyLines.push(`   🏷 الخصم: -${formatAmount(order.discount, order.currency)}`)
        currencyLines.push(`   <b>الإجمالي: ${formatAmount(order.total, order.currency)}</b>`)
        currencyLines.push(`   💵 بالدولار: ${formatAmount(order.totalUSD, 'USD')}`)
      } else {
        currencyLines.push(`   المجموع: ${formatAmount(order.subtotal, 'USD')}`)
        if (Number(order.discount) > 0) currencyLines.push(`   🏷 الخصم: -${formatAmount(order.discount, 'USD')}`)
        currencyLines.push(`   <b>الإجمالي: ${formatAmount(order.total, 'USD')}</b>`)
      }
      if (order.exchangeRate) {
        currencyLines.push(`   💱 سعر الصرف: ${Number(order.exchangeRate).toFixed(4)}`)
      }

      return ctx.replyWithHTML(`
📋 <b>تفاصيل الطلب</b>

🔢 الطلب: <code>${escapeCode(order.orderNumber)}</code>
📊 الحالة: ${statusLabel}

─────────────

👤 <b>العميل:</b>
   ${sanitize(order.user.name)}
   📧 ${sanitize(order.user.email)}${order.user.phone ? `\n   📱 ${sanitize(order.user.phone)}` : '\n   📱 لايوجد رقم هاتف مُدخل'}

─────────────

🛍 <b>الخدمات (${order.items.length}):</b>

${itemsList}

─────────────

💰 <b>الملخص:</b>
${currencyLines.join('\n')}
${paymentInfo}

⏰ ${formatDate(order.createdAt)}
      `.trim(), orderActionKeyboard(order.id, order.status, order.paymentStatus, order.paymentMethod))
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR order_details: ${msg}`, err)
      try {
        await ctx.replyWithHTML(`⚠️ خطأ\n\nحدث خطأ داخلي — تحقق من السجلات`)
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // 👑 تأكيد الترقية (promote_confirm)
  // ★ SECURITY: يتطلب تأكيد ثانوي قبل منح صلاحيات مالك
  // ---------------------------------------------------------------------------
  bot.action(/^promote_confirm_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⚙️ جاري الترقية...')
      const target = ctx.match![1]
      const chatId = getEffectiveChatId(ctx)
      if (!chatId) {
        return ctx.editMessageText('⚠️ تعذر تحديد المحادثة', { parse_mode: 'HTML' })
      }

      // ★ DEFENSE IN DEPTH: تحقق مزدوج من صلاحية المالك
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK promote_confirm: non-super admin ${chatId} tried to confirm promote`)
        return ctx.editMessageText('⛔ غير مصرح — هذا الإجراء للمالك فقط 👑', { parse_mode: 'HTML' })
      }

      // منع ترقية المالك الأساسي
      if (target === String(SUPER_ADMIN_CHAT_ID)) {
        return ctx.editMessageText('⚠️ لا يمكن ترقية المالك الأساسي — هو بالفعل مالك 👑', { parse_mode: 'HTML' })
      }

      const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
      if (!existing) {
        return ctx.editMessageText('⚠️ هذا Chat ID غير مسجل كمشرف', { parse_mode: 'HTML' })
      }
      if (!existing.isActive) {
        return ctx.editMessageText('⚠️ هذا المشرف معطّل، فعّله أولاً', { parse_mode: 'HTML' })
      }
      if (existing.role === 'super') {
        return ctx.editMessageText(
          `ℹ️ هذا المشرف بالفعل مالك 👑\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}`,
          { parse_mode: 'HTML' },
        )
      }

      // تنفيذ الترقية
      await db.botAdmin.update({ where: { chatId: target }, data: { role: 'super' } })
      await refreshAdminCache()

      // ★ AUDIT: تسجيل ترقية مشرف
      auditLog({
        action: 'promote',
        actorId: String(chatId),
        targetType: 'admin',
        targetId: target,
        details: { name: existing.name, fromRole: 'admin', toRole: 'super' },
      })

      await ctx.editMessageText(
        `👑 <b>تمت ترقية المشرف إلى مالك!</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n\n✅ الآن لديه صلاحيات كاملة`,
        { parse_mode: 'HTML' },
      )
      log('callback', `promote_confirm SUCCESS: ${target} promoted to super by ${chatId}`)
    } catch (err: any) {
      log('callback', `ERROR promote_confirm: ${err?.message}`, err)
      try { await ctx.answerCbQuery('❌ حدث خطأ') } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // ❌ إلغاء الترقية (promote_cancel)
  // ---------------------------------------------------------------------------
  bot.action(/^promote_cancel_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('↩️ تم الإلغاء')
      await ctx.editMessageText('✅ تم إلغاء الترقية.', { parse_mode: 'HTML' })
    } catch { /* ignore */ }
  })

  // ---------------------------------------------------------------------------
  // 🛠 تأكيد التخفيض (demote_confirm)
  // ★ SECURITY: يتطلب تأكيد ثانوي قبل سحب صلاحيات المالك
  // ---------------------------------------------------------------------------
  bot.action(/^demote_confirm_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('⚙️ جاري التخفيض...')
      const target = ctx.match![1]
      const chatId = getEffectiveChatId(ctx)
      if (!chatId) {
        return ctx.editMessageText('⚠️ تعذر تحديد المحادثة', { parse_mode: 'HTML' })
      }

      // ★ DEFENSE IN DEPTH: تحقق مزدوج من صلاحية المالك
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK demote_confirm: non-super admin ${chatId} tried to confirm demote`)
        return ctx.editMessageText('⛔ غير مصرح — هذا الإجراء للمالك فقط 👑', { parse_mode: 'HTML' })
      }

      // منع تخفيض المالك الأساسي
      if (target === String(SUPER_ADMIN_CHAT_ID)) {
        return ctx.editMessageText('⚠️ لا يمكن تخفيض المالك الأساسي', { parse_mode: 'HTML' })
      }
      // منع تخفيض النفس
      if (target === String(chatId)) {
        return ctx.editMessageText('⚠️ لا يمكنك تخفيض نفسك', { parse_mode: 'HTML' })
      }

      const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
      if (!existing) {
        return ctx.editMessageText('⚠️ هذا Chat ID غير مسجل كمشرف', { parse_mode: 'HTML' })
      }
      if (existing.role !== 'super') {
        return ctx.editMessageText(
          `ℹ️ هذا المشرف بالفعل مشرف عادي 🛠\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}`,
          { parse_mode: 'HTML' },
        )
      }

      // تنفيذ التخفيض
      await db.botAdmin.update({ where: { chatId: target }, data: { role: 'admin' } })
      await refreshAdminCache()

      // ★ AUDIT: تسجيل تخفيض مشرف
      auditLog({
        action: 'demote',
        actorId: String(chatId),
        targetType: 'admin',
        targetId: target,
        details: { name: existing.name, fromRole: 'super', toRole: 'admin' },
      })

      await ctx.editMessageText(
        `🛠 <b>تم تخفيض المالك إلى مشرف عادي</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n\n🔒 لن يتمكن من إضافة/حذف/ترقية مشرفين`,
        { parse_mode: 'HTML' },
      )
      log('callback', `demote_confirm SUCCESS: ${target} demoted to admin by ${chatId}`)
    } catch (err: any) {
      log('callback', `ERROR demote_confirm: ${err?.message}`, err)
      try { await ctx.answerCbQuery('❌ حدث خطأ') } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // ❌ إلغاء التخفيض (demote_cancel)
  // ---------------------------------------------------------------------------
  bot.action(/^demote_cancel_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('↩️ تم الإلغاء')
      await ctx.editMessageText('✅ تم إلغاء التخفيض.', { parse_mode: 'HTML' })
    } catch { /* ignore */ }
  })

  // ---------------------------------------------------------------------------
  // Catch-all for unmatched callback queries
  // ---------------------------------------------------------------------------
  bot.on('callback_query', async (ctx) => {
    const cbData = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined
    log('callback', `UNHANDLED callback_query data=${cbData}`)
    try {
      await ctx.answerCbQuery('⚠️ هذا الزر غير متاح حالياً')
    } catch { /* ignore */ }
  })
}
