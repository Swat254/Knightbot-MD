// =========================
//      KNIGHT BOT v2
//     (Email First Auth)
// =========================

require('./settings')
const fs = require('fs')
const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')
const dayjs = require('dayjs')
const NodeCache = require('node-cache')
const pino = require('pino')
const store = require('./lib/lightweight_store')
const { smsg } = require('./lib/myfunc')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')

// -------------------- ENV --------------------
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const OPENAI_KEY = process.env.OPENAI_KEY
const WEBSITE_URL = process.env.WEBSITE_URL

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY || !WEBSITE_URL) {
    console.error("❌ Missing one or more environment variables!")
    process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_KEY })

// ---------------- WHATSAPP SENDER ----------------
async function sendWhatsApp(bot, to, text) {
    try { await bot.sendMessage(to, { text }) }
    catch (err) { console.log("Send error:", err.message) }
}

// This cache stores: { phoneNumber: email }
const emailSession = new NodeCache({ stdTTL: 600 }) // 10 minutes

// ---------------- MAIN BOT ----------------
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
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino({ level: 'error' }).child({ level: 'fatal' })
                )
            },
            msgRetryCounterCache,
            keepAliveIntervalMs: 10000
        })

        store.bind(bot)
        bot.ev.on('creds.update', saveCreds)

        // ---------------- MESSAGE HANDLER ----------------
        bot.ev.on('messages.upsert', async (msgData) => {
            try {
                const msg = msgData.messages[0]
                if (!msg.message) return

                const from = msg.key.remoteJid

                if (msg.key.remoteJid === "status@broadcast") return

                const parsed = smsg(bot, msg, store)
                let text = parsed.message?.trim() || ""

                console.log("User:", from, "Said:", text)

                // ---------------------------------------
                //  STEP 1 — ASK FOR EMAIL FIRST
                // ---------------------------------------

                let savedEmail = emailSession.get(from)

                if (!savedEmail) {
                    if (!text.includes("@")) {
                        await sendWhatsApp(bot, from,
`👋 Hello! Before we continue, please enter your *email address*.

This lets me connect to your account on the website.`)
                        return
                    }

                    // user sent email — verify from DB
                    const { data: users, error } = await supabase
                        .from("users")
                        .select("*")
                        .eq("email", text.toLowerCase())

                    if (error) {
                        await sendWhatsApp(bot, from, "⚠️ Server error. Try again later.")
                        return
                    }

                    if (!users || users.length === 0) {
                        await sendWhatsApp(bot, from,
`❌ That email is not registered.

Please use the email you used on the website.`)
                        return
                    }

                    const user = users[0]
                    emailSession.set(from, user.email)

                    await sendWhatsApp(bot, from,
`✅ Your account is verified!

How can I assist you today?  
You can ask things like:

• "deposit 1000"  
• "withdraw 500"  
• "invest 2000 silver"  
• "show my balance"  
• or *ask anything* — I am powered by AI 🤖`)
                    return
                }

                // ---------------------------------------
                //  STEP 2 — EMAIL VERIFIED → LOAD USER
                // ---------------------------------------

                const email = savedEmail
                const { data: users } = await supabase
                    .from("users")
                    .select("*")
                    .eq("email", email)

                const user = users?.[0]
                if (!user) {
                    emailSession.del(from)
                    await sendWhatsApp(bot, from, "❌ Session expired. Please send your email again.")
                    return
                }

                // load plans + investments
                const { data: plans } = await supabase.from("plans").select("*")
                const { data: investments } = await supabase
                    .from("investments")
                    .select("*")
                    .eq("user_id", user.id)
                    .eq("active", true)

                let reply = ""

                // ---------------------------------------
                //          DEPOSIT LOGIC
                // ---------------------------------------
                const dep = text.match(/deposit (\d+)/i)
                if (dep) {
                    const amount = parseFloat(dep[1])
                    const newBal = user.balance + amount

                    await supabase.from("users")
                        .update({ balance: newBal })
                        .eq("id", user.id)

                    user.balance = newBal

                    await supabase.from("transactions").insert([{
                        user_id: user.id,
                        type: "deposit",
                        amount,
                        status: "approved",
                        created_at: dayjs().format()
                    }])

                    reply = `💰 Deposit of ${amount} confirmed.\nYour new balance is *${newBal}*.`
                }

                // ---------------------------------------
                //          WITHDRAW LOGIC
                // ---------------------------------------
                const wd = text.match(/withdraw (\d+)/i)
                if (wd) {
                    const amount = parseFloat(wd[1])
                    if (amount > user.balance) {
                        reply = "⚠️ You do not have enough balance."
                    } else {
                        const newBal = user.balance - amount

                        await supabase.from("users")
                            .update({ balance: newBal })
                            .eq("id", user.id)

                        user.balance = newBal

                        await supabase.from("transactions").insert([{
                            user_id: user.id,
                            type: "withdraw",
                            amount,
                            status: "approved",
                            created_at: dayjs().format()
                        }])

                        reply = `💸 Withdrawal of ${amount} completed.\nNew balance: *${newBal}*.`
                    }
                }

                // ---------------------------------------
                //          INVEST LOGIC
                // ---------------------------------------
                const inv = text.match(/invest (\d+) (\w+)/i)
                if (inv) {
                    const amount = parseFloat(inv[1])
                    const planName = inv[2].toLowerCase()

                    const plan = plans.find(p => p.name.toLowerCase() === planName)

                    if (!plan) reply = `❌ Plan '${planName}' not found.`
                    else if (amount < plan.min_investment)
                        reply = `Minimum for ${plan.name} is ${plan.min_investment}.`
                    else if (amount > user.balance)
                        reply = `You don't have enough balance.`
                    else {
                        const start = dayjs()
                        const end = start.add(plan.duration_days, "day")

                        await supabase.from("investments").insert([{
                            user_id: user.id,
                            plan_id: plan.id,
                            amount,
                            start_date: start.format("YYYY-MM-DD"),
                            end_date: end.format("YYYY-MM-DD"),
                            last_calculated: start.format("YYYY-MM-DD"),
                            active: true
                        }])

                        await supabase.from("users")
                            .update({ balance: user.balance - amount })
                            .eq("id", user.id)

                        user.balance -= amount

                        reply = 
`📈 You invested *${amount}* in *${plan.name}*!
Your plan ends: ${end.format("YYYY-MM-DD")}`
                    }
                }

                // ---------------------------------------
                //          GPT ANSWER SYSTEM
                // ---------------------------------------
                if (!reply) {
                    let siteContent = ""
                    try {
                        siteContent = (await axios.get(WEBSITE_URL)).data.slice(0, 3000)
                    } catch {}

                    const prompt = `
You are the official AI assistant for the website.
User email: ${user.email}
User balance: ${user.balance}
User investments: ${JSON.stringify(investments)}
User message: "${text}"

Website content:
${siteContent}

Respond clearly and helpfully.
                    `

                    const gpt = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [{ role: "user", content: prompt }],
                        max_tokens: 500
                    })

                    reply = gpt.choices[0].message.content
                }

                await sendWhatsApp(bot, from, reply)

            } catch (err) {
                console.log("Message Error:", err)
            }
        })

        // CONNECTION EVENTS
        bot.ev.on('connection.update', (update) => {
            if (update.qr) console.log("📌 Scan the QR code to login.")
            if (update.connection === "open") console.log("✅ Bot Connected!")
            if (update.connection === "close") {
                console.log("❌ Disconnected. Restarting…")
                process.exit(0) // PM2/nodemon restarts automatically
            }
        })

    } catch (err) {
        console.error("Fatal Error:", err)
        process.exit(1)
    }
}

startKnightBot()
