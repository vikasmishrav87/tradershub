import { Router, Request, Response } from 'express'
import crypto from 'node:crypto'
import { recordPaymentOrder, recordPaymentSuccess, getPaymentByOrderId, logSecurityEvent } from './db.js'

const router = Router()

/**
 * Helper to fetch PhonePe configuration from environment variables.
 * Supports UAT (Sandbox) and PRODUCTION environments seamlessly.
 */
export function getPhonePeConfig() {
  const merchantId = process.env.PHONEPE_MERCHANT_ID || 'PGTESTPAYUAT'
  const saltKey = process.env.PHONEPE_SALT_KEY || ''
  const saltIndex = process.env.PHONEPE_SALT_INDEX || '1'
  const env = (process.env.PHONEPE_ENV || 'UAT').toUpperCase()

  const host = env === 'PRODUCTION'
    ? 'https://api.phonepe.com/apis/hermes'
    : 'https://api-preprod.phonepe.com/apis/pg-sandbox'

  return {
    merchantId,
    saltKey,
    saltIndex,
    env,
    host,
    isConfigured: Boolean(merchantId && saltKey)
  }
}

/**
 * 1. POST /api/phonepe/pay
 * Initiates standard PhonePe Standard Web Checkout.
 * Body: { amount: number (in paise), planName?: string, phone?: string }
 */
router.post('/pay', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const config = getPhonePeConfig()
    if (!config.isConfigured) {
      return res.status(401).json({
        success: false,
        error: 'PhonePe credentials (PHONEPE_MERCHANT_ID, PHONEPE_SALT_KEY) not configured in server environment.'
      })
    }

    const { amount, planName, phone } = req.body
    const numAmount = Number(amount)

    if (!amount || isNaN(numAmount) || numAmount < 100) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment amount. Minimum amount is 100 paise (₹1.00).'
      })
    }

    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https'
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'tradershubs.vercel.app'
    const baseUrl = `${proto}://${host}`

    const merchantTransactionId = `TH_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    const merchantUserId = userId ? `UID_${userId}` : `GUEST_${Date.now()}`

    const payload = {
      merchantId: config.merchantId,
      merchantTransactionId,
      merchantUserId,
      amount: Math.round(numAmount),
      redirectUrl: `${baseUrl}/api/phonepe/callback`,
      redirectMode: 'POST',
      callbackUrl: `${baseUrl}/api/phonepe/webhook`,
      mobileNumber: phone ? String(phone).replace(/\D/g, '').slice(-10) : '9999999999',
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    }

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64')
    const stringToHash = `${base64Payload}/pg/v1/pay${config.saltKey}`
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex')
    const xVerify = `${sha256}###${config.saltIndex}`

    // Record initial order state in database
    recordPaymentOrder(merchantTransactionId, Math.round(numAmount), 'INR', planName || 'PhonePe Payment', userId)

    // Call PhonePe Payment API
    const response = await fetch(`${config.host}/pg/v1/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify
      },
      body: JSON.stringify({ request: base64Payload })
    })

    const data: any = await response.json()

    if (!response.ok || !data.success) {
      logSecurityEvent('PHONEPE_INIT_FAILED', userId, ip, userAgent, {
        error: data.message || 'PhonePe init returned error',
        code: data.code
      })
      return res.status(500).json({
        success: false,
        error: data.message || 'PhonePe payment gateway initialization failed.',
        code: data.code
      })
    }

    const redirectUrl = data.data?.instrumentResponse?.redirectInfo?.url
    if (!redirectUrl) {
      return res.status(500).json({
        success: false,
        error: 'PhonePe did not return a valid checkout redirect URL.'
      })
    }

    logSecurityEvent('PHONEPE_PAY_INITIATED', userId, ip, userAgent, {
      merchantTransactionId,
      amount: numAmount
    })

    return res.status(200).json({
      success: true,
      transactionId: merchantTransactionId,
      redirectUrl
    })
  } catch (err: any) {
    console.error('PhonePe Pay Error:', err.message || err)
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to initialize PhonePe payment.'
    })
  }
})

/**
 * 2. POST & GET /api/phonepe/callback
 * Handles user redirect back from PhonePe after payment attempt.
 * Always verifies status server-to-server with PhonePe before approving.
 */
async function handlePhonePeCallback(req: Request, res: Response) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'

  try {
    const config = getPhonePeConfig()
    // Transaction ID can arrive via body (POST) or query (GET)
    const transactionId = req.body?.transactionId ||
      req.body?.merchantTransactionId ||
      (req.query?.merchantTransactionId as string) ||
      (req.query?.transactionId as string)

    if (!transactionId) {
      return res.redirect('/checkout?error=missing_transaction_id')
    }

    // Server-to-Server status verification via PhonePe status API
    const stringToHash = `/pg/v1/status/${config.merchantId}/${transactionId}${config.saltKey}`
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex')
    const xVerify = `${sha256}###${config.saltIndex}`

    const statusRes = await fetch(`${config.host}/pg/v1/status/${config.merchantId}/${transactionId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': config.merchantId
      }
    })

    const statusData: any = await statusRes.json()

    if (statusRes.ok && statusData.success && statusData.code === 'PAYMENT_SUCCESS') {
      const providerRef = statusData.data?.transactionId || transactionId
      recordPaymentSuccess(transactionId, providerRef, xVerify)
      logSecurityEvent('PHONEPE_PAYMENT_SUCCESS', null, ip, userAgent, { transactionId, providerRef })

      return res.redirect(`/checkout?payment_success=true&gateway=phonepe&txId=${encodeURIComponent(transactionId)}`)
    } else {
      logSecurityEvent('PHONEPE_PAYMENT_FAILED', null, ip, userAgent, {
        transactionId,
        code: statusData?.code,
        message: statusData?.message
      })
      return res.redirect(`/checkout?error=payment_failed&code=${encodeURIComponent(statusData?.code || 'FAILED')}`)
    }
  } catch (err: any) {
    console.error('PhonePe Callback Error:', err.message || err)
    return res.redirect('/checkout?error=callback_verification_failed')
  }
}

router.post('/callback', handlePhonePeCallback)
router.get('/callback', handlePhonePeCallback)

/**
 * 3. POST /api/phonepe/webhook
 * PhonePe Server-to-Server S2S notification endpoint.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const config = getPhonePeConfig()
    const { response: encodedResponse } = req.body

    if (!encodedResponse) {
      return res.status(400).json({ error: 'Missing response body' })
    }

    const decoded = JSON.parse(Buffer.from(encodedResponse, 'base64').toString('utf8'))
    const transactionId = decoded.data?.merchantTransactionId
    const providerRef = decoded.data?.transactionId || transactionId

    if (decoded.success && decoded.code === 'PAYMENT_SUCCESS') {
      recordPaymentSuccess(transactionId, providerRef, 'S2S_WEBHOOK')
    }

    res.status(200).json({ status: 'ACKNOWLEDGED' })
  } catch (err: any) {
    console.error('PhonePe Webhook Error:', err.message)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

/**
 * 4. GET /api/phonepe/status/:transactionId
 * Client-facing status check endpoint.
 */
router.get('/status/:transactionId', async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params
    const config = getPhonePeConfig()

    const stringToHash = `/pg/v1/status/${config.merchantId}/${transactionId}${config.saltKey}`
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex')
    const xVerify = `${sha256}###${config.saltIndex}`

    const statusRes = await fetch(`${config.host}/pg/v1/status/${config.merchantId}/${transactionId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': config.merchantId
      }
    })

    const statusData: any = await statusRes.json()
    res.json(statusData)
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to check status' })
  }
})

export default router
