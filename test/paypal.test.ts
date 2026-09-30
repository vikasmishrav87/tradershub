import http from 'http'
import app from '../src/index.js'
import { getPaymentByOrderId, db } from '../src/db.js'

async function runPayPalTests() {
  console.log('\n==================================================')
  console.log('STARTING PAYPAL PAYMENT INTEGRATION TESTS')
  console.log('==================================================\n')

  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address() as any
  const port = address.port
  const baseUrl = `http://localhost:${port}`

  console.log(`PayPal test server running at ${baseUrl}\n`)

  let passCount = 0
  let failCount = 0

  function record(name: string, passed: boolean, message: string) {
    if (passed) {
      passCount++
      console.log(`✅ [PASS] ${name}: ${message}`)
    } else {
      failCount++
      console.error(`❌ [FAIL] ${name}: ${message}`)
    }
  }

  try {
    // ----------------------------------------------------
    // TEST 1: Public Config Endpoint
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/paypal/config`)
      const data = await res.json()

      const hasClientId = data.clientId === 'BAA3yFYfK1N5v-5Qi3EDhXfPA07AIHDq_mAOmTYiuqeXNfAldsC5Z6YNE_E72jTAe7514GuerRdt2_fYVw'
      const secretExposed = 'clientSecret' in data || 'secret' in data

      if (res.status === 200 && hasClientId && !secretExposed && data.currency === 'USD') {
        record('Public Config Endpoint', true, `Returned clientId safely without exposing secret`)
      } else {
        record('Public Config Endpoint', false, `Unexpected response: ${JSON.stringify(data)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 2: Record Payment Validation (Missing orderId)
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/paypal/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Host': `localhost:${port}` },
        body: JSON.stringify({ amount: 60 })
      })

      if (res.status === 400) {
        record('Validation (Missing orderId)', true, 'Rejected missing orderId with HTTP 400')
      } else {
        record('Validation (Missing orderId)', false, `Expected 400, got ${res.status}`)
      }
    }

    // ----------------------------------------------------
    // TEST 3: Record Successful Payment
    // ----------------------------------------------------
    const testOrderId = `TEST_PAYPAL_ORDER_${Date.now()}`
    const testCaptureId = `TEST_PAYPAL_CAPTURE_${Date.now()}`
    {
      const res = await fetch(`${baseUrl}/api/paypal/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Host': `localhost:${port}` },
        body: JSON.stringify({
          orderId: testOrderId,
          captureId: testCaptureId,
          amount: 60,
          currency: 'USD',
          planName: 'Indian Market Paid Desk (Monthly)',
          status: 'COMPLETED',
          payer: {
            email_address: 'trader@example.com',
            name: { given_name: 'Vikas', surname: 'Mishra' }
          }
        })
      })

      const data = await res.json()
      if (res.status === 200 && data.success && data.order_id === testOrderId) {
        record('Record Payment Success', true, `Recorded order ${testOrderId} successfully`)
      } else {
        record('Record Payment Success', false, `Failed to record payment: ${JSON.stringify(data)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 4: Database Persistence & Status Check
    // ----------------------------------------------------
    {
      const row = getPaymentByOrderId(testOrderId)
      if (row && row.status === 'paid' && row.currency === 'USD' && row.amount === 6000) {
        record('Database Persistence', true, `Order ${testOrderId} persisted with status 'paid' and amount 6000 cents`)
      } else {
        record('Database Persistence', false, `Database record invalid: ${JSON.stringify(row)}`)
      }
    }

    // ----------------------------------------------------
    // TEST 5: Create Order Validation (Invalid amount)
    // ----------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/api/paypal/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Host': `localhost:${port}` },
        body: JSON.stringify({ amount: -10 })
      })

      if (res.status === 400) {
        record('Create Order Validation', true, 'Rejected negative amount with HTTP 400')
      } else {
        record('Create Order Validation', false, `Expected 400, got ${res.status}`)
      }
    }

    console.log('\n==================================================')
    console.log('PAYPAL INTEGRATION TEST SUMMARY')
    console.log('==================================================')
    console.log(`Total: ${passCount + failCount} | PASS: ${passCount} | FAIL: ${failCount}\n`)

    if (failCount > 0) {
      process.exit(1)
    }
  } catch (err: any) {
    console.error('Fatal test runner error:', err)
    process.exit(1)
  } finally {
    server.close()
  }
}

runPayPalTests()
