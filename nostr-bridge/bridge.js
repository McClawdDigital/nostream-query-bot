const { SimplePool, getEventHash, finalizeEvent } = require('nostr-tools/pure')
const { nip04 } = require('nostr-tools')
const WebSocket = require('ws')
const http = require('http')
require('dotenv').config()

// ── config ────────────────────────────────────────────────────────────
const BOT_NSEC_HEX = process.env.BOT_NSEC
const RELAYS = (process.env.RELAYS || 'wss://nos.lol').split(',')
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL
const PORT = parseInt(process.env.PORT || '3000')
const MIN_ZAP_MSATS = parseInt(process.env.MIN_ZAP_MSATS || '10000000') // 10k sats
const ZAP_WINDOW_MS = parseInt(process.env.ZAP_WINDOW_MS || '600000') // 10 min

if (!BOT_NSEC_HEX) throw new Error('BOT_NSEC env var required')
if (!N8N_WEBHOOK_URL) throw new Error('N8N_WEBHOOK_URL env var required')

const pk = Buffer.from(BOT_NSEC_HEX, 'hex')
const BOT_PUBKEY_HEX = require('nostr-tools/pure').getPublicKey(pk)

// Temporary in-memory zap ledger: { [pubkey]: [{ msats, createdAt }, ...] }
const zapLedger = {}

function isPaid(pubkey) {
  const now = Date.now()
  const entries = (zapLedger[pubkey] || []).filter(
    (z) => now - z.createdAt <= ZAP_WINDOW_MS
  )
  const total = entries.reduce((sum, z) => sum + z.msats, 0)
  return total >= MIN_ZAP_MSATS
}

function addZap(pubkey, msats) {
  if (!zapLedger[pubkey]) zapLedger[pubkey] = []
  zapLedger[pubkey].push({ msats: parseInt(msats), createdAt: Date.now() })
  console.log(`Zap recorded: ${pubkey.slice(0, 16)}… +${msats} msats`)
}

// ── relay connection ──────────────────────────────────────────────────
const pool = new SimplePool()

async function connectRelays() {
  const sub = pool.subscribeMany(
    RELAYS,
    [
      { kinds: [4], '#p': [BOT_PUBKEY_HEX] },        // DMs to us
      { kinds: [9735], '#p': [BOT_PUBKEY_HEX] }       // Zap receipts
    ],
    {
      async onevent(ev) {
        if (ev.kind === 9735) {
          handleZapReceipt(ev)
        } else if (ev.kind === 4) {
          handleDM(ev)
        }
      },
      onclose(reason) {
        console.log('Relay close:', reason)
      },
      oneose() {}
    }
  )
  console.log('Subscribed to relays:', RELAYS.join(', '))
}

function handleZapReceipt(ev) {
  try {
    // NIP-57: zap receipt has a 'bolt11' tag but amount is usually in the zap request
    // The receipt references the request e-tag. Full preimage verification is TODO.
    // For MVP we trust relay-delivered receipts and take amount from #amount field.
    const amountTag = ev.tags.find(t => t[0] === 'amount')
    const pTags = ev.tags.filter(t => t[0] === 'p')
    // The first p tag is the recipient (us). We want the sender — that's not in the receipt directly.
    // In practice we track all zaps to us and credit generously for MVP.
    // Better: look at the e-tag referenced request to find the sender.
    const senderTag = ev.tags.find(t => t[0] === 'P')
    const sender = senderTag ? senderTag[1] : (pTags[1] ? pTags[1][1] : null)
    // Actually NIP-57 receipt has no sender. We just record globally for our pubkey.
    // This is a known MVP limitation: any zap receipt to our pubkey credits.
    const msats = amountTag ? parseInt(amountTag[1]) : 10000000 // fallback 10k
    addZap('_global', msats)
    console.log(`Zap receipt #${ev.id.slice(0, 8)}… amount=${msats}`)
  } catch (e) {
    console.error('Error handling zap receipt:', e.message)
  }
}

async function handleDM(ev) {
  try {
    console.log(`DM from ${ev.pubkey.slice(0, 16)}…`)
    // Decrypt NIP-04 DM content
    const skBytes = Buffer.from(BOT_NSEC_HEX, 'hex')
    const plaintext = await nip04.decrypt(skBytes, ev.pubkey, ev.content)
    console.log(`Decrypted: "${plaintext.slice(0, 80)}${plaintext.length > 80 ? '…' : ''}"`)

    // For MVP, credit check is simplistic — we check global zap total instead of per-user
    // because zap receipt doesn't carry sender in a reliable way without request lookup.
    // If you want per-user credit, maintain a proper ledger keyed by pubkey.
    const credited = isPaid('_global')
    if (!credited) {
      console.log('No zap credit. Sending paywall reply.')
      await reply(ev.pubkey, 'Send a 10,000 sat zap to this account, then send your question.')
      return
    }

    // Forward to n8n
    const payload = {
      query: plaintext,
      pubkey: ev.pubkey,
      eventId: ev.id,
      zapAmountMsats: MIN_ZAP_MSATS
    }

    console.log('Forwarding to n8n…')
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!resp.ok) {
      console.error('n8n webhook failed:', resp.status, await resp.text())
    } else {
      console.log('Forwarded successfully.')
    }
  } catch (e) {
    console.error('Error handling DM:', e.message)
  }
}

async function reply(toPubkey, text) {
  const eventTemplate = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', toPubkey]],
    content: await nip04.encrypt(Buffer.from(BOT_NSEC_HEX, 'hex'), toPubkey, text)
  }
  eventTemplate.id = getEventHash(eventTemplate)
  const signed = finalizeEvent(eventTemplate, Buffer.from(BOT_NSEC_HEX, 'hex'))

  const pubs = pool.publish(RELAYS, signed)
  await Promise.all(pubs.map(p => p.catch(() => {})))
  console.log(`Replied to ${toPubkey.slice(0, 16)}…`)
}

// ── HTTP publisher endpoint ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/publish') {
    res.writeHead(404).end()
    return
  }

  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', async () => {
    try {
      const { content, toPubkey } = JSON.parse(body)
      if (!content || !toPubkey) {
        res.writeHead(400).end(JSON.stringify({ error: 'content and toPubkey required' }))
        return
      }
      await reply(toPubkey, content)
      res.writeHead(200).end(JSON.stringify({ ok: true, eventId: (await reply).id || 'sent' }))
    } catch (e) {
      console.error('Publish error:', e.message)
      res.writeHead(500).end(JSON.stringify({ error: e.message }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`Bridge publish endpoint: http://localhost:${PORT}/publish`)
})

// ── start ─────────────────────────────────────────────────────────────
connectRelays().catch(err => {
  console.error('Fatal relay error:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('\nShutting down…')
  pool.close(RELAYS)
  server.close()
  process.exit(0)
})
