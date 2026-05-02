/**
 * AlQadi Store — Telegram Bot Service
 * خدمة بوت تيليجرام لمتجر القاضي
 *
 * Standalone mini-service for admin order management via Telegram.
 * Uses Telegraf v4 with long-polling and Prisma for database access.
 * Supports multiple admins with super/admin roles.
 *
 * UI: ReplyKeyboardMarkup (fixed keyboard) + inline action buttons
 *
 * Features:
 *  - Payment approve/reject with stock management
 *  - Shipment tracking with idempotent stock decrement
 *  - Multi-step conversation flows (reject reason, admin management)
 *  - Reply keyboard with admin action buttons
 *  - Inline Telegram notifications to admin chat
 *  - Comprehensive error handling and process stability
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

// ESM-compatible __dirname polyfill
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { Telegraf, Context, Markup } from 'telegraf'
import { PrismaClient } from '@prisma/client'

// =============================================================================
// §1  ENVIRONMENT & CONSTANTS
// =============================================================================

const LOCAL_ENV_PATH = join(__dirname, '.env') // Local .env for standalone deployment

// ★ SECURITY: Only load the environment variables the bot actually needs.
const BOT_REQUIRED_KEYS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ADMIN_CHAT_ID',
  'SUPABASE_DATABASE_URL',
  'SUPABASE_DIRECT_URL',
  'INTERNAL_API_SECRET',
  'API_BASE_URL',
  'NODE_ENV',
])

try {
  const envContent = readFileSync(LOCAL_ENV_PATH, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // ★ Only set if the key is in the whitelist AND not already set by the system
    if (BOT_REQUIRED_KEYS.has(key) && !process.env[key]) {
      process.env[key] = value
    }
  }
  console.log('[env] Loaded environment from local .env (filtered: only bot-required keys)')
} catch (err) {
  // In production (Railway/Render), env vars come from the platform directly
  console.log('[env] No local .env found — using platform environment variables')
}

// Set DATABASE_URL for Prisma (use transaction-mode pooler for more connections)
process.env.DATABASE_URL = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || ''

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const SUPER_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID
const SERVICE_PORT = 3099
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000'

if (!BOT_TOKEN) {
  console.error('[FATAL] TELEGRAM_BOT_TOKEN is not configured')
  process.exit(1)
}

if (!SUPER_ADMIN_CHAT_ID) {
  console.error('[FATAL] TELEGRAM_ADMIN_CHAT_ID is not configured')
  process.exit(1)
}

// =============================================================================
// §2  PRISMA CLIENT
// =============================================================================

// Add connection_limit for Supabase pooler to avoid MaxClientsInSessionMode
let botDbUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || ''
if (botDbUrl && !botDbUrl.includes('connection_limit')) {
  const separator = botDbUrl.includes('?') ? '&' : '?'
  botDbUrl = `${botDbUrl}${separator}connection_limit=5&pool_timeout=20`
}

const db = new PrismaClient({
  log: ['error'],
  datasources: {
    db: {
      url: botDbUrl,
    },
  },
})

// =============================================================================
// §3  HELPERS
// =============================================================================

/**
 * Validate that a string looks like a Prisma CUID (used for Order IDs).
 * Prisma CUIDs: start with 'c' + 24+ lowercase alphanumeric chars (e.g. "clxxxx...").
 * This is a defense-in-depth measure — even though Prisma parameterizes queries
 * (making SQL injection impossible), rejecting obviously malformed IDs early
 * prevents unnecessary DB queries and logs suspicious activity.
 */
const CUID_RE = /^c[a-z0-9]{8,30}$/
function isValidOrderId(id: string): boolean {
  return CUID_RE.test(id)
}

