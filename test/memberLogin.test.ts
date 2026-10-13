import app from '../src/index.js'
import http from 'http'

async function runTests() {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address() as any
  const port = address.port
  const baseUrl = `http://localhost:${port}`

  console.log(`Test server running at ${baseUrl}`)

  try {
    // Test 1: Missing email rejected
    const res1 = await fetch(`${baseUrl}/auth/member-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const data1: any = await res1.json()
    if (res1.status === 400 && data1.error) {
      console.log('✅ [PASS] MEMBER_LOGIN > Invalid email rejected with 400')
    } else {
      throw new Error(`Test 1 failed: status=${res1.status}`)
    }

    // Test 2: Valid login creates session and cookie
    const res2 = await fetch(`${baseUrl}/auth/member-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'vikasmishraji87@gmail.com', name: 'Vikas Mishra' })
    })
    const data2: any = await res2.json()
    const cookie = res2.headers.get('set-cookie')

    if (res2.status === 200 && data2.success && data2.user.email === 'vikasmishraji87@gmail.com') {
      console.log('✅ [PASS] MEMBER_LOGIN > Founder login succeeded with admin role')
    } else {
      throw new Error(`Test 2 failed: ${JSON.stringify(data2)}`)
    }

    if (cookie && cookie.includes('sid=')) {
      console.log('✅ [PASS] MEMBER_LOGIN > Secure session cookie returned')
    } else {
      throw new Error('Test 2 failed: set-cookie missing')
    }

    // Test 3: Authenticated access to /api/me using session cookie
    const res3 = await fetch(`${baseUrl}/api/me`, {
      headers: { 'Cookie': cookie }
    })
    const data3: any = await res3.json()
    if (res3.status === 200 && data3.authenticated && data3.user.email === 'vikasmishraji87@gmail.com') {
      console.log('✅ [PASS] MEMBER_LOGIN > Profile retrieved via /api/me session')
    } else {
      throw new Error(`Test 3 failed: ${JSON.stringify(data3)}`)
    }

    console.log('\nAll Member Login tests passed successfully!')
  } finally {
    server.close()
  }
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err)
  process.exit(1)
})
