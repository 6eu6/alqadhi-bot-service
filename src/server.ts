/**
 * AlQadi Store — HTTP Server
 * Health check endpoint + webhook endpoint for store → bot notifications.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Telegraf } from 'telegraf'
import { db } from './database.js'
import { isValidOrderId, safeCompare, log } from './helpers.js'
import { WebhookEvent } from './constants.js'
import { adminCache, superAdminCache } from './admin.js'
import { conversations } from './conversations.js'
import { WEBHOOK_SECRET } from './config.js'
import { sendWebhookOrderNotification } from './notifications.js'

/** آخر فحص لاتصال تلغرام — يُحدّث كل 60 ثانية */
let lastTelegramCheck = { ok: false, checkedAt: 0 as number, botUsername: '' }

async function checkTelegramConnection(bot: Telegraf<any>): Promise<{ ok: boolean; botUsername: string }> {
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

/**
 * Read the full request body as a string.
 * Helper for webhook endpoint (raw body parsing).
 */
function readRequestBody(req: IncomingMessage, maxSize = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * Send a JSON response.
 */
function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function createHttpServer(bot: Telegraf<any>) {
  const server = createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0] || ''
    const method = req.method?.toUpperCase() || ''

    // ─── Health Check ────────────────────────────────────────────────────────
    if (pathname === '/health' && method === 'GET') {
      const telegram = await checkTelegramConnection(bot)
      // ★ SECURITY: معلومات أساسية فقط — بدون كشف تفاصيل داخلية
      return sendJson(res, 200, {
        status: telegram.ok ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
      })
    }

    // ─── Webhook: Store → Bot (order notifications) ─────────────────────────
    // POST /webhook/orders
    // Body: { event: 'payment_confirmed' | 'receipt_uploaded', orderId: string }
    // Auth: X-Webhook-Secret header (must match BOT_WEBHOOK_SECRET or INTERNAL_API_SECRET)
    if (pathname === '/webhook/orders' && method === 'POST') {
      try {
        // 1. Authenticate
        const secret = req.headers['x-webhook-secret'] as string | undefined
        if (!WEBHOOK_SECRET) {
          log('webhook', 'ERROR No WEBHOOK_SECRET configured — rejecting webhook')
          return sendJson(res, 503, { error: 'Webhook not configured' })
        }
        if (!secret || !safeCompare(secret, WEBHOOK_SECRET)) {
          log('webhook', 'WARN Invalid or missing webhook secret')
          return sendJson(res, 401, { error: 'Unauthorized' })
        }

        // 2. Parse body
        const bodyStr = await readRequestBody(req)
        let body: any
        try {
          body = JSON.parse(bodyStr)
        } catch {
          return sendJson(res, 400, { error: 'Invalid JSON body' })
        }

        const { event, orderId } = body

        // 3. Validate
        if (!event || !orderId) {
          return sendJson(res, 400, { error: 'Missing required fields: event, orderId' })
        }

        const validEvents: WebhookEvent[] = ['payment_confirmed', 'receipt_uploaded']
        if (!validEvents.includes(event)) {
          return sendJson(res, 400, { error: `Invalid event. Must be one of: ${validEvents.join(', ')}` })
        }

        if (!isValidOrderId(orderId)) {
          return sendJson(res, 400, { error: 'Invalid orderId format' })
        }

        log('webhook', `Received ${event} for order ${orderId}`)

        // 4. Process asynchronously — send notification to all admins
        // We respond immediately so the store doesn't block, then process
        sendWebhookOrderNotification(orderId, event).catch((err) => {
          log('webhook', `ERROR processing ${event} for ${orderId}:`, err)
        })

        // Respond immediately — notification is fire-and-forget
        return sendJson(res, 200, {
          received: true,
          event,
          orderId,
          message: 'Notification will be sent to all admins',
        })
      } catch (err: any) {
        log('webhook', `ERROR webhook handler: ${err?.message}`, err)
        return sendJson(res, 500, { error: 'Internal server error' })
      }
    }

    // ─── 404 ────────────────────────────────────────────────────────────────
    sendJson(res, 404, { error: 'Not found' })
  })

  return server
}
