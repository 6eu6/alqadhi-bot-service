/**
 * AlQadi Store — Admin Authorization Middleware
 * Checks if the user is an authorized admin before allowing access.
 */

import { Telegraf } from 'telegraf'
import { log } from '../helpers.js'
import { getEffectiveChatId, isAdmin } from '../admin.js'

export function registerAuthMiddleware(bot: Telegraf<any>) {
  bot.use(async (ctx, next) => {
    // For callback queries, ctx.chat may not always be populated in Telegraf v4.
    // We need to check the callback query's message chat instead.
    const chatId = getEffectiveChatId(ctx)

    if (!chatId) {
      // No chat context (e.g. inline query, or callback from a deleted message)
      // For callback queries, we still need to answer them to prevent the spinner
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery('⚠️ تعذر معالجة الطلب')
        } catch { /* ignore */ }
      }
      return
    }

    const authorized = await isAdmin(chatId)
    if (!authorized) {
      log('auth', `DENIED chatId=${chatId} from=${ctx.from?.id}`)
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCbQuery('⛔ غير مصرح')
        } catch { /* ignore */ }
        return
      }
      return ctx.reply(
        '⛔ عذراً، هذا البوت مخصص للمسؤولين فقط.\nللتواصل مع الدعم، يرجى استخدام صفحة الاتصال في الموقع.',
      )
    }

    return next()
  })
}
