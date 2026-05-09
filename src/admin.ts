/**
 * AlQadi Store — Admin Management
 * DB-backed admin cache with periodic refresh.
 */

import { Context } from 'telegraf'
import { SUPER_ADMIN_CHAT_ID } from './config.js'
import { db } from './database.js'
import { log } from './helpers.js'
import { adminKeyboard, superKeyboard } from './constants.js'

/** In-memory cache of admin chat IDs — refreshed every 5 minutes */
export let adminCache: Set<string> = new Set()
export let superAdminCache: Set<string> = new Set()
let lastCacheRefresh = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** Check if the admin cache is stale and needs refreshing */
export function isCacheStale(): boolean {
  return Date.now() - lastCacheRefresh > CACHE_TTL
}

export async function refreshAdminCache(): Promise<void> {
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

export async function isAdmin(chatId: number | string): Promise<boolean> {
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    await refreshAdminCache()
  }
  return adminCache.has(String(chatId))
}

export async function isSuperAdmin(chatId: number | string): Promise<boolean> {
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    await refreshAdminCache()
  }
  return superAdminCache.has(String(chatId))
}

export async function ensureSuperAdmin(): Promise<void> {
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
export function getEffectiveChatId(ctx: Context): number | undefined {
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
export async function sendKeyboard(ctx: Context, text: string, extra?: any) {
  const chatId = ctx.chat?.id
  if (!chatId) return ctx.replyWithHTML(text, extra)
  const isSuper = await isSuperAdmin(chatId)
  const kb = isSuper ? superKeyboard : adminKeyboard
  return ctx.replyWithHTML(text, { ...kb, ...extra })
}
