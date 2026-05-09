/**
 * AlQadi Store — Helper Functions
 * Utility functions for validation, formatting, text extraction, and logging.
 */

import { db } from './database.js'
import { timingSafeEqual } from 'node:crypto'

/**
 * Validate that a string looks like a Prisma CUID (used for Order IDs).
 * Prisma CUIDs: start with 'c' + 24+ lowercase alphanumeric chars (e.g. "clxxxx...").
 * This is a defense-in-depth measure — even though Prisma parameterizes queries
 * (making SQL injection impossible), rejecting obviously malformed IDs early
 * prevents unnecessary DB queries and logs suspicious activity.
 */
const CUID_RE = /^c[a-z0-9]{8,30}$/
export function isValidOrderId(id: string): boolean {
  return CUID_RE.test(id)
}

/** Timing-safe string comparison to prevent timing attacks */
export function safeCompare(a: string, b: string): boolean {
  // ★ SECURITY: Use Node.js crypto.timingSafeEqual for constant-time comparison
  // Prevents attackers from determining secret length or content via timing analysis
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Burn constant CPU cycles even on length mismatch to prevent length leakage
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/** Sanitize text to prevent HTML injection in Telegram messages */
export function sanitize(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Safely escape text for <code> blocks */
export function escapeCode(text: string): string {
  return sanitize(text)
}

/**
 * ★ SECURITY: تطهير URL للاستخدام في href — يمنع حقن HTML و javascript: وبروتوكولات خطرة
 * السماح فقط بـ http:// و https:// — رفض أي بروتوكول آخر
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  // السماح فقط بـ http/https — يمنع javascript: و data: وبروتوكولات خطرة
  if (!/^https?:\/\//i.test(trimmed)) return ''
  // تطهير أحرف HTML الخاصة — يمنع كسر سمة href
  return sanitize(trimmed)
}

/** Format a date in Arabic locale */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('ar-SA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** Format currency amount (handles Prisma Decimal, number, and bigint) */
export function formatAmount(amount: any, currency: string): string {
  const num = typeof amount === 'bigint' ? Number(amount) : Number(amount)
  return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

/** Extract text from bilingual JSON fields */
export function getText(val: any, fallback = '—'): string {
  if (!val) return fallback
  if (typeof val === 'string') return val
  if (typeof val === 'object') return val.ar || val.en || fallback
  return fallback
}

/** Log with timestamp prefix */
export function log(tag: string, ...args: any[]) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}][${tag}]`, ...args)
}

/** Fetch store name from settings (with in-memory cache) */
let _storeNameCache: { value: string; expires: number } | null = null
export async function getStoreName(): Promise<string> {
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
