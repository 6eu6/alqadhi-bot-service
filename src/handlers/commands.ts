/**
 * AlQadi Store — Slash Command Handlers
 * Handlers for /start, /help, /orders, /stats, /admins, /settings, /testnotify, etc.
 */

import { Telegraf } from 'telegraf'
import { sanitize, getStoreName, log } from '../helpers.js'
import { isSuperAdmin, sendKeyboard } from '../admin.js'
import { sendWebhookOrderNotification } from '../notifications.js'

export function registerCommandHandlers(bot: Telegraf<any>) {

  // ─── /testnotify — إرسال إشعار تجريبي للتحقق من عمل الإشعارات ─────────
  bot.command('testnotify', async (ctx) => {
    const chatId = ctx.chat?.id
    if (!chatId) return

    try {
      await ctx.reply('🔔 جاري إرسال إشعار تجريبي...')

      // إرسال رسالة تجريبية مباشرة
      await bot.telegram.sendMessage(
        String(chatId),
        `🔔 <b>إشعار تجريبي — النظام يعمل!</b>\n\n✅ تم إرسال هذا الإشعار بنجاح\n📡 البوت متصل ويعمل\n⏰ ${new Date().toISOString()}\n\n💡 إذا وصلك هذا الإشعار، فنظام الإشعارات يعمل بشكل صحيح.`,
        { parse_mode: 'HTML' }
      )

      log('testnotify', `Test notification sent to chat ${chatId}`)
    } catch (err: any) {
      log('testnotify', `ERROR: ${err?.message}`, err)
      await ctx.reply(`❌ فشل إرسال الإشعار التجريبي: ${err?.message || 'خطأ غير معروف'}`)
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
