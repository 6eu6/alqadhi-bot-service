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
import { auditLog } from '../audit.js'
// ★ sendAdminNotification تم إزالته — إجراءات المشرف لا توصل إشعارات لبقية المشرفين

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
            id: true, orderNumber: true, status: true,
            user: { select: { name: true, email: true, country: true, phone: true } },
            total: true, currency: true,
            paymentMethod: true, paymentStatus: true,
          },
        })
        if (!order) return sendKeyboard(ctx, '⚠️ الطلب غير موجود')

        const orderSnapshot = {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          user: { name: order.user.name, email: order.user.email, phone: order.user.phone, country: order.user.country },
          total: order.total,
          currency: order.currency,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
        }

        // Delegate to store's centralized API (handles: order + payments + coupon cleanup + notification)
        // ★ حد الطول + إزالة أحرف التحكم — منع حقن في إشعارات البريد
        const cleanReason = text.slice(0, 500).replace(/[\x00-\x1f]/g, '')
        const result = await callStoreOrderApi(conv.orderId!, 'reject', { reason: cleanReason })

        if (!result.success) {
          const errMsg = result.error || 'حدث خطأ داخلي'
          log('bot', `ERROR reject order via API: ${errMsg}`)
          return sendKeyboard(ctx, `⚠️ خطأ في رفض الطلب\n\n${errMsg}`)
        }

        // ★ لا إشعار للمشرفين الآخرين — المشرف الفعّال شاف النتيجة عبر sendKeyboard()
        // المشرفين الآخرين يقدرون يضغطون أي زر في رسالتهم ويشوفون الحالة الحالية

        // ★ AUDIT: تسجيل رفض الدفع
        auditLog({
          action: 'reject_payment',
          actorId: cid,
          targetType: 'order',
          targetId: conv.orderId!,
          details: { orderNumber: orderSnapshot.orderNumber, reason: cleanReason },
        })

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
    // إضافة مشرف (add_admin) — ★ يطلب صلاحية مالك
    // ---------------------------------------------------------------
    if (conv.type === 'add_admin') {
      // ★ DEFENSE IN DEPTH: إعادة التحقق من صلاحية المالك
      // حتى لو keyboard.ts هو من بدأ المحادثة، نتأكد هنا أيضاً
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK add_admin: non-super admin ${cid} tried to add admin`)
        return sendKeyboard(ctx, '⛔ غير مصرح — هذا الإجراء للمالك فقط 👑')
      }

      const parts = text.trim().slice(0, 500).split(/\s+/)
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

        // ★ AUDIT: تسجيل إضافة مشرف
        auditLog({
          action: 'add_admin',
          actorId: cid,
          targetType: 'admin',
          targetId: target,
          details: { name: adminName },
        })

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
    // حذف مشرف (remove_admin) — ★ يطلب صلاحية مالك
    // ---------------------------------------------------------------
    if (conv.type === 'remove_admin') {
      // ★ DEFENSE IN DEPTH: إعادة التحقق من صلاحية المالك
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK remove_admin: non-super admin ${cid} tried to remove admin`)
        return sendKeyboard(ctx, '⛔ غير مصرح — هذا الإجراء للمالك فقط 👑')
      }

      const target = text.trim().slice(0, 500)
      if (!/^\d+$/.test(target)) return sendKeyboard(ctx, '⚠️ Chat ID يجب أن يكون أرقام فقط')
      if (target === String(SUPER_ADMIN_CHAT_ID)) return sendKeyboard(ctx, '⚠️ لا يمكنك حذف المالك الأساسي')
      if (target === cid) return sendKeyboard(ctx, '⚠️ لا يمكنك حذف نفسك')

      try {
        const existing = await db.botAdmin.findUnique({ where: { chatId: target } })
        if (!existing) return sendKeyboard(ctx, '⚠️ هذا Chat ID غير مسجل كمشرف')
        if (existing.role === 'super') return sendKeyboard(ctx, '⚠️ لا يمكنك حذف مالك (super admin)\nاستخدم الأمر فقط للمشرفين العاديين')

        await db.botAdmin.update({ where: { chatId: target }, data: { isActive: false } })
        await refreshAdminCache()

        // ★ AUDIT: تسجيل حذف مشرف
        auditLog({
          action: 'remove_admin',
          actorId: cid,
          targetType: 'admin',
          targetId: target,
          details: { name: existing.name },
        })

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
    // ترقية مشرف (promote) — ★ يطلب صلاحية مالك
    // ---------------------------------------------------------------
    if (conv.type === 'promote') {
      // ★ DEFENSE IN DEPTH: إعادة التحقق من صلاحية المالك
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK promote: non-super admin ${cid} tried to promote`)
        return sendKeyboard(ctx, '⛔ غير مصرح — هذا الإجراء للمالك فقط 👑')
      }

      const target = text.trim().slice(0, 500)
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

        // ★ AUDIT: تسجيل ترقية مشرف
        auditLog({
          action: 'promote',
          actorId: cid,
          targetType: 'admin',
          targetId: target,
          details: { name: existing.name, fromRole: 'admin', toRole: 'super' },
        })

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
    // تخفيض مشرف (demote) — ★ يطلب صلاحية مالك
    // ---------------------------------------------------------------
    if (conv.type === 'demote') {
      // ★ DEFENSE IN DEPTH: إعادة التحقق من صلاحية المالك
      if (!await isSuperAdmin(chatId)) {
        log('security', `BLOCK demote: non-super admin ${cid} tried to demote`)
        return sendKeyboard(ctx, '⛔ غير مصرح — هذا الإجراء للمالك فقط 👑')
      }

      const target = text.trim().slice(0, 500)
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

        // ★ AUDIT: تسجيل تخفيض مشرف
        auditLog({
          action: 'demote',
          actorId: cid,
          targetType: 'admin',
          targetId: target,
          details: { name: existing.name, fromRole: 'super', toRole: 'admin' },
        })

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
