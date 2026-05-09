/**
 * AlQadi Store — Audit Log Service
 * يسجّل كل إجراء إداري مهم في قاعدة البيانات.
 *
 * ★ SECURITY: يوفر سجل تدقيق شامل لأفعال المشرفين:
 *   - تأكيد/رفض الدفع
 *   - بدء الشحن / إكمال الطلب
 *   - إضافة/حذف/ترقية/تخفيض المشرفين
 *
 * كل سجل يحتوي: مَن فعل، ماذا فعل، على ماذا، متى، وتفاصيل إضافية.
 */

import { db } from './database.js'
import { log } from './helpers.js'

export type AuditAction =
  | 'approve_payment'
  | 'reject_payment'
  | 'ship_start'
  | 'ship_done'
  | 'add_admin'
  | 'remove_admin'
  | 'promote'
  | 'demote'
  | 'order_details'

export type AuditTargetType = 'order' | 'admin'

interface AuditEntry {
  action: AuditAction | string
  actorId: string
  targetType?: AuditTargetType
  targetId?: string
  details?: Record<string, unknown>
}

/**
 * تسجيل إجراء إداري في سجل التدقيق.
 * الإضافة تتم بشكل غير متزامن (fire-and-forget) حتى لا تُبطئ الاستجابة.
 */
export function auditLog(entry: AuditEntry): void {
  // Fire-and-forget — لا نريد أن يفشل الإجراء بسبب خطأ في التدقيق
  db.auditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId,
      actorType: 'bot_admin',
      targetType: entry.targetType || null,
      targetId: entry.targetId || null,
      details: entry.details || undefined,
    },
  }).then(() => {
    log('audit', `${entry.action} by ${entry.actorId} on ${entry.targetType}:${entry.targetId}`)
  }).catch((err) => {
    log('audit', `ERROR logging ${entry.action}: ${err?.message || err}`)
  })
}

/**
 * تسجيل إجراء إداري بشكل متزامن (await) — يُستخدم في الحالات الحرجة
 * حيث نحتاج نتأكد أن السجل حُفظ قبل المتابعة.
 */
export async function auditLogSync(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId,
        actorType: 'bot_admin',
        targetType: entry.targetType || null,
        targetId: entry.targetId || null,
        details: entry.details || undefined,
      },
    })
    log('audit', `${entry.action} by ${entry.actorId} on ${entry.targetType}:${entry.targetId}`)
  } catch (err: any) {
    log('audit', `ERROR logging ${entry.action}: ${err?.message || err}`)
  }
}
