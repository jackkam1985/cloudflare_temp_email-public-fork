import { Hono } from 'hono'

import { triggerWebhook, triggerAnotherWorker, commonParseMail } from '../common'
import { sendMailToTelegram } from '../telegram_api'
import { extractEmailInfo } from './ai_extract'
import { storeRawMail } from './storage'

const api = new Hono<HonoCustomType>()

/**
 * POST /external/api/relay_email
 *
 * Accepts raw email relayed from a bridge Worker deployed in another
 * Cloudflare account (where the domain lives).
 *
 * Auth: X-Relay-Secret header must match env.MAIL_RELAY_SECRET
 *
 * Body (JSON):
 *   from       - envelope sender address
 *   to         - envelope recipient address
 *   rawEmail   - full raw RFC-822 email string
 *   messageId  - (optional) Message-ID header value
 */
api.post('/external/api/relay_email', async (c) => {
    // --- Authentication ---
    const secret = c.req.header('X-Relay-Secret')
    if (!c.env.MAIL_RELAY_SECRET || secret !== c.env.MAIL_RELAY_SECRET) {
        return c.text('Unauthorized', 401)
    }

    let from: string, to: string, rawEmail: string, messageId: string | null
    try {
        const body = await c.req.json<{
            from: string
            to: string
            rawEmail: string
            messageId?: string | null
        }>()
        from = body.from
        to = body.to
        rawEmail = body.rawEmail
        messageId = body.messageId ?? null
    } catch (_) {
        return c.text('Invalid JSON body', 400)
    }

    if (!from || !to || !rawEmail) {
        return c.text('Missing required fields: from, to, rawEmail', 400)
    }

    const parsedEmailContext: ParsedEmailContext = { rawEmail }

    // --- Save to DB (gzip / read-status aware, same storage path as the email worker) ---
    let storedMailId: number | undefined
    try {
        const { success, meta } = await storeRawMail(c.env, from, to, messageId, rawEmail)
        if (!success) {
            console.error(`relay: failed to save message from ${from} to ${to}`)
            return c.text('Failed to save email', 500)
        }
        storedMailId = meta.last_row_id
    } catch (error) {
        console.error('relay: save email error', error)
        return c.text('Failed to save email', 500)
    }

    // --- AI extraction (result is reused by telegram / webhook) ---
    const aiExtractResult = await extractEmailInfo(parsedEmailContext, c.env, messageId, to)

    // --- Telegram notification ---
    try {
        await sendMailToTelegram(c, to, parsedEmailContext, messageId, aiExtractResult)
    } catch (error) {
        console.error('relay: telegram error', error)
    }

    // --- Webhook ---
    try {
        await triggerWebhook(c, to, parsedEmailContext, storedMailId, aiExtractResult)
    } catch (error) {
        console.error('relay: webhook error', error)
    }

    // --- Another Worker (RPC) ---
    try {
        const parsedEmail = await commonParseMail(parsedEmailContext)
        const parsedText = parsedEmail?.text ?? ''
        const rpcEmail: RPCEmailMessage = {
            from,
            to,
            rawEmail,
            headers: {},
        }
        await triggerAnotherWorker(c, rpcEmail, parsedText)
    } catch (error) {
        console.error('relay: another worker error', error)
    }

    return c.json({ status: 'ok' })
})

export { api }
