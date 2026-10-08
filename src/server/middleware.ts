import { createMiddleware } from '@tanstack/react-start'
import { currentUser } from './auth'
import type { Role } from './db'

/** Middleware factory: rejects unauthenticated callers and roles outside `allowed` (admin always passes). */
export const requireRole = (...allowed: Role[]) =>
  createMiddleware({ type: 'function' }).server(async ({ next }) => {
    const user = currentUser()
    if (!user) throw new Error('Unauthorized')
    if (user.role !== 'admin' && allowed.length > 0 && !allowed.includes(user.role)) {
      throw new Error('Forbidden: your role cannot perform this action')
    }
    return next({ context: { user } })
  })
