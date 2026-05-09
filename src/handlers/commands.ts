/**
 * AlQadi Store — Slash Command Handlers
 * Handlers for /start, /help, /orders, /stats, /admins, /settings, /testnotify, etc.
 */

import { Telegraf } from 'telegraf'
import { sanitize, getStoreName, log } from '../helpers.js'
import { isSuperAdmin, sendKeyboard, adminCache, refreshAdminCache } from '../admin.js'
import { sendWebhookOrderNotification } from '../notifications.js'

export function registerCommandHandlers(bot: Telegraf<any>) {

  // ─── /testnotify — إرسال إشعار تجريبي لكل المشرفين (مالك فقط) ────────
  // ★ SECURITY: مقيّد بالمالك فقط — يمنع المشرفين العاديين من إزعاج الآخرين
  bot.command('testnotify', async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return

    // ★ SECURITY: تحقق من صلاحية المالك
    if (!await isSuperAdmin(chatId)) {
      return ctx.reply('⛔ هذا الأمر متاح للمالك فقط 👑')
    }

    try {
      // ★ حدّث الكاش أول — يضمن أن المشرفين الجدد يشملون
      await refreshAdminCache()
      const targetChatIds = Array.from(adminCache)

      if (targetChatIds.length === 0) {
        return ctx.reply('⚠️ لا يوجد مشرفين نشطين في النظام')
      }

      await ctx.reply(`🔔 جاري إرسال إشعار تجريبي لـ ${targetChatIds.length} مشرف...`)

      let sentCount = 0
      let failCount = 0
      const results: string[] = []

      for (const targetId of targetChatIds) {
        try {
          await bot.telegram.sendMessage(
            targetId,
            `🔔 <b>إشعار تجريبي — النظام يعمل!</b>\n\n✅ تم إرسال هذا الإشعار بنجاح\n👥 إجمالي المشرفين: ${targetChatIds.length}\n⏰ ${new Date().toISOString()}\n\n💡 إذا وصلك هذا الإشعار، فنظام الإشعارات يعمل بشكل صحيح.`,
            { parse_mode: 'HTML' }
          )
          sentCount++
          results.push(`✅ ${targetId}`)
        } catch (err: any) {
          failCount++
          results.push(`❌ ${targetId} — فشل الإرسال`)
          log('testnotify', `FAILED to send to ${targetId}:`, err?.message)
        }
      }

      // أظهر النتيجة لمن أرسل الأمر
      const summary = `📊 <b>نتيجة الاختبار:</b>\n\n✅ نجح: ${sentCount}\n❌ فشل: ${failCount}\n👥 الإجمالي: ${targetChatIds.length}\n\n${results.join('\n')}`
      await ctx.reply(summary, { parse_mode: 'HTML' })

      log('testnotify', `Test notification: ${sentCount}/${targetChatIds} sent successfully`)
    } catch (err: any) {
      log('testnotify', `ERROR: ${err?.message}`)
      await ctx.reply('❌ فشل إرسال الإشعار التجريبي — تحقق من السجلات')
    }
  })

  bot.start(async (ctx) => {
    const firstName = ctx.from?.first_name || ''
    await ctx.reply(
      `مرحباً ${firstName}! 👋\n\nأنا بوت متجر القاضي للمسؤولين.\nاستخدم الأزرار أدناه للتنقل.`,
      { parse_mode: 'HTML' }
    )

    const chatId = ctx.chat?.id
    if (!chatId) return
    const role = await isSuperAdmin(chatId) ? '👑 مالك' : '🔧 مشرف'
    const storeName = await getStoreName()
    return sendKeyboard(ctx, `
🏪 <b>بوت إدارة ${sanitize(storeName)}</b>

صلاحيتك: ${role}

📋 <b>استخدم الأزرار بالأسفل للتنقل:</b>

📬 الطلبات المعلقة
📊 الإحصائيات
👥 المشرفين
⚙️ الإعدادات
📖 الدليل

🔔 <b>إشعارات تلقائية:</b> يصلك إشعار فوري عند تأكيد الدفع أو رفع إيصال

🔒 للوصول: المشرفون فقط
    `.trim())
  })

  const SLASH_MSG = '💡 استخدم الأزرار بالأسفل مباشرة للتنقل!\nأو أرسل /start لإعادة عرض لوحة التحكم'

  bot.help(async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('orders', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('stats', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('admins', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('settings', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('promote', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('demote', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('addadmin', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
  bot.command('removeadmin', async (ctx) => sendKeyboard(ctx, SLASH_MSG))
}
