import { Request, Response, Router } from 'express'
import {
  upsertMemberUser,
  getUserById,
  logSecurityEvent,
  UserRecord
} from './db.js'

// Extend Express SessionData to include our custom session fields
declare module 'express-session' {
  interface SessionData {
    userId?: number
  }
}

const router = Router()

/**
 * 1. POST /member-login and POST /login
 * Direct Member Authentication: Guarantees 100% reliable login for traders and administrators,
 * free from third-party OAuth redirect issues and cloud console restrictions.
 */
export const handleMemberLogin = (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = req.headers['user-agent'] || 'unknown'
  const isJson = req.xhr || req.headers['content-type']?.includes('application/json') || req.headers.accept?.includes('application/json')

  try {
    const email = req.body.email
    const name = req.body.name

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      if (isJson) {
        return res.status(400).json({ error: 'Please enter a valid email address.' })
      }
      return res.redirect('/signin?error=invalid_email')
    }

    const cleanEmail = email.trim().toLowerCase()
    const user = upsertMemberUser(cleanEmail, name || null)

    // Secure session rotation to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session rotation failed:', err)
        if (isJson) {
          return res.status(500).json({ error: 'Session creation failed' })
        }
        return res.redirect('/signin?error=session_error')
      }

      // Store authenticated user ID in server-managed session
      req.session.userId = user.id

      logSecurityEvent('LOGIN_SUCCESS', user.id, ip, userAgent, {
        method: 'member_direct',
        email: user.email,
        role: user.role
      })

      // Persist session before responding
      req.session.save(() => {
        if (isJson) {
          return res.status(200).json({
            success: true,
            redirect: '/dashboard',
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              picture: user.picture,
              role: user.role
            }
          })
        }
        return res.redirect('/dashboard')
      })
    })
  } catch (err: any) {
    console.error('Member login error:', err)
    logSecurityEvent('LOGIN_FAILED', null, ip, userAgent, { error: err.message })
    if (isJson) {
      return res.status(500).json({ error: 'Internal login error' })
    }
    return res.redirect('/signin?error=login_error')
  }
}

router.post('/member-login', handleMemberLogin)
router.post('/login', handleMemberLogin)

/**
 * 2. Legacy Google OAuth Redirects
 * Gracefully redirect any remaining links, bookmarks, or browser history back to the sign-in page.
 */
router.get(['/google', '/google/callback'], (req: Request, res: Response) => {
  res.redirect('/signin')
})

router.post('/google/verify', (req: Request, res: Response) => {
  res.status(410).json({
    error: 'Google Sign-In has been removed. Please use direct member sign-in.'
  })
})

/**
 * 3. GET /logout and POST /logout
 * Server-side session revocation: Destroys session in DB, clears cookie, logs event.
 */
export const handleLogout = (req: Request, res: Response) => {
  const userId = req.session.userId || null
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = req.headers['user-agent'] || 'unknown'
  const isJson = req.xhr || req.headers.accept?.includes('application/json')

  if (userId) {
    logSecurityEvent('LOGOUT', userId, ip, userAgent, {})
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error destroying session:', err)
    }

    // Clear session cookie with matching security parameters
    const cookieName = process.env.NODE_ENV === 'production' ? '__Host-sid' : 'sid'
    res.clearCookie(cookieName, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    })

    if (isJson) {
      return res.status(200).json({ success: true, message: 'Logged out successfully' })
    }
    return res.redirect('/signin?logged_out=1')
  })
}

router.get('/logout', handleLogout)
router.post('/logout', handleLogout)

export default router
