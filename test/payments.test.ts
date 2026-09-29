import 'dotenv/config'
process.env.NODE_ENV = 'test'
import http from 'http'
import crypto from 'node:crypto'
import app from '../src/index.js'
import { db, getPaymentByOrderId } from '../src/db.js'

let server: http.Server
let port: number
let baseUrl: string

interface TestResult {
  name: string
  status: 'PASS' | 'FAIL'
  details: string
}

const results: TestResult[] = []

function record(name: string, status: 'PASS' | 'FAIL', details: string) {
  results.push({ name, status, details })
  const icon = status === 'PASS' ? '✅' : '❌'
  console.log(`${icon} [${status}] ${name}: ${details}`)
}

async function runPaymentTests() {
  console.log('\n==================================================')
  console.log('STARTING RAZORPAY PAYMENT INTEGRATION TESTS')
  console.log('==================================================\n')

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address() as { port: number }
      port = address.port
      baseUrl = `http://localhost:${port}`
      console.log(`Payment test server running at ${baseUrl}\n`)
      resolve()
    })
  })

  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'pxa96YcYi37q580TyPxbvNQd'
  const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_ThpvxtwxaRhdgr'

  let createdOrderId = ''

  try {
    // ----------------------------------------------------
    // TEST 1: Config endpoint returns public key and hides secret
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/razorpay-config`)
      const data = await res.json()
      if (res.status === 200 && data.key_id === keyId && !('key_secret' in data)) {
        record('Public Config Endpoint', 'PASS', `Returned key_id (${data.key_id}) without exposing secret`)
      } else {
        record('Public Config Endpoint', 'FAIL', `Unexpected response: ${JSON.stringify(data)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 2: Create Order - Validation for minimum amount (< 100 paise)
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50 }) // 50 paise is below 100 paise minimum
      })
      const data = await res.json()
      if (res.status === 400 && data.error && data.error.includes('100 paise')) {
        record('Order Validation (Minimum Amount)', 'PASS', `Rejected 50 paise with HTTP 400: ${data.error}`)
      } else {
        record('Order Validation (Minimum Amount)', 'FAIL', `Expected 400, got ${res.status}: ${JSON.stringify(data)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 3: Create Order - Validation for missing amount
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const data = await res.json()
      if (res.status === 400) {
        record('Order Validation (Missing Amount)', 'PASS', 'Rejected empty body with HTTP 400')
      } else {
        record('Order Validation (Missing Amount)', 'FAIL', `Expected 400, got ${res.status}`)
      }
    }

    // ----------------------------------------------------
    // TEST 4: Create Order - Successful Live Razorpay API call
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 50000, // ₹500.00
          currency: 'INR',
          receipt: `test_rcpt_${Date.now()}`,
          notes: { planName: 'Test Indian Market Desk' }
        })
      })
      const data = await res.json()
      if (res.status === 200 && data.order_id && data.order_id.startsWith('order_') && data.amount === 50000) {
        createdOrderId = data.order_id
        record('Order Creation (Live Razorpay API)', 'PASS', `Created live order: ${data.order_id} for ${data.amount} ${data.currency}`)

        // Verify database persistence
        const dbRecord = getPaymentByOrderId(createdOrderId)
        if (dbRecord && dbRecord.status === 'created' && dbRecord.amount === 50000) {
          record('Order Database Persistence', 'PASS', `Order ${createdOrderId} saved to local SQLite database`)
        } else {
          record('Order Database Persistence', 'FAIL', 'Order not found in SQLite payments table')
        }
      } else {
        record('Order Creation (Live Razorpay API)', 'FAIL', `Expected 200, got ${res.status}: ${JSON.stringify(data)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 5: Verify Payment - Missing Required Fields
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: createdOrderId
          // Missing payment_id and signature
        })
      })
      const data = await res.json()
      if (res.status === 400 && data.success === false) {
        record('Verify Payment (Missing Fields)', 'PASS', 'HTTP 400 returned when payment_id or signature is missing')
      } else {
        record('Verify Payment (Missing Fields)', 'FAIL', `Expected 400, got ${res.status}`)
      }
    }

    // ----------------------------------------------------
    // TEST 6: Verify Payment - Fraudulent / Tampered Signature
    // ----------------------------------------------------
    {
      const fakePaymentId = 'pay_fake_attack_12345'
      const fraudulentSignature = '0000000000000000000000000000000000000000000000000000000000000000'

      const res = await fetch(`${baseUrl}/api/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: createdOrderId,
          razorpay_payment_id: fakePaymentId,
          razorpay_signature: fraudulentSignature
        })
      })
      const data = await res.json()
      if (res.status === 400 && data.success === false) {
        record('Verify Payment (Signature Tampering Protection)', 'PASS', 'Fraudulent signature rejected with HTTP 400')
      } else {
        record('Verify Payment (Signature Tampering Protection)', 'FAIL', `Expected 400 rejection, got ${res.status}`)
      }
    }

    // ----------------------------------------------------
    // TEST 7: Verify Payment - Authentic HMAC-SHA256 Signature
    // ----------------------------------------------------
    {
      const authenticPaymentId = `pay_test_${Date.now()}`
      // Standard Razorpay signature calculation: HMAC-SHA256(order_id + "|" + payment_id, secret)
      const authenticSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${createdOrderId}|${authenticPaymentId}`)
        .digest('hex')

      const res = await fetch(`${baseUrl}/api/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id: createdOrderId,
          razorpay_payment_id: authenticPaymentId,
          razorpay_signature: authenticSignature
        })
      })
      const data = await res.json()
      if (res.status === 200 && data.success === true) {
        record('Verify Payment (Authentic Signature Verification)', 'PASS', `Payment ${authenticPaymentId} verified successfully`)

        // Verify status in database transitioned to 'paid'
        const dbRecord = getPaymentByOrderId(createdOrderId)
        if (dbRecord && dbRecord.status === 'paid' && dbRecord.payment_id === authenticPaymentId) {
          record('Payment Status Database Transition', 'PASS', `Order status updated to "paid" with payment_id ${authenticPaymentId}`)
        } else {
          record('Payment Status Database Transition', 'FAIL', `Payment record not updated in database: ${JSON.stringify(dbRecord)}`)
        }
      } else {
        record('Verify Payment (Authentic Signature Verification)', 'FAIL', `Expected 200, got ${res.status}: ${JSON.stringify(data)}`)
      }
    }
  } catch (err: any) {
    console.error('Test execution error:', err)
  } finally {
    server.close()

    console.log('\n==================================================')
    console.log('RAZORPAY INTEGRATION TEST SUMMARY')
    console.log('==================================================')
    const passCount = results.filter((r) => r.status === 'PASS').length
    const failCount = results.filter((r) => r.status === 'FAIL').length
    console.log(`Total: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}\n`)

    if (failCount > 0) {
      process.exit(1)
    }
  }
}

runPaymentTests()
