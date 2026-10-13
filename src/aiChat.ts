import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'

const router = Router()

// Rate limit: 30 requests per minute
export const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests to AI Coach. Please wait a minute before sending another message.'
  }
})

export const SYSTEM_PROMPT = `You are the official AI assistant for Traders Hub (Trading with AV) — a premier trading education community led by Vikas Mishra with 5+ years of live market experience.

Key community details:
- Indian Markets: Dhan (0 brokerage, referral code OESVY25380) | Angel One (F&O data, referral code VX07092HDV)
- Crypto: Delta Exchange FIU India (code TradewithAV) | MEXC altcoins (code 2uptt) | Weex no-KYC (code 5pyzd) | CoinDCX (invest)
- Forex/Gold: XM 360 (code RH7QB) | Vantage Markets (code TradewithAV) | Elefin (code Theunfilteredtraders)
- Prop Firms: FundedNext (code vikas32) | Funding Pips (code CDAD32CE, coupon FP200 = 25% off)
- Core Methodology: ICT Smart Money Concepts + proprietary Fibonacci (80-95% win rate)
- Telegram: t.me/+FNIBb-pEK0g4MGI1 | WhatsApp: whatsapp.com/channel/0029VbCxmiMG8l5IOlc7nO0N
- Email: tradershub@gmail.com | YouTube: Traders Hub
- Free VIP Access: Open an account with any partner broker + deposit $100 + DM @YourstrulyVikasMishra on Telegram
- Paid Programs: Indian Group ₹5K/mo | Fib Group ₹7K/mo | Indian Course ₹10K | Fib Course ₹17K | Mentorship ₹30K/mo
- Payment: UPI vikasmishraji87-2@oksbi | USDT BEP-20: 0x583c468d8408f588032870f51e1b3dd4af80ee0e

Style & Tone:
- Be conversational, knowledgeable, warm, and naturally mix Hindi and English (Hinglish) where appropriate.
- Answer questions on ICT, SMC, Order Blocks, Liquidity Sweeps, Fair Value Gaps (FVG), Fibonacci levels, and prop firm rules accurately.
- For personal queries, VIP access approval, or payment confirmations, guide users to contact @YourstrulyVikasMishra on Telegram or email tradershub@gmail.com.`

// Community knowledge fallback in case external API key is expired or unconfigured
const KNOWLEDGE_FALLBACKS: Array<{ triggers: string[]; reply: string }> = [
  {
    triggers: ['free', 'vip', 'join', 'how to join', 'entry'],
    reply: "To join our **VIP Group for FREE**:\n1. Open an account with any partner broker (Dhan: `OESVY25380`, Angel One: `VX07092HDV`, Delta Exchange: `TradewithAV`, XM: `RH7QB`, Vantage: `TradewithAV`).\n2. Deposit a minimum of $100 (or ₹8,000 for Indian brokers). This remains 100% your own trading capital.\n3. Send your deposit screenshot & Client ID to **@YourstrulyVikasMishra** on Telegram for instant VIP access!"
  },
  {
    triggers: ['smc', 'smart money', 'concept', 'ict', 'fvg', 'liquidity', 'order block'],
    reply: "Smart Money Concepts (SMC) & ICT focus on tracking institutional footprints (banks, institutions, market makers) rather than retail indicators. Key pillars include:\n- **Liquidity Sweeps**: Taking out buy/sell-side stops before major expansions.\n- **Fair Value Gaps (FVGs)**: Imbalances created by aggressive institutional candles.\n- **Order Blocks**: High-probability entry zones after market structure shifts."
  },
  {
    triggers: ['fib', 'fibonacci', 'golden', 'ratio', 'spiral'],
    reply: "Vikas Mishra's proprietary **Fibonacci Architecture** moves beyond basic 0.5 and 0.618 levels. We utilize institutional cluster zones (0.705 golden pocket, 1.272/1.618 extension exhaustion) and the Fibonacci Time Spiral to anticipate high-probability reversal turning points with an 80-95% verified strike rate."
  },
  {
    triggers: ['broker', 'dhan', 'angel', 'nifty', 'banknifty', 'indian market'],
    reply: "For Indian Markets (Nifty, Bank Nifty, Stock Options):\n- **Dhan** (code: `OESVY25380`): Direct TradingView integration and zero brokerage options.\n- **Angel One** (code: `VX07092HDV`): Best-in-class F&O data and open interest tracking.\nOpening via our link qualifies you for Free VIP access!"
  },
  {
    triggers: ['crypto', 'p2p', 'delta', 'mexc', 'bitcoin', 'weex'],
    reply: "For Crypto trading without P2P freeze risks in India:\n- **Delta Exchange** (code: `TradewithAV`): FIU-India registered with direct INR UPI deposit/withdrawal.\n- **MEXC** (code: `2uptt`): 0-fee altcoin trading.\n- **Weex** (code: `5pyzd`): No-KYC crypto futures."
  },
  {
    triggers: ['prop', 'funded', 'funding pips', 'fundednext', 'challenge'],
    reply: "For Prop Firm Challenges:\n- **FundedNext** (use partner link / code: `vikas32`): Up to 95% profit splits.\n- **Funding Pips** (code: `CDAD32CE`, use coupon `FP200` for 25% OFF).\nKey rule: Never risk more than 0.5%-1% per trade to safely pass the evaluation phases!"
  },
  {
    triggers: ['price', 'fee', 'charge', 'paid', 'cost', 'course', 'mentorship'],
    reply: "Our premium programs include:\n• **Indian Market Paid Desk**: ₹5,000/mo\n• **Fibonacci Trading Group**: ₹7,000/mo\n• **Indian Market Recorded Course**: ₹10,000 one-time\n• **Fib Live Course**: ₹17,000 one-time\n• **1-on-1 Mentorship with Vikas**: ₹30,000/mo\nPayments via UPI `vikasmishraji87-2@oksbi` or DM **@YourstrulyVikasMishra** on Telegram."
  },
  {
    triggers: ['hello', 'hi', 'hey', 'namaste', 'kaise ho', 'help'],
    reply: "👋 **Namaste!** Main Traders Hub (Trading with AV) ka AI Coach hoon. Aap ICT/SMC concepts, Fibonacci architecture, partner brokers, free VIP access ya prop firms ke baare mein kuch bhi pooch sakte hain! Kaise help kar sakta hoon?"
  }
]

