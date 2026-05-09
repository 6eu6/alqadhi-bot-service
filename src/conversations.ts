/**
 * AlQadi Store — Conversation State Management
 * Multi-step conversation tracking for reject reasons, admin management, etc.
 */

export type ConversationType = 'reject_reason' | 'reject_confirm' | 'add_admin' | 'remove_admin' | 'promote' | 'demote'

export interface ConversationState {
  type: ConversationType
  orderId?: string
  paymentStatus?: string
  paymentMethod?: string | null
  timeout: NodeJS.Timeout
}

export const conversations = new Map<string, ConversationState>()

export function setConversation(chatId: string, state: ConversationState) {
  const existing = conversations.get(chatId)
  if (existing?.timeout) clearTimeout(existing.timeout)
  conversations.set(chatId, state)
}

export function clearConversation(chatId: string) {
  const existing = conversations.get(chatId)
  if (existing?.timeout) clearTimeout(existing.timeout)
  conversations.delete(chatId)
}
