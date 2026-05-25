/**
 * Nostream Query Bot — Cloudflare Worker Bridge
 *
 * This Worker replaces the persistent Node.js bridge.
 * It runs on Cloudflare's edge: zero servers, zero uptime monitoring.
 *
 * Roles:
 *   1. Triggered by a Cron schedule every 2 minutes: polls Nostr public relays for
 *      new zap receipts (kind 9735) and DMs (kind 4) to the bot pubkey.
 *   2. On finding a paid DM, it forwards the query to the N8N_WEBHOOK_URL.
 *   3. Exposes POST /publish: receives {content, toPubkey} from n8n, signs and
 *      publishes an encrypted DM reply.
 *
 * No relay needed — we subscribe to existing public relays.
 * No persistent process — runs only on-demand (cron + HTTP).
 */

import { SimplePool, finalizeEvent, getPublicKey, nip04 } from 'nostr-tools'

const RELAYS = (typeof RELAYS !== 'undefined' ? RELAYS : 'wss://nos.lol,wss://relay.damus.io,wss://nostr.mom').split(',')
const N8N_WEBHOOK_URL = typeof N8N_WEBHOOK_URL !== 'undefined' ? N8N_WEBHOOK_URL : ''
const KV_NAMESPACE = 'KV' // bound via Wrangler

/**
 * Main entrypoint
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // POST /publish — n8n calls this to send the answer back as a Nostr DM
    if (request.method === 'POST' && url.pathname === '/publish') {
      return await handlePublish(await request.json(), env)
    }

    // GET /poll — n8n cron can hit this to trigger a manual poll
    if (request.method === 'GET' && url.pathname === '/poll') {
      return await handlePoll(env)
    }

    return new Response('Not Found', { status: 404 })
  },

  // Cron trigger — runs every 2 minutes automatically
  async scheduled(controller, env, ctx) {
    await handlePoll(env)
  }
}

/**
 * Poll relays for new DMs and zap receipts.
 * Tracks processed event IDs in KV to avoid duplicates.
 */
async function handlePoll(env) {
  if (!env.BOT_NSEC_HEX) {
    return new Response('Missing BOT_NSEC_HEX secret', { status: 500 })
  }

  const botSk = Buffer.from(env.BOT_NSEC_HEX, 'hex')
  const botPk = getPublicKey(botSk)

  // Use SimplePool to connect to multiple relays
  const pool = new SimplePool()

  // Build filter for events relevant to the bot pubkey
  const filter = {
    kinds: [4, 9735],
    '#p': [botPk],
    since: Math.floor(Date.now() / 1000) - 300 // last 5 minutes buffer
  }

  const events = []

  // Brief subscription: collect events for up to 10 seconds
  const sub = pool.subscribeMany(RELAYS, [filter], {
    onevent(ev) { events.push(ev) },
    oneose() {} // mark end-of-stored
  })

  await new Promise(r => setTimeout(r, 10000)) // 10 sec window
  pool.close(RELAYS)

  // Process events
  let forwarded = 0
  let zapsTotal = 0

  // Track zap credits: we need a simple ledger
  const ledger = await getLedger(env)

  for (const ev of events) {
    // Skip already-processed event
    if (await wasProcessed(env, ev.id)) continue
    await markProcessed(env, ev.id)

    if (ev.kind === 9735) {
      // Zap receipt
      const amountTag = ev.tags.find(t => t[0] === 'amount')
      const msats = amountTag ? parseInt(amountTag[1]) : 0
      if (msats > 0) {
        // Zap receipts don't reliably carry sender pubkey in NIP-57
        // For MVP we credit a global bucket; per-user credit is a known gap
        zapsTotal += msats
        ledger['_global'] = (ledger['_global'] || 0) + msats
        console.log('Zap receipt:', msats, 'msats')
      }
    }

    if (ev.kind === 4) {
      // Encrypted DM
      try {
        const plaintext = await nip04.decrypt(botSk, ev.pubkey, ev.content)
        // For MVP: simple global credit check
        const MIN_ZAP = 10000000 // 10k sats
        if ((ledger['_global'] || 0) >= MIN_ZAP) {
          // Debit from global bucket
          ledger['_global'] -= MIN_ZAP
          await saveLedger(env, ledger)

          // Forward to n8n
          await fetch(env.N8N_WEBHOOK_URL || N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: plaintext,
              pubkey: ev.pubkey,
              eventId: ev.id,
              zapAmountMsats: MIN_ZAP
            })
          })
          forwarded++
        } else {
          // Auto-reply: no credit
          await publishDM(env, botSk, ev.pubkey, 'Send a 10,000 sat zap to this account, then send your question.')
        }
      } catch (e) {
        console.error('Error decrypting DM event ' + ev.id + ':', e.message)
      }
    }
  }

  return new Response(JSON.stringify({ forwarded, zapsTotal, eventsFetched: events.length }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * Publish a DM reply back to the user.
 * Called by n8n via POST /publish
 */
async function handlePublish(body, env) {
  const { content, toPubkey } = body
  if (!content || !toPubkey) {
    return new Response(JSON.stringify({ error: 'content and toPubkey required' }), { status: 400 })
  }

  const botSk = Buffer.from(env.BOT_NSEC_HEX, 'hex')
  await publishDM(env, botSk, toPubkey, content)

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * Encrypt and publish a kind:4 DM via the relay pool.
 */
async function publishDM(env, botSk, toPubkey, text) {
  const ciphertext = await nip04.encrypt(botSk, toPubkey, text)
  const event = finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', toPubkey]],
    content: ciphertext
  }, botSk)

  const pool = new SimplePool()
  await Promise.all(
    RELAYS.map(async relay => {
      try { await pool.publish([relay], event) }
      catch (e) { console.error('Publish fail for', relay, e.message) }
    })
  )
  pool.close(RELAYS)
}

// KV helpers: simple ledger and event deduplication
async function getLedger(env) {
  try { return JSON.parse(await env.KV.get('zap_ledger') || '{}') }
  catch (e) { return {} }
}
async function saveLedger(env, ledger) {
  await env.KV.put('zap_ledger', JSON.stringify(ledger))
}
async function wasProcessed(env, eventId) {
  const val = await env.KV.get('proc_' + eventId)
  return val === '1'
}
async function markProcessed(env, eventId) {
  // Keep for 1 day then auto-expire (requires KV TTL config)
  await env.KV.put('proc_' + eventId, '1', { expirationTtl: 86400 })
}
