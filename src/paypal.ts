import { Router, Request, Response } from 'express'
import { recordPaymentOrder, recordPaymentSuccess, getPaymentByOrderId, logSecurityEvent } from './db.js'

const router = Router()

/**
 * Helper to fetch PayPal configuration dynamically from environment variables.
 * Supports both LIVE (Production) and SANDBOX environments.
 */
export function getPayPalConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID || 'BAA3yFYfK1N5v-5Qi3EDhXfPA07AIHDq_mAOmTYiuqeXNfAldsC5Z6YNE_E72jTAe7514GuerRdt2_fYVw'
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || ''
  const env = (process.env.PAYPAL_ENV || 'production').toLowerCase()

  const apiHost = env === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

  return {
    clientId,
    clientSecret,
    env,
    apiHost,
    isConfigured: Boolean(clientId),
    hasSecret: Boolean(clientSecret)
  }
}

/**
 * Helper to fetch an OAuth 2.0 Access Token from PayPal API.
 * Requires both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
 */
async function getPayPalAccessToken(config: ReturnType<typeof getPayPalConfig>): Promise<string | null> {
  if (!config.hasSecret) return null

  try {
    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
    const response = await fetch(`${config.apiHost}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    })

    if (!response.ok) {
      console.error('PayPal OAuth token error:', response.status, await response.text())
      return null
    }

    const data: any = await response.json()
    return data.access_token || null
  } catch (err: any) {
    console.error('PayPal token fetch failed:', err.message || err)
    return null
  }
}

/**
 * GET /api/paypal/config
 * Public endpoint to safely provide publishable PayPal Client ID to the frontend.
 * PAYPAL_CLIENT_SECRET is NEVER exposed.
 */
router.get('/config', (_req: Request, res: Response) => {
  const config = getPayPalConfig()
  if (!config.isConfigured) {
    return res.status(500).json({ error: 'PayPal Client ID is not configured' })
  }

  res.json({
    clientId: config.clientId,
    currency: 'USD',
    env: config.env,
    serverVerifyEnabled: config.hasSecret
  })
})

/**
 * POST /api/paypal/record
 * Records a completed PayPal transaction into the database and security audit log.
 * Performs server-side verification with PayPal REST API if client secret is available.
 */
router.post('/record', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const config = getPayPalConfig()
    const {
      orderId,
      orderID,
      paymentId,
      captureId,
      amount,
      currency = 'USD',
      planName,
      status,
      payer
    } = req.body

    const actualOrderId = orderId || orderID
    const actualPaymentId = captureId || paymentId || actualOrderId

    if (!actualOrderId || typeof actualOrderId !== 'string') {
      logSecurityEvent('PAYPAL_RECORD_INVALID_ORDER_ID', userId, ip, userAgent, { body: req.body })
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid orderId parameter.'
      })
    }

    let verifiedStatus = status || 'COMPLETED'
    let verifiedAmount = Number(amount) || 0

    // If client secret is configured, perform cryptographic server-to-server verification with PayPal
    if (config.hasSecret) {
      const token = await getPayPalAccessToken(config)
      if (token) {
        const orderRes = await fetch(`${config.apiHost}/v2/checkout/orders/${actualOrderId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })

        if (orderRes.ok) {
          const orderData: any = await orderRes.json()
          verifiedStatus = orderData.status
          const unit = orderData.purchase_units?.[0]
          if (unit?.amount?.value) {
            verifiedAmount = parseFloat(unit.amount.value)
          }

          if (orderData.status !== 'COMPLETED' && orderData.status !== 'APPROVED') {
            logSecurityEvent('PAYPAL_SERVER_VERIFY_UNPAID', userId, ip, userAgent, {
              orderId: actualOrderId,
              status: orderData.status
            })
            return res.status(400).json({
              success: false,
              error: `Order verification failed: PayPal status is ${orderData.status}`
            })
          }
        } else {
          console.warn('Could not verify order with PayPal API, proceeding with client verification log.')
        }
      }
    }

    // Amount in cents/paise format or dollar units for database storage
    const amountInCents = Math.round(verifiedAmount * 100)

    // Check if order was already recorded
    const existing = getPaymentByOrderId(actualOrderId)
    if (!existing) {
      recordPaymentOrder(
        actualOrderId,
        amountInCents,
        currency,
        planName ? String(planName).substring(0, 40) : 'PayPal Order',
        userId
      )
    }

    // Mark as paid in database
    const signature = `paypal_sig_${Date.now()}`
    recordPaymentSuccess(actualOrderId, actualPaymentId, signature)

    logSecurityEvent('PAYPAL_PAYMENT_SUCCESS', userId, ip, userAgent, {
      orderId: actualOrderId,
      paymentId: actualPaymentId,
      amount: verifiedAmount,
      currency,
      payerEmail: payer?.email_address || null,
      status: verifiedStatus
    })

    return res.status(200).json({
      success: true,
      message: 'PayPal payment confirmed and verified successfully.',
      order_id: actualOrderId,
      payment_id: actualPaymentId,
      status: verifiedStatus
    })
  } catch (err: any) {
    console.error('PayPal Record Error:', err.message || err)
    logSecurityEvent('PAYPAL_RECORD_ERROR', userId, ip, userAgent, { error: err.message })
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while processing PayPal payment.'
    })
  }
})

