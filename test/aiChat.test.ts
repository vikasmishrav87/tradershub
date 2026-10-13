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
    // Test 1: Empty message rejection
    const res1 = await fetch(`${baseUrl}/api/ai-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const data1: any = await res1.json()
    if (res1.status === 400 && data1.error) {
      console.log('✅ [PASS] AI_CHAT > Empty message rejected with 400')
    } else {
      throw new Error(`Test 1 failed: status=${res1.status}`)
    }

    // Test 2: Knowledge fallback (when API key is missing or invalid)
    const res2 = await fetch(`${baseUrl}/api/ai-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'How do I join the VIP group for free?' })
    })
    const data2: any = await res2.json()
    if (res2.status === 200 && data2.success && data2.reply.includes('VIP Group for FREE')) {
      console.log('✅ [PASS] AI_CHAT > Intelligent fallback returns VIP guidance')
    } else {
      throw new Error(`Test 2 failed: ${JSON.stringify(data2)}`)
    }

    // Test 3: SMC question fallback
    const res3 = await fetch(`${baseUrl}/api/ai-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is Smart Money Concepts or ICT?' })
    })
    const data3: any = await res3.json()
    if (res3.status === 200 && data3.success && data3.reply.includes('Smart Money Concepts')) {
      console.log('✅ [PASS] AI_CHAT > Intelligent fallback returns SMC guidance')
    } else {
      throw new Error(`Test 3 failed: ${JSON.stringify(data3)}`)
    }

    // Test 4: Choices array compatibility
    if (data3.choices && data3.choices[0] && data3.choices[0].message.content) {
      console.log('✅ [PASS] AI_CHAT > Choices array compatibility verified')
    } else {
      throw new Error('Test 4 failed: choices array missing')
    }

    console.log('\nAll AI Chatbot backend tests passed successfully!')
  } finally {
    server.close()
  }
}

runTests().catch(err => {
  console.error('❌ Tests failed:', err)
  process.exit(1)
})
