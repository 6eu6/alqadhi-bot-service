/**
 * AlQadi Store — Text/Conversation Handler
 * Multi-step conversation flows for reject_reason, add_admin, remove_admin, promote, demote.
 */

import { Telegraf } from 'telegraf'
import { db } from '../database.js'
import { sanitize, escapeCode, log } from '../helpers.js'
import { SUPER_ADMIN_CHAT_ID } from '../config.js'
import { isSuperAdmin, refreshAdminCache, sendKeyboard } from '../admin.js'
import { callStoreOrderApi } from '../store-api.js'
import { conversations, clearConversation } from '../conversations.js'
import { sendAdminNotification } from '../notifications.js'

export function registerTextHandler(bot: Telegraf<any>) {
  bot.on('text', async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (!chatId) return next()

    const cid = String(chatId)
    const conv = conversations.get(cid)

    // No active conversation → pass to keyboard/command handlers
    if (!conv) return next()

    const text = ctx.message?.text?.trim()
    if (!text) return ctx.reply('⚠️ الرجاء كتابة البيانات المطلوبة')

    // Clear conversation state
    clearConversation(cid)

    // ---------------------------------------------------------------
    // رفض الدفع — يطلب سبب ثم يرفض الطلب (soft-delete) (reject_reason)
    // ---------------------------------------------------------------
    if (conv.type === 'reject_reason') {
      try {
        const order = await db.order.findUnique({
          where: { id: conv.orderId },
          select: {
            id: true, orderNumber: true,
            user: { select: { name: true, email: true, country: true, phone: true } },
            total: true, currency: true,
            paymentMethod: true, paymentStatus: true,
          },
        })
        if (!order) return sendKeyboard(ctx, '⚠️ الطلب غير موجود')

        const orderSnapshot = {
          id: order.id,
          orderNumber: order.orderNumber,
          user: { name: order.user.name, email: order.user.email, phone: order.user.phone, country: order.user.country },
          total: order.total,
          currency: order.currency,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
        }

        // Delegate to store's centralized API (handles: order + payments + coupon cleanup + notification)
        const result = await callStoreOrderApi(conv.orderId!, 'reject', { reason: text })

        if (!result.success) {
          const errMsg = result.error || 'حدث خطأ داخلي'
          log('bot', `ERROR reject order via API: ${errMsg}`)
          return sendKeyboard(ctx, `⚠️ خطأ في رفض الطلب\n\n${errMsg}`)
        }

        // Send admin Telegram notification (customer notification handled by store API)
        await sendAdminNotification(orderSnapshot, 'payment_rejected', text)

        return sendKeyboard(ctx,
          `🚫 <b>تم رفض الطلب</b>\n\n📋 <code>${escapeCode(orderSnapshot.orderNumber)}</code>\n👤 العميل: ${sanitize(orderSnapshot.user.name)}\n📝 السبب: ${sanitize(text)}\n\n📧 تم إبلاغ العميل عبر البريد ✉️`
        )
      } catch (err: any) {
        const msg = err?.message || 'Unknown'
        log('bot', `ERROR reject order: ${msg}`, err)
        return sendKeyboard(ctx, `⚠️ خطأ في رفض الطلب\n\nحدث خطأ داخلي — تحقق من السجلات`)
      }
    }

    // ---------------------------------------------------------------
    // إضافة مشرف (add_admin)
    // ---------------------------------------------------------------
    if (conv.type === 'add_admin') {
      const parts = text.trim().split(/\s+/)
      if (parts.length < 1) return sendKeyboard(ctx, '⚠️ أرسل Chat ID على الأقل')

      const target = parts[0].trim()
      const adminName = parts.slice(1).join(' ').trim() || null
      if (!/^\d+$/.test(target)) return sendKeyboard(ctx, '⚠️ Chat ID يجب أن يكون أرقام فقط')
      if (target === cid) return sendKeyboard(ctx, '⚠️ لا يمكنك إضافة نفسك')

      try {
        const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
        if (existing) {
          if (existing.isActive) {
            return sendKeyboard(ctx,
              `⚠️ هذا Chat ID مسجل مسبقاً!\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n🔧 الصلاحية: ${existing.role}`
            )
          }
          await db.botAdmin.update({
            where: { chatId: target },
            data: { isActive: true, name: adminName || existing.name, addedBy: cid, addedAt: new Date() },
          })
          await refreshAdminCache()
          return sendKeyboard(ctx,
            `✅ <b>تم تفعيل المشرف</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${adminName ? sanitize(adminName) : 'بدون اسم'}\n\n🔔 الآن يمكنه استخدام البوت`
          )
        }
        await db.botAdmin.create({
          data: { chatId: target, name: adminName, role: 'admin', addedBy: cid, isActive: true },
        })
        await refreshAdminCache()
        return sendKeyboard(ctx,
          `✅ <b>تم إضافة مشرف جديد!</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${adminName ? sanitize(adminName) : 'بدون اسم'}\n🔧 الصلاحية: مشرف\n\n🔔 أخبره يرسل /start للبوت`
        )
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        log('bot', `ERROR add_admin: ${msg}`, err)
        return sendKeyboard(ctx, `⚠️ خطأ في إضافة المشرف\n\nحدث خطأ داخلي — تحقق من السجلات`)
      }
    }

    // ---------------------------------------------------------------
    // حذف مشرف (remove_admin)
    // ---------------------------------------------------------------
    if (conv.type === 'remove_admin') {
      const target = text.trim()
      if (!/^\d+$/.test(target)) return sendKeyboard(ctx, '⚠️ Chat ID يجب أن يكون أرقام فقط')
      if (target === String(SUPER_ADMIN_CHAT_ID)) return sendKeyboard(ctx, '⚠️ لا يمكنك حذف المالك الأساسي')
      if (target === cid) return sendKeyboard(ctx, '⚠️ لا يمكنك حذف نفسك')

      try {
        const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
        if (!existing) return sendKeyboard(ctx, '⚠️ هذا Chat ID غير مسجل كمشرف')
        if (existing.role === 'super') return sendKeyboard(ctx, '⚠️ لا يمكنك حذف مالك (super admin)\nاستخدم الأمر فقط للمشرفين العاديين')

        await db.botAdmin.update({ where: { chatId: target }, data: { isActive: false } })
        await refreshAdminCache()
        return sendKeyboard(ctx,
          `✅ <b>تم حذف المشرف</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n\n🔒 لن يتمكن من استخدام البوت بعد الآن`
        )
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        log('bot', `ERROR remove_admin: ${msg}`, err)
        return sendKeyboard(ctx, `⚠️ خطأ في حذف المشرف\n\nحدث خطأ داخلي — تحقق من السجلات`)
      }
    }

    // ---------------------------------------------------------------
    // ترقية مشرف (promote)
    // ---------------------------------------------------------------
    if (conv.type === 'promote') {
      const target = text.trim()
      if (target === cid) return sendKeyboard(ctx, '⚠️ أنت بالفعل مالك')
      if (!/^\d+$/.test(target)) return sendKeyboard(ctx, '⚠️ Chat ID يجب أن يكون أرقام فقط')

      try {
        const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
        if (!existing) return sendKeyboard(ctx, '⚠️ هذا Chat ID غير مسجل كمشرف')
        if (!existing.isActive) return sendKeyboard(ctx, '⚠️ هذا المشرف معطّل، فعّله أولاً')
        if (existing.role === 'super') {
          return sendKeyboard(ctx,
            `ℹ️ هذا المشرف بالفعل مالك 👑\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}`
          )
        }
        await db.botAdmin.update({ where: { chatId: target }, data: { role: 'super' } })
        await refreshAdminCache()
        return sendKeyboard(ctx,
          `👑 <b>تمت ترقية المشرف إلى مالك!</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n\n✅ الآن لديه صلاحيات كاملة`
        )
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        log('bot', `ERROR promote: ${msg}`, err)
        return sendKeyboard(ctx, `⚠️ خطأ في ترقية المشرف\n\nحدث خطأ داخلي — تحقق من السجلات`)
      }
    }

    // ---------------------------------------------------------------
    // تخفيض مشرف (demote)
    // ---------------------------------------------------------------
    if (conv.type === 'demote') {
      const target = text.trim()
      if (target === cid) return sendKeyboard(ctx, '⚠️ لا يمكنك تخفيض نفسك')
      if (target === String(SUPER_ADMIN_CHAT_ID)) return sendKeyboard(ctx, '⚠️ لا يمكنك تخفيض المالك الأساسي')
      if (!/^\d+$/.test(target)) return sendKeyboard(ctx, '⚠️ Chat ID يجب أن يكون أرقام فقط')

      try {
        const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
        if (!existing) return sendKeyboard(ctx, '⚠️ هذا Chat ID غير مسجل كمشرف')
        if (existing.role !== 'super') {
          return sendKeyboard(ctx,
            `ℹ️ هذا المشرف بالفعل مشرف عادي 🛠\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}`
          )
        }
        await db.botAdmin.update({ where: { chatId: target }, data: { role: 'admin' } })
        await refreshAdminCache()
        return sendKeyboard(ctx,
          `🛠 <b>تم تخفيض المالك إلى مشرف عادي</b>\n\n🔢 <code>${escapeCode(target)}</code>\n👤 ${existing.name ? sanitize(existing.name) : 'بدون اسم'}\n\n🔒 لن يتمكن من إضافة/حذف مشرفين`
        )
      } catch (err: any) {
        const msg = err?.message || 'Unknown error'
        log('bot', `ERROR demote: ${msg}`, err)
        return sendKeyboard(ctx, `⚠️ خطأ في تخفيض المشرف\n\nحدث خطأ داخلي — تحقق من السجلات`)
      }
    }

    return next()
  })
}