/** Sanitize text to prevent HTML injection in Telegram messages */
function sanitize(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Safely escape text for <code> blocks */
function escapeCode(text: string): string {
  return sanitize(text)
}

/** Format a date in Arabic locale */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('ar-SA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** Format currency amount (handles Prisma Decimal, number, and bigint) */
function formatAmount(amount: any, currency: string): string {
  const num = typeof amount === 'bigint' ? Number(amount) : Number(amount)
  return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

/** Extract text from bilingual JSON fields */
function getText(val: any, fallback = '—'): string {
  if (!val) return fallback
  if (typeof val === 'string') return val
  if (typeof val === 'object') return val.ar || val.en || fallback
  return fallback
}

/** Log with timestamp prefix */
function log(tag: string, ...args: any[]) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}][${tag}]`, ...args)
}

/** Fetch store name from settings (with in-memory cache) */
let _storeNameCache: { value: string; expires: number } | null = null
async function getStoreName(): Promise<string> {
  const now = Date.now()
  if (_storeNameCache && _storeNameCache.expires > now) return _storeNameCache.value
  try {
    const nameSetting = await db.setting.findUnique({ where: { key: 'siteName' } })
    if (nameSetting?.value) {
      const v = typeof nameSetting.value === 'string'
        ? nameSetting.value
        : (nameSetting.value as Record<string, unknown>).ar || (nameSetting.value as Record<string, unknown>).en || ''
      if (v) {
        _storeNameCache = { value: String(v), expires: now + 60_000 }
        return _storeNameCache.value
      }
    }
  } catch (err) {
    log('store', 'WARN Failed to fetch store name from DB:', err)
  }
  return 'متجر القاضي'
}

// =============================================================================
// §4  CONSTANTS — Status Labels, Event Meta, Keyboards
// =============================================================================

// Order status labels in Arabic
const ORDER_STATUS_AR: Record<string, string> = {
  PENDING: '⏳ قيد الانتظار',
  PROCESSING: '⚙️ قيد التنفيذ',
  COMPLETED: '✅ مكتمل',
  CANCELLED: '❌ ملغي',
  REJECTED: '🚫 مرفوض',
}

// Payment status labels in Arabic
const PAYMENT_STATUS_AR: Record<string, string> = {
  PENDING: '⏳ في الانتظار',
  PAID: '✅ مدفوع',
  FAILED: '❌ فشل',
  REFUNDED: '↩️ مسترجع',
  APPROVED: '✅ مقبول',
  REJECTED: '🚫 مرفوض',
}

// Order event types for notifications
type OrderEvent = 'payment_approved' | 'payment_rejected' | 'order_processing' | 'order_completed' | 'order_cancelled'

const EVENT_META: Record<OrderEvent, { emoji: string; label: string }> = {
  payment_approved:  { emoji: '✅', label: 'تمت الموافقة على الدفع' },
  payment_rejected:  { emoji: '❌', label: 'تم رفض الدفع' },
  order_processing:  { emoji: '⚙️', label: 'جاري التنفيذ والشحن' },
  order_completed:   { emoji: '🎉', label: 'تم تنفيذ الطلب وتسليمه' },
  order_cancelled:   { emoji: '🚫', label: 'تم إلغاء الطلب' },
}

// Reply keyboard button labels
const KB = {
  ORDERS: '📬 الطلبات المعلقة',
  STATS: '📊 الإحصائيات',
  ADMINS: '👥 المشرفين',
  SETTINGS: '⚙️ الإعدادات',
  HELP: '📖 دليل الاستخدام',
  ADD_ADMIN: '➕ إضافة مشرف',
  REMOVE_ADMIN: '❌ حذف مشرف',
  PROMOTE: '⬆️ ترقية مشرف',
  DEMOTE: '⬇️ تخفيض مشرف',
} as const

// Regular admin keyboard
const adminKeyboard = Markup.keyboard([
  [KB.ORDERS, KB.STATS],
  [KB.ADMINS, KB.SETTINGS],
  [KB.HELP],
]).resize(true).oneTime(false)

// Super admin keyboard (includes admin management)
const superKeyboard = Markup.keyboard([
  [KB.ORDERS, KB.STATS],
  [KB.ADMINS, KB.SETTINGS],
  [KB.ADD_ADMIN, KB.REMOVE_ADMIN],
  [KB.PROMOTE, KB.DEMOTE],
  [KB.HELP],
]).resize(true).oneTime(false)

/** Generate inline keyboard for an order based on its payment status and method */
function orderActionKeyboard(orderId: string, paymentStatus?: string, paymentMethod?: string | null) {
  const buttons: any[][] = []
  const isStripe = paymentMethod === 'STRIPE'

  if (paymentStatus === 'PENDING' && !isStripe) {
    buttons.push([
      Markup.button.callback('✅ تأكيد الاستلام', `pay_approve_${orderId}`),
      Markup.button.callback('❌ رفض الدفع', `pay_reject_${orderId}`),
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
function buildNotificationButtons(
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

// =============================================================================
// §5  ADMIN MANAGEMENT — DB-backed, cached
// =============================================================================

/** In-memory cache of admin chat IDs — refreshed every 5 minutes */
let adminCache: Set<string> = new Set()
let superAdminCache: Set<string> = new Set()
let lastCacheRefresh = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function refreshAdminCache(): Promise<void> {
  try {
    const admins = await db.botAdmin.findMany({
      where: { isActive: true },
      select: { chatId: true, role: true },
    })

    adminCache = new Set(admins.map(a => a.chatId))
    superAdminCache = new Set([
      String(SUPER_ADMIN_CHAT_ID),
      ...admins.filter(a => a.role === 'super').map(a => a.chatId),
    ])

    // Always ensure super admin from env is included
    if (!adminCache.has(String(SUPER_ADMIN_CHAT_ID))) {
      adminCache.add(String(SUPER_ADMIN_CHAT_ID))
    }

    lastCacheRefresh = Date.now()
    log('admins', `Cache refreshed: ${adminCache.size} admins (${superAdminCache.size} super)`)
  } catch (err) {
    log('admins', 'ERROR Failed to refresh cache:', err)
    // Fallback: at least the env super admin
    adminCache = new Set([String(SUPER_ADMIN_CHAT_ID)])
    superAdminCache = new Set([String(SUPER_ADMIN_CHAT_ID)])
  }
}

async function isAdmin(chatId: number | string): Promise<boolean> {
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    await refreshAdminCache()
  }
  return adminCache.has(String(chatId))
}

async function isSuperAdmin(chatId: number | string): Promise<boolean> {
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    await refreshAdminCache()
  }
  return superAdminCache.has(String(chatId))
}

async function ensureSuperAdmin(): Promise<void> {
  const chatId = String(SUPER_ADMIN_CHAT_ID)
  try {
    const existing = await db.botAdmin.findUnique({ where: { chatId } })
    if (!existing) {
      await db.botAdmin.create({
        data: { chatId, name: 'Super Admin (ENV)', role: 'super', isActive: true },
      })
      log('admins', `Created super admin record for ${chatId}`)
    }
  } catch (err) {
    log('admins', 'ERROR Failed to ensure super admin:', err)
  }
}

/** Get the effective chat ID from any context (message, callback_query, etc.) */
function getEffectiveChatId(ctx: Context): number | undefined {
  // For messages (including commands and text)
  if (ctx.chat?.id) return ctx.chat.id
  // For callback_query — ctx.chat may not be populated in all Telegraf versions
  // so we fall back to the message that contains the inline keyboard
  if (ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message) {
    const msg = ctx.callbackQuery.message as any
    if (msg.chat?.id) return msg.chat.id
  }
  return undefined
}

/** Send the appropriate keyboard based on admin role */
async function sendKeyboard(ctx: Context, text: string, extra?: any) {
  const chatId = ctx.chat?.id
  if (!chatId) return ctx.replyWithHTML(text, extra)
  const isSuper = await isSuperAdmin(chatId)
  const kb = isSuper ? superKeyboard : adminKeyboard
  return ctx.replyWithHTML(text, { ...kb, ...extra })
}

// =============================================================================
// §6  CONVERSATION STATE MANAGEMENT
// =============================================================================

type ConversationType = 'reject_reason' | 'reject_confirm' | 'add_admin' | 'remove_admin' | 'promote' | 'demote'

interface ConversationState {
  type: ConversationType
  orderId?: string
  paymentStatus?: string
  paymentMethod?: string | null
  timeout: NodeJS.Timeout
}

const conversations = new Map<string, ConversationState>()

function setConversation(chatId: string, state: ConversationState) {
  const existing = conversations.get(chatId)
  if (existing?.timeout) clearTimeout(existing.timeout)
  conversations.set(chatId, state)
}

function clearConversation(chatId: string) {
  const existing = conversations.get(chatId)
  if (existing?.timeout) clearTimeout(existing.timeout)
  conversations.delete(chatId)
}

// =============================================================================
// §7  STOCK MANAGEMENT
// =============================================================================

/**
 * Atomically decrement stock for all items in an order.
 * Uses `where: { stock: { not: null, gte: quantity } }` to ensure
 * stock is only decremented for prices that have stock limits and sufficient quantity.
 */
async function decrementOrderStock(orderId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const orderItems = await tx.orderItem.findMany({
      where: { orderId },
      select: { priceId: true, quantity: true },
    })
    for (const item of orderItems) {
      await tx.servicePrice.updateMany({
        where: { id: item.priceId, stock: { not: null, gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      })
    }
  })
}

// =============================================================================
// §8  NOTIFICATION FUNCTIONS
// =============================================================================

/**
 * Send an inline Telegram notification to the admin chat about an order event.
 * Uses bot.telegram.sendMessage() directly.
 */
async function sendAdminNotification(
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
    const targetChatIds = adminCache.size > 0
      ? Array.from(adminCache)
      : [String(SUPER_ADMIN_CHAT_ID)]

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
 * Trigger customer notification (email + in-app) by calling the Next.js internal API.
 * Errors are logged but never thrown — notification failure shouldn't break the bot action.
 */
async function triggerCustomerNotification(
  orderId: string,
  event: OrderEvent,
  reason?: string,
): Promise<void> {
  try {
    if (!INTERNAL_SECRET) {
      log('notify', 'WARN No INTERNAL_API_SECRET configured — skipping customer notification')
      return
    }

    const body: Record<string, string> = { orderId, event }
    if (reason) body.reason = reason

    const response = await fetch(`${API_BASE_URL}/api/internal/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      log('notify', `ERROR Customer notification API failed: ${response.status} ${errorText}`)
    } else {
      log('notify', `Customer notification triggered for ${event} (order: ${orderId})`)
    }
  } catch (err) {
    log('notify', 'ERROR Failed to trigger customer notification:', err)
  }
}

