import { Router, Request, Response } from 'express'
import Razorpay from 'razorpay'
import crypto from 'node:crypto'
import { recordPaymentOrder, recordPaymentSuccess, logSecurityEvent } from './db.js'

const router = Router()

/**
 * Dynamically resolves Razorpay credentials and client instance per request.
 * Crucial for serverless environments (e.g. Vercel) where env vars are injected at runtime.
 */
export function getRazorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID
  const key_secret = process.env.RAZORPAY_KEY_SECRET

  if (!key_id || !key_secret) {
    return null
  }

  return {
    key_id,
    key_secret,
    client: new Razorpay({ key_id, key_secret })
  }
}

/**
 * GET /api/razorpay-config (or /api/payments/config)
 * Public endpoint allowing client to retrieve the publishable key_id safely.
 * KEY_SECRET is NEVER returned.
 */
router.get('/razorpay-config', (_req: Request, res: Response) => {
  const key_id = process.env.RAZORPAY_KEY_ID
  if (!key_id) {
    return res.status(500).json({ error: 'Razorpay Key ID not configured' })
  }
  res.json({ key_id })
})

/**
 * STEP 1: BACKEND - Create Order
 * Endpoint: POST /api/create-order
 * Request Body: { amount (in paise), currency (optional, default: INR), receipt (optional) }
 * Return: { order_id, amount, currency, key_id }
 */
router.post('/create-order', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const razorpay = getRazorpayClient()
    if (!razorpay) {
      logSecurityEvent('PAYMENT_CONFIG_ERROR', userId, ip, userAgent, { error: 'Razorpay keys not set' })
      return res.status(401).json({ error: 'Razorpay payment gateway credentials not configured or unauthorized.' })
    }

    const { amount, currency = 'INR', receipt, notes } = req.body

    // Validation: amount must be a number and >= 100 paise (₹1)
    const numAmount = Number(amount)
    if (!amount || isNaN(numAmount) || numAmount < 100) {
      return res.status(400).json({
        error: 'Invalid amount. Minimum amount is 100 paise (₹1).'
      })
    }

    const safeCurrency = String(currency).toUpperCase()
    const safeReceipt = receipt && typeof receipt === 'string'
      ? receipt.substring(0, 40)
      : `rcpt_${Date.now()}_${Math.floor(Math.random() * 1000)}`

    // Call Razorpay API to generate order
    const order = await razorpay.client.orders.create({
      amount: Math.round(numAmount),
      currency: safeCurrency,
      receipt: safeReceipt,
      notes: typeof notes === 'object' && notes !== null ? notes : {}
    })

    // Record order in local database
    recordPaymentOrder(order.id, Number(order.amount), order.currency, safeReceipt, userId)

    logSecurityEvent('PAYMENT_ORDER_CREATED', userId, ip, userAgent, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    })

    return res.status(200).json({
      order_id: order.id,
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: razorpay.key_id
    })
  } catch (err: any) {
    console.error('Razorpay Create Order Error:', err.message || err)
    logSecurityEvent('PAYMENT_ORDER_FAILED', userId, ip, userAgent, {
      error: err.error?.description || err.message || 'Razorpay order creation failed'
    })
    return res.status(500).json({
      error: err.error?.description || err.message || 'Failed to create Razorpay order'
    })
  }
})

/**
 * STEP 3: BACKEND - Verify Signature
 * Endpoint: POST /api/verify-payment
 * Algorithm: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
 * Compare generated signature with razorpay_signature
 */
router.post('/verify-payment', async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const userAgent = (req.headers['user-agent'] as string) || 'unknown'
  const userId = req.session?.userId || null

  try {
    const razorpay = getRazorpayClient()
    if (!razorpay) {
      return res.status(401).json({ success: false, error: 'Razorpay payment gateway not configured.' })
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      order_id,
      payment_id,
      signature
    } = req.body

    const actualOrderId = razorpay_order_id || order_id
    const actualPaymentId = razorpay_payment_id || payment_id
    const actualSignature = razorpay_signature || signature

    // Validation: Missing fields
    if (!actualOrderId || !actualPaymentId || !actualSignature) {
      logSecurityEvent('PAYMENT_VERIFY_MISSING_FIELDS', userId, ip, userAgent, {
        hasOrderId: Boolean(actualOrderId),
        hasPaymentId: Boolean(actualPaymentId),
        hasSignature: Boolean(actualSignature)
      })
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: order_id, payment_id, and signature are required.'
      })
    }

    // Cryptographic verification: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
    const payload = `${actualOrderId}|${actualPaymentId}`
    const generatedSignature = crypto
      .createHmac('sha256', razorpay.key_secret)
      .update(payload)
      .digest('hex')

    // Timing-safe comparison to prevent timing side-channel attacks
    const genBuf = Buffer.from(generatedSignature, 'hex')
    const sigBuf = Buffer.from(actualSignature, 'hex')

    const isMatch = genBuf.length === sigBuf.length && crypto.timingSafeEqual(genBuf, sigBuf)

    if (!isMatch) {
      logSecurityEvent('PAYMENT_SIGNATURE_MISMATCH', userId, ip, userAgent, {
        orderId: actualOrderId,
        paymentId: actualPaymentId
      })
      // Do NOT mark as paid
      return res.status(400).json({
        success: false,
        error: 'Payment verification failed: Signature mismatch.'
      })
    }

    // Signature matches: Mark payment as paid in database
    recordPaymentSuccess(actualOrderId, actualPaymentId, actualSignature)

    logSecurityEvent('PAYMENT_VERIFIED_SUCCESS', userId, ip, userAgent, {
      orderId: actualOrderId,
      paymentId: actualPaymentId
    })

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully.',
      order_id: actualOrderId,
      payment_id: actualPaymentId
    })
  } catch (err: any) {
    console.error('Razorpay Verify Error:', err.message || err)
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error verifying payment.'
    })
  }
})

export default router