export function getFallbackReply(userText: string): string {
  const lower = userText.toLowerCase()
  const matched = KNOWLEDGE_FALLBACKS.find(k => k.triggers.some(t => lower.includes(t)))
  if (matched) {
    return matched.reply
  }
  return "Traders Hub AI Coach: At Traders Hub, we analyze markets through multi-timeframe liquidity sweeps, institutional Fibonacci confluence, and strict risk-reward management.\n\nFor real-time setups, personalized portfolio feedback, or VIP entry, connect directly with Vikas Mishra on Telegram: @YourstrulyVikasMishra or email tradershub@gmail.com."
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function callLlm(messages: ChatMessage[]): Promise<string> {
  const openRouterKey = process.env.OPENROUTER_API_KEY
  const openAiKey = process.env.OPENAI_API_KEY

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20000)

  try {
    if (openRouterKey && openRouterKey.trim()) {
      const model = process.env.AI_MODEL || 'openai/gpt-4o-mini'
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey.trim()}`,
          'HTTP-Referer': process.env.BASE_URL || 'https://tradershubs.vercel.app',
          'X-Title': 'Traders Hub AI Coach',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: controller.signal
      })

      const data: any = await response.json()
      if (!response.ok) {
        throw new Error(data?.error?.message || `OpenRouter returned HTTP ${response.status}`)
      }
      const reply = data?.choices?.[0]?.message?.content
      if (reply) return reply
      throw new Error('Empty response from OpenRouter')
    }

    if (openAiKey && openAiKey.trim()) {
      const model = process.env.AI_MODEL || 'gpt-4o-mini'
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: controller.signal
      })

      const data: any = await response.json()
      if (!response.ok) {
        throw new Error(data?.error?.message || `OpenAI returned HTTP ${response.status}`)
      }
      const reply = data?.choices?.[0]?.message?.content
      if (reply) return reply
      throw new Error('Empty response from OpenAI')
    }

    throw new Error('NO_API_KEY_CONFIGURED')
  } finally {
    clearTimeout(timeoutId)
  }
}

router.post('/', aiChatLimiter, async (req: Request, res: Response) => {
  try {
    let userMessage = ''
    const history: ChatMessage[] = []

    if (typeof req.body.message === 'string' && req.body.message.trim()) {
      userMessage = req.body.message.trim()
    } else if (Array.isArray(req.body.messages) && req.body.messages.length > 0) {
      const last = req.body.messages[req.body.messages.length - 1]
      if (last && typeof last.content === 'string') {
        userMessage = last.content.trim()
      }
    }

    if (!userMessage) {
      return res.status(400).json({ success: false, error: 'A message is required.' })
    }

    if (userMessage.length > 2000) {
      return res.status(400).json({ success: false, error: 'Message is too long (max 2000 characters).' })
    }

    if (Array.isArray(req.body.history)) {
      for (const item of req.body.history.slice(-10)) {
        if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') {
          history.push({
            role: item.role,
            content: item.content.slice(0, 2000)
          })
        }
      }
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userMessage }
    ]

    let reply = ''
    try {
      reply = await callLlm(fullMessages)
    } catch (llmErr: any) {
      console.warn('[AI Coach] LLM call failed, activating knowledge fallback:', llmErr?.message)
      reply = getFallbackReply(userMessage)
    }

    return res.json({
      success: true,
      reply,
      choices: [
        {
          message: {
            role: 'assistant',
            content: reply
          }
        }
      ]
    })
  } catch (err: any) {
    console.error('[AI Coach] Unexpected error:', err)
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred while processing your message.'
    })
  }
})

export default router
