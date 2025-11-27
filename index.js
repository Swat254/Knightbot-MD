require('./settings')
const fs = require('fs')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const dayjs = require('dayjs')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main')
const { smsg, jidDecode } = require('./lib/myfunc')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const NodeCache = require('node-cache')
const pino = require('pino')
const readline = require('readline')
const { rmSync } = require('fs')
const store = require('./lib/lightweight_store')

store.readFromFile()
const settings = require('./settings')
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000)

// -------------------- ENVIRONMENT VARIABLES --------------------
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const OPENAI_KEY = process.env.OPENAI_KEY
const WEBSITE_URL = process.env.WEBSITE_URL
// ---------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_KEY })

// ------------------ WhatsApp Helper ------------------
async function sendWhatsApp(bot, to, body) {
    try {
        await bot.sendMessage(to, { text: body })
    } catch (err) {
        console.error('WhatsApp send error:', err.message)
    }
}

// ------------------ Core Knight Bot ------------------
async function startKnightBot() {
    try {
        const { version } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMultiFileAuthState('./session')
        const msgRetryCounterCache = new NodeCache()

        const bot = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
            },
            msgRetryCounterCache,
            keepAliveIntervalMs: 10000
        })

        store.bind(bot)
        bot.ev.on('creds.update', saveCreds)

        bot.ev.on('messages.upsert', async m => {
            const msg = m.messages[0]
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return

            const from = msg.key.remoteJid
            const text = smsg(bot, msg, store).message

            console.log('Parsed message:', { from, text })

            // ------------------ Fetch user ------------------
            const { data: users } = await supabase.from('users').select('*').eq('phone', from)
            const user = users?.[0]

            if (!user) {
                await sendWhatsApp(bot, from, 'Hello! I could not find your account. Please register on the website first.')
                return
            }

            // ------------------ Fetch plans and investments ------------------
            const { data: plans } = await supabase.from('plans').select('*')
            const { data: investments } = await supabase.from('investments').select('*').eq('user_id', user.id).eq('active', true)

            // ------------------ Fetch website content ------------------
            let websiteContent = ''
            try { websiteContent = (await axios.get(WEBSITE_URL)).data } catch {}

            let reply = ''

            // ------------------ Deposit ------------------
            const depositMatch = text.match(/deposit (\d+)/i)
            if (depositMatch) {
                const amount = parseFloat(depositMatch[1])
                await supabase.from('users').update({ balance: user.balance + amount }).eq('id', user.id)
                await supabase.from('transactions').insert([{ user_id: user.id, type: 'deposit', amount, status: 'approved', created_at: dayjs().format() }])
                reply = `Deposit of ${amount} successful. New balance: ${user.balance + amount}.`
            }

            // ------------------ Withdraw ------------------
            const withdrawMatch = text.match(/withdraw (\d+)/i)
            if (withdrawMatch) {
                const amount = parseFloat(withdrawMatch[1])
                if (amount > user.balance) reply = `You do not have enough balance.`
                else {
                    await supabase.from('users').update({ balance: user.balance - amount }).eq('id', user.id)
                    await supabase.from('transactions').insert([{ user_id: user.id, type: 'withdraw', amount, status: 'approved', created_at: dayjs().format() }])
                    reply = `Withdrawal of ${amount} successful. New balance: ${user.balance - amount}.`
                }
            }

            // ------------------ Invest ------------------
            const investMatch = text.match(/invest (\d+) (\w+)/i)
            if (investMatch) {
                const amount = parseFloat(investMatch[1])
                const planName = investMatch[2].toUpperCase()
                const plan = plans.find(p => p.name.toUpperCase() === planName)

                if (!plan) reply = `Plan ${planName} not found.`
                else if (amount < plan.min_investment) reply = `Minimum investment for ${planName} is ${plan.min_investment}.`
                else if (amount > user.balance) reply = `You do not have enough balance.`
                else {
                    const startDate = dayjs()
                    const endDate = startDate.add(plan.duration_days, 'day')
                    await supabase.from('investments').insert([{
                        user_id: user.id,
                        plan_id: plan.id,
                        amount,
                        start_date: startDate.format('YYYY-MM-DD'),
                        end_date: endDate.format('YYYY-MM-DD'),
                        last_calculated: startDate.format('YYYY-MM-DD'),
                        active: true
                    }])
                    await supabase.from('users').update({ balance: user.balance - amount }).eq('id', user.id)
                    reply = `Investment of ${amount} in ${plan.name} started! Ends on ${endDate.format('YYYY-MM-DD')}.`
                }
            }

            // ------------------ GPT fallback ------------------
            if (!reply) {
                const gptPrompt = `
You are a financial AI assistant for Zent Finance.
User message: "${text}"
Website content: "${websiteContent}"
User data: ${JSON.stringify(user)}
Active investments: ${JSON.stringify(investments)}
Investment plans: ${JSON.stringify(plans)}
Answer naturally as a friendly finance advisor.
                `
                const gptResponse = await openai.chat.completions.create({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: gptPrompt }],
                    max_tokens: 500
                })
                reply = gptResponse.choices[0].message.content
            }

            await sendWhatsApp(bot, from, reply)
        })

        // Connection handling
        bot.ev.on('connection.update', async (update) => {
            if (update.qr) console.log('📱 Scan QR code to login')
            if (update.connection === 'open') console.log('✅ Knight Bot Connected!')
            if (update.connection === 'close') {
                console.log('❌ Connection closed, reconnecting...')
                await startKnightBot()
            }
        })

        return bot
    } catch (err) {
        console.error('Fatal bot error:', err)
        setTimeout(startKnightBot, 5000)
    }
}

startKnightBot()
