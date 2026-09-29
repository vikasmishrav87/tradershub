/**
 * Traders Hub - Razorpay Standard Web Checkout Integration
 * Handles order creation, Razorpay checkout modal invocation, signature verification, and error states.
 */

(function () {
  // Ensure Razorpay SDK script is loaded
  function loadRazorpaySdk() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) {
        return resolve(true)
      }
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.async = true
      script.onload = () => resolve(true)
      script.onerror = () => reject(new Error('Failed to load Razorpay Checkout SDK'))
      document.head.appendChild(script)
    })
  }

  // Toast / Alert notification banner
  function showStatusToast(message, type = 'info') {
    let toast = document.getElementById('th-payment-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.id = 'th-payment-toast'
      toast.style.position = 'fixed'
      toast.style.bottom = '24px'
      toast.style.right = '24px'
      toast.style.zIndex = '999999'
      toast.style.padding = '14px 20px'
      toast.style.borderRadius = '8px'
      toast.style.fontFamily = "'Inter', sans-serif"
      toast.style.fontSize = '13px'
      toast.style.fontWeight = '600'
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)'
      toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
      toast.style.maxWidth = '380px'
      toast.style.display = 'flex'
      toast.style.alignItems = 'center'
      toast.style.gap = '10px'
      document.body.appendChild(toast)
    }

    if (type === 'success') {
      toast.style.background = '#064e3b'
      toast.style.color = '#34d399'
      toast.style.border = '1px solid #059669'
      toast.innerHTML = `<span>✅</span> <div>${message}</div>`
    } else if (type === 'error') {
      toast.style.background = '#450a0a'
      toast.style.color = '#f87171'
      toast.style.border = '1px solid #dc2626'
      toast.innerHTML = `<span>⚠️</span> <div>${message}</div>`
    } else {
      toast.style.background = '#1e293b'
      toast.style.color = '#fbbf24'
      toast.style.border = '1px solid #f59e0b'
      toast.innerHTML = `<span>⏳</span> <div>${message}</div>`
    }

    toast.style.opacity = '1'
    toast.style.transform = 'translateY(0)'

    setTimeout(() => {
      if (toast) {
        toast.style.opacity = '0'
        toast.style.transform = 'translateY(10px)'
      }
    }, 6000)
  }

  /**
   * Main Checkout Function
   * @param {Object} options
   * @param {number} options.amount - Amount in INR (e.g. 5000) or in paise (if inPaise is true)
   * @param {boolean} [options.inPaise=false] - Whether amount is already in paise
   * @param {string} [options.planName] - Display name of the product/plan
   * @param {Object} [options.prefill] - { name, email, contact }
   * @param {Function} [options.onSuccess] - Callback when verification succeeds
   * @param {Function} [options.onFailure] - Callback when error occurs or user dismisses
   */
  async function payWithRazorpay(options = {}) {
    const {
      amount,
      inPaise = false,
      planName = 'Traders Hub Membership',
      prefill = {},
      onSuccess,
      onFailure
    } = options

    // Validate amount
    const rawAmount = Number(amount)
    if (!amount || isNaN(rawAmount) || rawAmount <= 0) {
      const err = 'Please provide a valid payment amount.'
      showStatusToast(err, 'error')
      if (onFailure) onFailure(err)
      return
    }

    // Convert to paise if not already
    const amountInPaise = inPaise ? Math.round(rawAmount) : Math.round(rawAmount * 100)
    if (amountInPaise < 100) {
      const err = 'Minimum payment amount is ₹1 (100 paise).'
      showStatusToast(err, 'error')
      if (onFailure) onFailure(err)
      return
    }

    showStatusToast('Initializing secure Razorpay order...', 'info')

    try {
      // 1. Ensure SDK is ready
      await loadRazorpaySdk()

      // 2. STEP 1: BACKEND - Call /api/create-order
      const orderRes = await fetch('/api/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency: 'INR',
          receipt: `rcpt_${Date.now()}`,
          notes: {
            planName: planName
          }
        })
      })

      const orderData = await orderRes.json()
      if (!orderRes.ok || !orderData.order_id) {
        throw new Error(orderData.error || 'Failed to create payment order with server.')
      }

      // 3. STEP 2: FRONTEND - Open Razorpay Checkout Modal
      const rzpOptions = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: orderData.currency || 'INR',
        name: 'Traders Hub',
        description: planName,
        image: '/logo.png',
        order_id: orderData.order_id,
        handler: async function (response) {
          // 4. STEP 3: BACKEND - Verify Signature
          showStatusToast('Verifying payment signature with Traders Hub...', 'info')
          try {
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature
              })
            })

            const verifyData = await verifyRes.json()
            if (verifyRes.ok && verifyData.success) {
              showStatusToast(`Payment Successful! Payment ID: ${response.razorpay_payment_id}`, 'success')
              if (onSuccess) {
                onSuccess(verifyData, response)
              } else {
                setTimeout(() => {
                  window.location.href = `/dashboard?payment_success=true&payment_id=${encodeURIComponent(response.razorpay_payment_id)}`
                }, 1500)
              }
            } else {
              throw new Error(verifyData.error || 'Payment signature verification failed.')
            }
          } catch (vErr) {
            const errMsg = vErr.message || 'Payment verification failed'
            showStatusToast(errMsg, 'error')
            if (onFailure) onFailure(errMsg)
          }
        },
        prefill: {
          name: prefill.name || '',
          email: prefill.email || '',
          contact: prefill.contact || ''
        },
        notes: {
          plan: planName
        },
        theme: {
          color: '#f59e0b' // Cyberpunk Gold theme
        },
        modal: {
          ondismiss: function () {
            const msg = 'Payment cancelled by user.'
            showStatusToast(msg, 'info')
            if (onFailure) onFailure(msg)
          }
        }
      }

      const rzp = new window.Razorpay(rzpOptions)

      // Handle payment failure event
      rzp.on('payment.failed', function (response) {
        const errorMsg = response.error?.description || response.error?.reason || 'Payment failed'
        showStatusToast(`Payment Failed: ${errorMsg}`, 'error')
        if (onFailure) onFailure(errorMsg, response.error)
      })

      rzp.open()
    } catch (err) {
      console.error('Checkout error:', err)
      const errText = err.message || 'Payment processing error'
      showStatusToast(errText, 'error')
      if (onFailure) onFailure(errText)
    }
  }

  // Expose globally
  window.payWithRazorpay = payWithRazorpay
  window.showStatusToast = showStatusToast
})()