// =============================================================================
// §9  BOT INITIALIZATION
// =============================================================================

const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    // Increase API retry timeouts for reliability
    apiRoot: 'https://api.telegram.org/bot',
  },
})

// =============================================================================
// §10 MIDDLEWARE — Logging + Auth
// =============================================================================

// --- 10a. Update Logging Middleware (FIRST — logs everything) ---
bot.use(async (ctx, next) => {
  const startTime = Date.now()

  // Determine update type
  let updateType = 'unknown'
  if (ctx.updateType) updateType = ctx.updateType
  if (ctx.update?.message) updateType = `message:${ctx.update.message.text ? 'text' : ctx.update.message.photo ? 'photo' : 'other'}`
  if (ctx.update?.callback_query) updateType = `callback_query`
  if (ctx.update?.inline_query) updateType = `inline_query`

  const chatId = getEffectiveChatId(ctx)
  const fromId = ctx.from?.id

  log('update', `[${updateType}] from=${fromId} chat=${chatId || 'N/A'}`)

  // Execute the handler chain
  await next()

  const elapsed = Date.now() - startTime
  if (elapsed > 3000) {
    log('update', `SLOW [${updateType}] took ${elapsed}ms`)
  }
})

// --- 10b. Admin Authorization Middleware ---
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

// =============================================================================
// §11 REPLY KEYBOARD HANDLERS
// =============================================================================

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
            paymentInfo += `\n    ${sanitize(label)}: ${sanitize(String(val))}`
          }
        }
      } else if (order.payment?.transactionId) {
        paymentInfo = `💳 الدفع: Stripe — ${payStatusLabel}\n🔢 المعاملة: <code>${order.payment.transactionId}</code>`
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

      await ctx.replyWithHTML(msg, orderActionKeyboard(order.id, order.paymentStatus, order.paymentMethod))
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

// =============================================================================
// §12 INLINE CALLBACK HANDLERS
// =============================================================================

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
        user: { select: { id: true, name: true, email: true, country: true } },
        localPayment: true,
        payment: true,
      },
    })
    if (!order) {
      return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })
    }

    // Atomic update with WHERE condition — prevents double approval race condition
    await db.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: { not: 'PAID' } },
        data: { paymentStatus: 'PAID', status: 'PROCESSING' },
      })
      if (updated.count === 0) {
        throw new Error('ALREADY_PAID')
      }

      // Update local payment if exists
      if (order.localPayment) {
        await tx.localPayment.update({
          where: { id: order.localPayment.id },
          data: { status: 'APPROVED', reviewedAt: new Date() },
        })
      }

      // Update Stripe payment if exists
      if (order.payment) {
        await tx.payment.updateMany({ where: { orderId }, data: { status: 'PAID' } })
          .catch((err) => log('payment', 'WARN Failed to update Stripe payment status:', err))
      }

      // Decrement stock atomically within the same transaction
      const orderItems = await tx.orderItem.findMany({
        where: { orderId },
        select: { priceId: true, quantity: true },
      })
      for (const item of orderItems) {
        await tx.servicePrice.updateMany({
          where: { id: item.priceId, stock: { not: null, gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        })
      }
    })

    // Send notifications
    await Promise.all([
      sendAdminNotification(order, 'payment_approved'),
      triggerCustomerNotification(orderId, 'payment_approved'),
    ])

    await ctx.editMessageText(
      `✅ <b>تم تأكيد استلام الدفع!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ قيد التنفيذ\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
      { parse_mode: 'HTML' },
    )
    log('callback', `pay_approve SUCCESS orderId=${orderId}`)
  } catch (err: any) {
    if (err?.message === 'ALREADY_PAID') {
      return ctx.editMessageText(
        `ℹ️ تم تأكيد هذا الطلب بالفعل بواسطة مسؤول آخر\n\n📋 <code>${escapeCode(ctx.match![1])}</code>`,
        { parse_mode: 'HTML' },
      )
    }
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

    // جلب رقم الطلب لعرضه بدل الـ ID الداخلي
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { orderNumber: true },
    })
    const displayNumber = order?.orderNumber || orderId

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
          paymentInfo += `\n    ${sanitize(label)}: ${sanitize(String(val))}`
        }
      }
    } else if (order.payment?.transactionId) {
      paymentInfo = `💳 الدفع: Stripe — ${payStatusLabel}\n🔢 المعاملة: <code>${order.payment.transactionId}</code>`
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
      include: { user: { select: { name: true, email: true, country: true } } },
    })
    if (!order) return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })

    // Payment check before shipping
    const isUnpaid = order.paymentStatus !== 'PAID'
    const isManualPayment = !order.paymentMethod || order.paymentMethod === 'LOCAL'
    const ONLINE_PAYMENT_METHODS = ['STRIPE', 'MOYASAR', 'PAYTABS', 'PAYPAL']

    if (isUnpaid) {
      if (ONLINE_PAYMENT_METHODS.includes(order.paymentMethod || '')) {
        // STRICT: Online payment orders must be PAID before shipping
        // This prevents shipping orders where payment hasn't been confirmed by the gateway
        log('callback', `BLOCK ship_start: order ${orderId} uses online payment (${order.paymentMethod}) but is not PAID (status=${order.paymentStatus})`)
        return ctx.editMessageText(
          `🚫 <b>لا يمكن الشحن — الدفع غير مؤكد</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n💳 طريقة الدفع: ${order.paymentMethod}\n📊 حالة الدفع: ${order.paymentStatus}\n\n⚠️ يجب تأكيد الدفع من بوابة الدفع الإلكترونية أولاً قبل الشحن.\nإذا تم الدفع بالفعل، تحقق من حالة الويب هوك أو اضغط "تأكيد الاستلام".`,
          { parse_mode: 'HTML' },
        )
      }
      // For manual/local payments, warn but still allow shipping
      // The admin should approve payment first via pay_approve
      log('callback', `WARN ship_start: order ${orderId} is unpaid (paymentStatus=${order.paymentStatus}, method=${order.paymentMethod || 'LOCAL'}). Allowing with warning.`)
    }

    // Atomic update with WHERE condition — prevents race condition
    // Only update order status to PROCESSING, do NOT force paymentStatus to PAID
    // If paymentStatus was already PAID (gateway or pay_approve), keep it
    // If paymentStatus is still PENDING, leave it as-is — admin must approve payment separately
    const updateData: { status: string; paymentStatus?: string } = { status: 'PROCESSING' }

    // Only set paymentStatus to PAID if it's not already set (preserve existing state)
    // This prevents corrupting revenue reports by marking unpaid orders as PAID
    if (order.paymentStatus === 'PAID') {
      // Already paid — keep it as PAID
      updateData.paymentStatus = 'PAID'
    }
    // If not PAID, we do NOT set paymentStatus — it remains whatever it was (PENDING, etc.)

    const updated = await db.order.updateMany({
      where: { id: orderId, status: { notIn: ['COMPLETED', 'PROCESSING'] } },
      data: updateData,
    })
    if (updated.count === 0) {
      return ctx.editMessageText(
        `ℹ️ هذا الطلب قيد التنفيذ أو مكتمل بالفعل\n\n📋 <code>${escapeCode(order.orderNumber)}</code>`,
        { parse_mode: 'HTML' },
      )
    }

    await Promise.all([
      sendAdminNotification(order, 'order_processing'),
      triggerCustomerNotification(orderId, 'order_processing'),
    ])

    const unpaidWarning = isUnpaid
      ? '\n\n⚠️ <b>تنبيه:</b> الطلب لم يتم تأكيد دفعه بعد! يرجى تأكيد الدفع عبر زر "تأكيد الاستلام" أولاً.'
      : ''

    await ctx.editMessageText(
      `📦 <b>تم تحديث: جاري الشحن</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ⚙️ جاري التنفيذ والشحن\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل${unpaidWarning}`,
      { parse_mode: 'HTML' },
    )
    log('callback', `ship_start SUCCESS orderId=${orderId}`)
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
      include: { user: { select: { name: true, email: true, country: true } } },
    })
    if (!order) return ctx.editMessageText('⚠️ الطلب غير موجود', { parse_mode: 'HTML' })

    // Track whether stock should be decremented (idempotency)
    const wasAlreadyPaid = order.paymentStatus === 'PAID'

    // Atomic update with WHERE condition — prevents double completion race condition
    const updated = await db.order.updateMany({
      where: { id: orderId, status: { not: 'COMPLETED' } },
      data: { status: 'COMPLETED', paymentStatus: 'PAID' },
    })
    if (updated.count === 0) {
      return ctx.editMessageText(
        `ℹ️ هذا الطلب مكتمل بالفعل بواسطة مسؤول آخر\n\n📋 <code>${escapeCode(order.orderNumber)}</code>`,
        { parse_mode: 'HTML' },
      )
    }

    // Decrement stock atomically — only if payment was NOT already confirmed
    if (!wasAlreadyPaid) {
      await decrementOrderStock(orderId)
    }

    await Promise.all([
      sendAdminNotification(order, 'order_completed'),
      triggerCustomerNotification(orderId, 'order_completed'),
    ])

    await ctx.editMessageText(
      `🎉 <b>تم الشحن بنجاح!</b>\n\n📋 <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ✅ مكتمل ومشحون\n👤 العميل: ${sanitize(order.user.name)}\n📧✅ تم إرسال إشعار للعميل`,
      { parse_mode: 'HTML' },
    )
    log('callback', `ship_done SUCCESS orderId=${orderId}`)
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
      const methodName = getText(order.localPayment.method?.name, order.paymentMethod || 'محلي')
      paymentInfo = `💳 الدفع: ${methodName} — ${payStatusLabel}`
      if (order.localPayment.receiptUrl) paymentInfo += `\n🖼 الإيصال: ${order.localPayment.receiptUrl}`
      if (order.localPayment.reviewNotes) paymentInfo += `\n📝 ملاحظات: ${sanitize(order.localPayment.reviewNotes)}`
      if (order.localPayment.fieldValues && typeof order.localPayment.fieldValues === 'object') {
        const fvMeta = (order.localPayment.fieldValues as any)._meta as Record<string, any> | undefined
        const fvLabels = fvMeta?.fieldLabels as Record<string, string> | undefined
        for (const [key, val] of Object.entries(order.localPayment.fieldValues as Record<string, any>)) {
          if (key === '_meta' || !val) continue
          const label = fvLabels?.[key] || key
          paymentInfo += `\n    ${sanitize(label)}: ${sanitize(String(val))}`
        }
      }
    } else if (order.payment?.transactionId) {
      paymentInfo = `💳 الدفع: Stripe — ${payStatusLabel}\n🔢 المعاملة: ${order.payment.transactionId}`
    }

    return ctx.replyWithHTML(`
📋 <b>تفاصيل الطلب</b>

🔢 الطلب: <code>${escapeCode(order.orderNumber)}</code>\n📊 الحالة: ${statusLabel}

─────────────

👤 <b>العميل:</b>\n   ${sanitize(order.user.name)}\n   📧 ${sanitize(order.user.email)}${order.user.phone ? `\n   📱 ${sanitize(order.user.phone)}` : ''}

─────────────

🛍 <b>الخدمات (${order.items.length}):</b>\n\n${itemsList}

─────────────

💰 <b>الملخص:</b>\n   المجموع: ${formatAmount(order.subtotal, order.currency)}${Number(order.discount) > 0 ? `\n   🏷 الخصم: -${formatAmount(order.discount, order.currency)}` : ''}\n   <b>الإجمالي: ${formatAmount(order.total, order.currency)}</b>\n   💵 بالدولار: ${formatAmount(order.totalUSD, 'USD')}\n   ${paymentInfo}\n   ${order.exchangeRate ? `💱 سعر الصرف: ${Number(order.exchangeRate).toFixed(4)}` : ''}

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

// =============================================================================
// §13 TEXT HANDLER — Multi-step Conversations
// =============================================================================

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
        include: {
          user: { select: { id: true, name: true, email: true, country: true, phone: true } },
          localPayment: { select: { id: true, receiptUrl: true } },
          payment: { select: { id: true } },
          couponUsage: { select: { id: true, couponId: true } },
          items: { select: { id: true } },
        },
      })
      if (!order) return sendKeyboard(ctx, '⚠️ الطلب غير موجود')

      // حفظ بيانات الطلب للإشعارات
      const orderSnapshot = {
        id: order.id,
        orderNumber: order.orderNumber,
        user: { name: order.user.name, email: order.user.email, phone: order.user.phone, country: order.user.country },
        total: order.total,
        currency: order.currency,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
      }

      // تحديث الطلب إلى مرفوض بدلاً من حذفه (soft-delete)
      // هذا يحافظ على سجل المراجعة ولا يفقد البيانات
      await db.$transaction(async (tx) => {
        // تحديث حالة الطلب إلى REJECTED
        await tx.order.update({
          where: { id: conv.orderId },
          data: { status: 'REJECTED', paymentStatus: 'FAILED' },
        })

        // تحديث حالة الدفع المحلي إن وجد
        if (order.localPayment) {
          await tx.localPayment.update({
            where: { id: order.localPayment.id },
            data: { status: 'REJECTED', reviewedAt: new Date() },
          })
        }

        // تحديث حالة الدفع الإلكتروني إن وجد
        if (order.payment) {
          await tx.payment.updateMany({
            where: { orderId: conv.orderId },
            data: { status: 'FAILED' },
          })
        }

        // حذف CouponUsage وتنقيص coupon.usedCount إن وجد كوبون مستخدم
        if (order.couponUsage) {
          await tx.couponUsage.delete({ where: { id: order.couponUsage.id } })
          await tx.coupon.update({
            where: { id: order.couponUsage.couponId },
            data: { usedCount: { decrement: 1 } },
          })
        }
      })

      // إرسال إشعار للعميل
      await triggerCustomerNotification(conv.orderId!, 'payment_rejected', text)

      // إرسال إشعار للأدمن
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