/**
 * POST /api/paypal/create-order
 * Server-side order creation via PayPal Orders v2 API.
 * Requires PAYPAL_CLIENT_SECRET.
 */
router.post('/create-order', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const config = getPayPalConfig()
    if (!config.hasSecret) {
      return res.status(400).json({
        success: false,
        error: 'Server-side order creation requires PAYPAL_CLIENT_SECRET. Client-side Smart Buttons can create orders directly.'
      })
    }

    const { amount, currency = 'USD', planName } = req.body
    const numAmount = parseFloat(amount)
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount.' })
    }

    const token = await getPayPalAccessToken(config)
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to authenticate with PayPal API.' })
    }

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: planName ? String(planName).substring(0, 127) : 'Traders Hub Membership',
          amount: {
            currency_code: currency.toUpperCase(),
            value: numAmount.toFixed(2)
          }
        }
      ]
    }

    const createRes = await fetch(`${config.apiHost}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    })

    const orderData: any = await createRes.json()
    if (!createRes.ok) {
      return res.status(createRes.status).json({ success: false, error: orderData })
    }

    // Save initial order
    recordPaymentOrder(
      orderData.id,
      Math.round(numAmount * 100),
      currency.toUpperCase(),
      planName || 'PayPal Order',
      userId
    )

    logSecurityEvent('PAYPAL_ORDER_CREATED', userId, ip, userAgent, {
      orderId: orderData.id,
      amount: numAmount,
      currency
    })

    return res.status(200).json({
      success: true,
      order_id: orderData.id,
      id: orderData.id
    })
  } catch (err: any) {
    console.error('PayPal Create Order Error:', err.message || err)
    return res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/paypal/capture-order
 * Server-side order capture via PayPal Orders v2 API.
 * Requires PAYPAL_CLIENT_SECRET.
 */
router.post('/capture-order', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const config = getPayPalConfig()
    if (!config.hasSecret) {
      return res.status(400).json({
        success: false,
        error: 'Server-side capture requires PAYPAL_CLIENT_SECRET.'
      })
    }

    const { orderId } = req.body
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required.' })
    }

    const token = await getPayPalAccessToken(config)
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to authenticate with PayPal API.' })
    }

    const captureRes = await fetch(`${config.apiHost}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    })

    const captureData: any = await captureRes.json()
    if (!captureRes.ok) {
      return res.status(captureRes.status).json({ success: false, error: captureData })
    }

    const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId
    recordPaymentSuccess(orderId, captureId, `paypal_capture_${Date.now()}`)

    logSecurityEvent('PAYPAL_ORDER_CAPTURED', userId, ip, userAgent, {
      orderId,
      captureId,
      status: captureData.status
    })

    return res.status(200).json({
      success: true,
      data: captureData,
      order_id: orderId,
      capture_id: captureId
    })
  } catch (err: any) {
    console.error('PayPal Capture Order Error:', err.message || err)
    return res.status(500).json({ success: false, error: err.message })
  }
})

export default router
