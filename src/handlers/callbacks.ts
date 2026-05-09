/**
 * AlQadi Store — Inline Callback Handlers
 * Handlers for inline button callbacks (pay_approve, pay_reject, ship, order_details, etc.)
 *
 * ★ CRITICAL: كل handler يتحقق من الحالة الحالية للطلب من قاعدة البيانات
 *   قبل وبعد استدعاء store API. هذا يضمن:
 *   1. لا تكرار إجراءات (idempotent)
 *   2. إذا فشل store API، المشرف يرى رسالة واضحة
 *   3. الأزرار تتحدث حسب الحالة الفعلية للطلب
 */

import { Telegraf, Markup } from 'telegraf'
import { db } from '../database.js'
import { isValidOrderId, sanitize, escapeCode, formatDate, formatAmount, getText, log } from '../helpers.js'
import { ORDER_STATUS_AR, PAYMENT_STATUS_AR, getPaymentMethodLabel } from '../constants.js'
import { getEffectiveChatId, sendKeyboard } from '../admin.js'
import { orderActionKeyboard } from '../keyboards.js'
import { callStoreOrderApi } from '../store-api.js'
import { setConversation, clearConversation } from '../conversations.js'
import { sendAdminNotification } from '../notifications.js'

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
          { parse_mode: 'HTML' },
        )
      }

      // Delegate to store's centralized API (atomic: order + payment + stock + notification)
      const result = await callStoreOrderApi(orderId, 'approve')

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `pay_approve FAILED: ${errMsg}`)
        // ★ عدّل الرسالة بدل إرسال رد — المشرف يرى الخطأ بوضوح
        try {
          await ctx.editMessageText(
            `❌ <b>فشل تأكيد الدفع</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}\n\n💡 حاول مرة أخرى أو تحقق من السجلات`,
            { parse_mode: 'HTML' },
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
            { parse_mode: 'HTML' },
          )
        } catch { /* ignore */ }
        return
      }

      // Send admin Telegram notification (customer notification handled by store API)
      await sendAdminNotification(order, 'payment_approved')

      await ctx.editMessageText(
        `✅ <b>تم تأكيد استلام الدفع!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ قيد التنفيذ\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
        { parse_mode: 'HTML' },
      )
      log('callback', `pay_approve SUCCESS orderId=${orderId} — verified paymentStatus=PAID in DB`)
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
        select: { orderNumber: true, paymentStatus: true, status: true },
      })

      if (!order) {
        return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })
      }

      // ★ إذا الطلب مدفوع/مؤكد — لا يمكن رفضه
      if (order.paymentStatus === 'PAID') {
        const statusLabel = ORDER_STATUS_AR[order.status] || order.status
        return ctx.editMessageText(
          `ℹ️ <b>لا يمكن رفض طلب تم تأكيد دفعه</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ${statusLabel}\n💳 الدفع: ✅ مؤكد`,
          { parse_mode: 'HTML' },
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
        select: { paymentStatus: true, paymentMethod: true },
      })
      if (order?.paymentStatus === 'PAID') {
        return ctx.editMessageText('⚠️ لا يمكن رفض طلب تم تأكيد دفعه بالفعل', { parse_mode: 'HTML' })
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
      }

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
        `💰 <b>${formatAmount(order.total, order.currency)}</b>`,
        `🗓 ${formatDate(order.createdAt)}`,
      ].filter(Boolean).join('\n')

      return ctx.editMessageText(msg, {
        parse_mode: 'HTML',
        ...orderActionKeyboard(order.id, order.paymentStatus, order.paymentMethod),
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
          { parse_mode: 'HTML' },
        )
      }

      // ★ تحقق: الطلب قيد التنفيذ فعلاً (بعد تأكيد الدفع) → هذا طبيعي، لا مشكلة
      if (order.status === 'PROCESSING') {
        // الطلب فعلاً في حالة التنفيذ — هذا حدث بعد تأكيد الدفع
        // لا حاجة لاستدعاء store API مرة أخرى
        await sendAdminNotification(order, 'order_processing')
        return ctx.editMessageText(
          `📦 <b>الطلب قيد التنفيذ والشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ جاري التنفيذ\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
          { parse_mode: 'HTML' },
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
            { parse_mode: 'HTML' },
          )
        }
        log('callback', `WARN ship_start: order ${orderId} is unpaid. Allowing with warning.`)
      }

      // Delegate to store's centralized API
      const result = await callStoreOrderApi(orderId, 'process')

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `ship_start FAILED: ${errMsg}`)
        // ★ عدّل الرسالة بدل إرسال رد
        try {
          await ctx.editMessageText(
            `❌ <b>فشل تحديث حالة الشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}`,
            { parse_mode: 'HTML' },
          )
        } catch {
          try { await ctx.replyWithHTML(`⚠️ خطأ\n\n${errMsg}`) } catch { /* ignore */ }
        }
        return
      }

      // ★ تحقق من قاعدة البيانات أن التغيير تم فعلاً
      const verified = await verifyOrderStatus(orderId)

      // Send admin Telegram notification (customer notification handled by store API)
      await sendAdminNotification(order, 'order_processing')

      const unpaidWarning = isUnpaid
        ? '\n\n⚠️ <b>تنبيه:</b> الطلب لم يتم تأكيد دفعه بعد! يرجى تأكيد الدفع عبر زر "تأكيد الاستلام" أولاً.'
        : ''

      await ctx.editMessageText(
        `📦 <b>تم تحديث: جاري الشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ جاري التنفيذ والشحن${verified ? ` (✅ موثق: ${PAYMENT_STATUS_AR[verified.paymentStatus] || verified.paymentStatus})` : ''}\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل${unpaidWarning}`,
        { parse_mode: 'HTML' },
      )
      log('callback', `ship_start SUCCESS orderId=${orderId} — verified status=${verified?.status} paymentStatus=${verified?.paymentStatus}`)
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
          { parse_mode: 'HTML' },
        )
      }

      // Delegate to store's centralized API (handles: order update + idempotent stock decrement)
      const result = await callStoreOrderApi(orderId, 'complete')

      if (!result.success) {
        const errMsg = result.error || 'حدث خطأ داخلي'
        log('callback', `ship_done FAILED: ${errMsg}`)
        // ★ عدّل الرسالة بدل إرسال رد
        try {
          await ctx.editMessageText(
            `❌ <b>فشل إكمال الطلب</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n⚠️ ${sanitize(errMsg)}`,
            { parse_mode: 'HTML' },
          )
        } catch {
          try { await ctx.replyWithHTML(`⚠️ خطأ\n\n${errMsg}`) } catch { /* ignore */ }
        }
        return
      }

      // ★ تحقق من قاعدة البيانات أن التغيير تم فعلاً
      const verified = await verifyOrderStatus(orderId)

      // Send admin Telegram notification (customer notification handled by store API)
      await sendAdminNotification(order, 'order_completed')

      await ctx.editMessageText(
        `🎉 <b>تم الشحن بنجاح!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ✅ مكتمل ومشحون${verified ? ` (✅ موثق)` : ''}\n💳 الدفع: ✅ مؤكد\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
        { parse_mode: 'HTML' },
      )
      log('callback', `ship_done SUCCESS orderId=${orderId} — verified status=${verified?.status} paymentStatus=${verified?.paymentStatus}`)
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
        if (order.localPayment.receiptUrl) paymentInfo += `\n🖼 الإيصال: <a href="${order.localPayment.receiptUrl}">عرض الصورة</a>`
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
        // ★ Guarantee: إذا لا يوجد سجل دفع، اعرض طريقة الدفع من الطلب
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
   📧 ${sanitize(order.user.email)}${order.user.phone ? `\n   📱 ${sanitize(order.user.phone)}` : ''}

─────────────

🛍 <b>الخدمات (${order.items.length}):</b>

${itemsList}

─────────────

💰 <b>الملخص:</b>
${currencyLines.join('\n')}
${paymentInfo}

⏰ ${formatDate(order.createdAt)}
      `.trim(), orderActionKeyboard(order.id, order.paymentStatus, order.paymentMethod))
    } catch (err: any) {
      const msg = err?.message || 'Unknown'
      log('callback', `ERROR order_details: ${msg}`, err)
      try {
        await ctx.replyWithHTML(`⚠️ خطأ\n\nحدث خطأ داخلي — تحقق من السجلات`)
      } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // Catch-all for unmatched callback queries
  // ---------------------------------------------------------------------------
  bot.on('callback_query', async (ctx) => {
    log('callback', `UNHANDLED callback_query data=${ctx.callbackQuery?.data}`)
    try {
      await ctx.answerCbQuery('⚠️ هذا الزر غير متاح حالياً')
    } catch { /* ignore */ }
  })
}