// =============================================================================
// SLASH COMMANDS
// =============================================================================

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

// =============================================================================
// §14 ERROR HANDLING — bot.catch() + process handlers
// =============================================================================

// --- 14a. Global bot error handler (catches ALL unhandled Telegraf errors) ---
bot.catch((err: any) => {
  log('bot.catch', 'UNHANDLED ERROR in bot handler:')
  log('bot.catch', `  Message: ${err?.message || 'Unknown'}`)
  log('bot.catch', `  Code: ${err?.code || 'N/A'}`)
  log('bot.catch', `  on: ${err?.on || 'unknown handler'}`)
  log('bot.catch', `  Stack: ${err?.stack || 'N/A'}`)
  // Do NOT rethrow — this keeps the bot alive
})

// --- 14b. Process-level error handlers (keep the process alive) ---
process.on('unhandledRejection', (reason, promise) => {
  log('process', 'UNHANDLED REJECTION at:', promise, 'reason:', reason)
  // Do NOT exit — keep the bot running
})

process.on('uncaughtException', (err) => {
  log('process', 'UNCAUGHT EXCEPTION:', err?.message || err)
  log('process', `  Stack: ${err?.stack || 'N/A'}`)
  // Do NOT exit — keep the bot running (log only)
})

// =============================================================================
// §15 HEALTH CHECK SERVER
// =============================================================================

