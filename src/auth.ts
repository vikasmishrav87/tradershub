import { Request, Response, Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import {
  upsertGoogleUser,
  upsertMemberUser,
  getUserById,
  logSecurityEvent,
  UserRecord
} from './db.js'

// Extend Express SessionData to include our custom session fields
declare module 'express-session' {
  interface SessionData {
    userId?: number
    oauthState?: string
    oauthReturnTo?: string
  }
}

const router = Router()

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '754703406217-iul1vka4si0cmgj0hi6kee7hf1cqinkb.apps.googleusercontent.com'
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID)

/**
 * 1. POST /google/verify and POST /api/auth/google/verify
 * Verifies Google Identity Services ID Token (One-Tap / Google Sign-In Button)
 * Automatically creates account if new user, or signs in existing user.
 */
export const handleGoogleVerify = async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = req.headers['user-agent'] || 'unknown'

  try {
    const { credential, id_token } = req.body
    const token = credential || id_token

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing or malformed Google authentication token.' })
    }

    // Cryptographic verification with Google's public certificates
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: [
        GOOGLE_CLIENT_ID,
        '754703406217-iul1vka4si0cmgj0hi6kee7hf1cqinkb.apps.googleusercontent.com'
      ]
    })

    const payload = ticket.getPayload()
    if (!payload) {
      logSecurityEvent('GOOGLE_TOKEN_PAYLOAD_MISSING', null, ip, userAgent, {})
      return res.status(401).json({ error: 'Google token payload is missing or invalid.' })
    }

    const { sub, email, email_verified, name, picture, iss } = payload

    const validIssuers = ['accounts.google.com', 'https://accounts.google.com']
    if (!iss || !validIssuers.includes(iss)) {
      logSecurityEvent('GOOGLE_INVALID_ISSUER', null, ip, userAgent, { iss })
      return res.status(401).json({ error: 'Invalid Google token issuer.' })
    }

    if (!sub || typeof sub !== 'string') {
      logSecurityEvent('GOOGLE_MISSING_SUB', null, ip, userAgent, {})
      return res.status(401).json({ error: 'Invalid Google user subject.' })
    }

    if (!email) {
      logSecurityEvent('GOOGLE_MISSING_EMAIL', null, ip, userAgent, {})
      return res.status(400).json({ error: 'Google account has no associated email.' })
    }

    // Check if account already existed
    const isExisting = getUserById(1) // check existence
    // Automatically creates or updates account in database
    const user = upsertGoogleUser(sub, email, Boolean(email_verified), name, picture)

    // Secure session rotation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session rotation failed:', err)
        return res.status(500).json({ error: 'Session creation failed.' })
      }

      req.session.userId = user.id

      logSecurityEvent('LOGIN_SUCCESS', user.id, ip, userAgent, {
        method: 'google_id_token',
        email: user.email,
        name: user.name,
        role: user.role
      })

      req.session.save(() => {
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
      })
    })
  } catch (err: any) {
    console.error('Google ID Token Verification Error:', err.message || err)
    logSecurityEvent('LOGIN_FAILED', null, ip, userAgent, { error: err.message })
    return res.status(401).json({
      error: 'Google authentication failed: ' + (err.message || 'Invalid token')
    })
  }
}

router.post('/google/verify', handleGoogleVerify)

/**
 * 2. GET /google and GET /google/callback
 * Redirect to signin with Google One-Tap ready
 */
router.get(['/google', '/google/callback'], (req: Request, res: Response) => {
  res.redirect('/signin')
})

/**
 * 3. POST /member-login and POST /login
 * Direct Member Authentication: Works in parallel for direct email access
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

    // Secure session rotation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session rotation failed:', err)
        if (isJson) {
          return res.status(500).json({ error: 'Session creation failed' })
        }
        return res.redirect('/signin?error=session_error')
      }

      req.session.userId = user.id

      logSecurityEvent('LOGIN_SUCCESS', user.id, ip, userAgent, {
        method: 'member_direct',
        email: user.email,
        role: user.role
      })

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
 * 4. GET /logout and POST /logout
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
