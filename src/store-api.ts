/**
 * AlQadi Store — Store API Client
 * Centralized order operations via store's internal API.
 */

import { INTERNAL_SECRET, API_BASE_URL } from './config.js'
import { log } from './helpers.js'

/**
 * Call the Next.js store's internal order API.
 * All write operations (approve, reject, ship, complete) go through this
 * single function — ensuring the store is the Single Source of Truth.
 */
export async function callStoreOrderApi(
  orderId: string,
  action: 'approve' | 'reject' | 'process' | 'complete',
  extra?: { reason?: string },
): Promise<{ success: boolean; data?: any; error?: string }> {
  if (!INTERNAL_SECRET) {
    log('api', 'ERROR No INTERNAL_API_SECRET configured — cannot call store API')
    return { success: false, error: 'API secret not configured' }
  }

  try {
    const body: Record<string, string> = { action }
    if (extra?.reason) body.reason = extra.reason

    const response = await fetch(`${API_BASE_URL}/api/internal/order/${orderId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })

    const result = await response.json()
    if (!response.ok) {
      log('api', `ERROR Store API ${action} failed: ${response.status}`, result.error || '')
      return { success: false, error: result.error || `HTTP ${response.status}` }
    }

    return result
  } catch (err: any) {
    log('api', `ERROR Store API ${action} request failed:`, err?.message || err)
    return { success: false, error: err?.message || 'Network error' }
  }
}