/** آخر فحص لاتصال تلغرام — يُحدّث كل 60 ثانية */
let lastTelegramCheck = { ok: false, checkedAt: 0 as number, botUsername: '' }

async function checkTelegramConnection(): Promise<{ ok: boolean; botUsername: string }> {
  const now = Date.now()
  // استخدم الكاش لمدة 60 ثانية
  if (now - lastTelegramCheck.checkedAt < 60_000) {
    return { ok: lastTelegramCheck.ok, botUsername: lastTelegramCheck.botUsername }
  }
  try {
    const botInfo = await bot.telegram.getMe()
    lastTelegramCheck = { ok: true, checkedAt: now, botUsername: botInfo.username || '' }
    return { ok: true, botUsername: botInfo.username || '' }
  } catch {
    lastTelegramCheck = { ok: false, checkedAt: now, botUsername: '' }
    return { ok: false, botUsername: '' }
  }
}

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    const telegram = await checkTelegramConnection()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: telegram.ok ? 'ok' : 'degraded',
      service: 'alqadi-bot-service',
      telegram: {
        connected: telegram.ok,
        botUsername: telegram.botUsername,
      },
      admins: adminCache.size,
      superAdmins: superAdminCache.size,
      conversations: conversations.size,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }))
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
})

// =============================================================================
// §16 LAUNCH — Bootstrap, start polling, graceful shutdown
// =============================================================================

