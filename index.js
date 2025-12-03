require('dotenv').config()

// ------------------ Imports ------------------
const fs = require('fs')
const axios = require('axios')
const dayjs = require('dayjs')
const OpenAI = require('openai')
const NodeCache = require('node-cache')
const pino = require('pino')
const { createClient } = require('@supabase/supabase-js')
const { smsg } = require('./lib/myfunc')
const store = require('./lib/lightweight_store')

const { 
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys')

// Load store
store.readFromFile()
setInterval(() => store.writeToFile(), 10000)

// ------------------ ENV Check ------------------
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_KEY', 'OPENAI_KEY', 'WEBSITE_URL']
REQUIRED_ENV.forEach(key => {
    if (!process.env[key]) {
        console.error(`❌ Missing environment variable: ${key}`)
        process.exit(1)
    }
})

// ------------------ Services ------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY })
let websiteCache = ""


// ------------------ Load website once ------------------
async function preloadWebsite() {
    try {
        websiteCache = (await axios.get(process.env.WEBSITE_URL)).data
        console.log("🌐 Website cached successfully.")
    } catch (err) {
        console.log("⚠ Failed to load website:", err.message)
    }
}
preloadWebsite()
setInterval(preloadWebsite, 1000 * 60 * 5) // refresh every 5 minutes


// ------------------ WhatsApp Helper ------------------
async function sendWhatsApp(bot, to, body) {
    try {
        await bot.sendMessage(to, { text: body })
    } catch (err) {
        console.log("Send error:", err.message)
    }
}


// ------------------ START KNIGHT BOT ------------------
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
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            msgRetryCounterCache
        })

        store.bind(bot)
        bot.ev.on('creds.update', saveCreds)

        // ------------------ Message Handling ------------------
        bot.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0]
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return

            const from = msg.key.remoteJid
            
            let parsed
            try {
                parsed = smsg(bot, msg, store)
            } catch {
                return
            }

            const text = parsed?.message?.trim() || ""
            if (!text) return

            console.log("Message from", from, ":", text)

            // ------------- STEP 1: Check if number is known -------------
            let { data: users } = await supabase
                .from("users")
                .select("*")
                .eq("phone", from)

            let user = users?.[0]

            if (!user) {
                await sendWhatsApp(bot, from,
`Hello 👋  
Before we continue, please enter your **account email** registered on the website.`)
                return
            }

            // ------------- STEP 2: If user has no email, treat next message as email -------------
            if (!user.email_verified) {
                const email = text.toLowerCase().trim()

                const { data: match } = await supabase
                    .from("users")
                    .select("*")
                    .eq("email", email)
                    .single()

                if (!match) {
                    await sendWhatsApp(bot, from,
`❌ The email **${email}** was not found in our system.  
Please enter a valid registered email.`)
                    return
                }

                await supabase.from("users")
                    .update({ email_verified: true, email })
                    .eq("id", match.id)

                await sendWhatsApp(bot, from,
`✅ Email verified successfully!  
You can now ask anything — investments, balance, account info, website details, etc.`)

                user = match
                return
            }


            // ------------- Step 3: DEPOSIT -------------
            if (/^deposit \d+$/i.test(text)) {
                const amount = Number(text.split(" ")[1])
                const newBalance = user.balance + amount

                await supabase.from("users")
                    .update({ balance: newBalance })
                    .eq("id", user.id)

                await sendWhatsApp(bot, from,
`💰 Deposit successful!  
Amount: **${amount}**  
New Balance: **${newBalance}**`)
                return
            }

            // ------------- Step 4: WITHDRAW -------------
            if (/^withdraw \d+$/i.test(text)) {
                const amount = Number(text.split(" ")[1])

                if (amount > user.balance) {
                    await sendWhatsApp(bot, from, "❌ Insufficient balance.")
                    return
                }

                const newBalance = user.balance - amount

                await supabase.from("users")
                    .update({ balance: newBalance })
                    .eq("id", user.id)

                await sendWhatsApp(bot, from,
`💵 Withdrawal processed!  
Amount: **${amount}**  
New Balance: **${newBalance}**`)
                return
            }


            // ------------- Step 5: GPT ASSISTANT for everything else -------------
            const prompt = `
You are the official assistant of Zent Finance.

User message:
"${text}"

User profile:
${JSON.stringify(user)}

Website content:
${websiteCache}

Respond as a friendly finance customer support assistant.
Be helpful, factual, and direct.
            `

            const ai = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500
            })

            const answer = ai.choices[0].message.content
            await sendWhatsApp(bot, from, answer)
        })


        // ------------------ Connection Handling ------------------
        bot.ev.on("connection.update", async (update) => {
            if (update.connection === "open") console.log("✅ WhatsApp Connected.")
            if (update.qr) console.log("📌 Scan QR Code to Login")
            if (update.connection === "close") {
                console.log("❌ Connection closed. Restarting...")
                process.exit(0)
            }
        })

    } catch (err) {
        console.log("Fatal bot error:", err)
        process.exit(1)
    }
}

startKnightBot()
