/**
 * AlQadi Store — Database Client
 * Prisma client setup with connection pooling for Supabase.
 */

import { PrismaClient } from '@prisma/client'

// Add connection_limit for Supabase pooler to avoid MaxClientsInSessionMode
let botDbUrl = process.env.SUPABASE_DATABASE_URL || ''
if (botDbUrl && !botDbUrl.includes('connection_limit')) {
  const separator = botDbUrl.includes('?') ? '&' : '?'
  botDbUrl = `${botDbUrl}${separator}connection_limit=5&pool_timeout=20`
}

export const db = new PrismaClient({
  log: ['error'],
  datasources: {
    db: {
      url: botDbUrl,
    },
  },
})