async function main() {
  // Start health check server
  server.listen(SERVICE_PORT, () => {
    log('health', `Health check server running on port ${SERVICE_PORT}`)
  })

  // Test database connection
  try {
    await db.$connect()
    log('db', 'Connected to Supabase (PostgreSQL)')
  } catch (dbErr) {
    log('db', 'FATAL Failed to connect to database:', dbErr)
    process.exit(1)
  }

  // Initialize admin system
  await ensureSuperAdmin()
  await refreshAdminCache()

  // Register bot commands with Telegram
  bot.telegram.setMyCommands([
    { command: 'start', description: 'بدء المحادثة مع البوت' },
    { command: 'orders', description: 'عرض الطلبات المعلقة' },
    { command: 'stats', description: 'إحصائيات سريعة' },
  ])

  // Launch bot with long-polling
  bot.launch({
    dropPendingUpdates: true,
    // Telegraf v4 polling options for stability
    allowedUpdates: ['message', 'callback_query'],
  })

  log('bot', '✅ AlQadi Store bot is running')
  log('bot', `👑 Super Admin: ${SUPER_ADMIN_CHAT_ID}`)
  log('bot', `👥 Total Admins: ${adminCache.size}`)
  log('bot', '📡 Polling updates...')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log('shutdown', `Received ${signal} — shutting down gracefully...`)
    try {
      bot.stop('Shutting down')
      server.close()
      // Clean up all conversation timeouts to prevent memory leaks
      for (const state of conversations.values()) {
        if (state.timeout) clearTimeout(state.timeout)
      }
      conversations.clear()
      await db.$disconnect()
      log('shutdown', 'All connections closed, state cleaned up')
      process.exit(0)
    } catch (err) {
      log('shutdown', 'Error during shutdown:', err)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  log('main', 'FATAL error:', err)
  process.exit(1)
})
