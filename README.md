# Nostream Query Bot

A lightweight Nostr bot that lets users pay 10,000 sats (via Lightning zap) to ask plain-language questions about the Nostream BigQuery dataset, and get an answer back — all through Nostr.

**Status:** Validation MVP. Zero infrastructure overhead.

---

## How It Works (30-Second Version)

1. **User zaps the bot 10,000 sats** on any Nostr client (Damus, Amethyst, Primal, etc.)
2. **User DMs the bot** a plain-language question like *"How many notes were posted last week?"*
3. A **Cloudflare Worker** (scheduled every 2 minutes) polls public Nostr relays, decrypts the DM, checks for zap credit, and forwards the question to **n8n**
4. **n8n**: Gemini turns the question → BigQuery SQL → runs the query → formats the result
5. **n8n POSTs the answer** back to the Worker's `/publish` endpoint, which encrypts and delivers a DM reply to the user

That's it. Zero servers, zero relay setup, zero maintenance. You only need:
- A Cloudflare account (free)
- An n8n instance (cloud or self-hosted)
- A Google AI Studio API key (free tier) and BigQuery access

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  User (Nostr)   │     │  Cloudflare Worker   │
│  Client ────────────────▶│                     │
└─────────────────┘     │  ─ Cron poll         │
                         │  ─ NIP-04 decrypt    │
                         │  ─ Check zap credit  │
                         │  ─ POST to n8n       │
                         └──────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   n8n Workflow    │
                         │ ─ Gemini NL→SQL    │
                         │ ─ BigQuery exec    │
                         │ ─ Format reply     │
                         └──────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  Cloudflare Worker   │──▶ Relay(s)
                         │  POST /publish ─────│──▶ User DM reply
                         │  ─ NIP-04 encrypt   │
                         └──────────────────┘
```

**Key design decision:** No relay = no running Nostream, no relay maintenance. The bot is just an account (npub) that listens and replies on public relays.

---

## What You Need

| Tool | For | Free Tier? |
|------|-----|------------|
| Cloudflare Account | Worker runs here (100k requests/day free) | ✅ |
| n8n | Workflow engine (cloud or self-hosted) | ✅ (cloud free tier) |
| Google AI Studio | Gemini API key for NL→SQL | ✅ (1,500 req/day) |
| BigQuery dataset | Your Nostr data in GCP | — (you already have this) |
| Lightning wallet | Bot receives zaps | — (any LN wallet with LNURL) |

---

## Setup

### 1. Generate Bot Keys

```bash
node scripts/generate-keys.js
# Keep the nsec somewhere safe. Share the npub.
```

Then get a Lightning LNURL-pay endpoint for that pubkey so users can zap it. (NIP-57 — most clients generate this automatically when you paste the npub.)

### 2. Deploy the Cloudflare Worker

```bash
cd cf-worker-bridge
npm install
# Set your secrets
echo "your_hex_private_key" | npx wrangler secret put BOT_NSEC_HEX
# Update wrangler.toml with your N8N_WEBHOOK_URL, then deploy
npx wrangler deploy
```

The Worker will:
- Run every 2 minutes to scan for new DMs + zaps
- Track zap credits in Cloudflare KV (free tier: 100k/day reads/writes)
- Expose `POST /publish` for n8n to call back with answers

### 3. Configure the n8n Workflow

Import `n8n-workflows/query-bot-workflow.json` into your n8n instance. Set these credentials in the n8n UI:

| Credential | Where Used |
|------------|-----------|
| `GEMINI_API_KEY` | HTTP Request node → Gemini API |
| Google BigQuery OAuth2 | BigQuery SQL execution node |

Set environment variables in n8n:
- `BQ_PROJECT_ID` — your GCP project
- `CF_PUBLISH_URL` — `https://<worker-subdomain>.workers.dev/publish`

### 4. Edit Schema Context

Open `docs/schema-context.md` and replace the placeholder table definitions with the actual structure of your BigQuery dataset. This is fed into every Gemini prompt so the LLM knows what columns exist and what queries are valid.

---

## File Structure

```
nostream-query-bot/
├── README.md                           # You're here
├── docs/
│   ├── architecture.md                 # Data-flow diagrams, failure modes, security notes
│   └── schema-context.md              # Table definitions fed to Gemini prompt
├── n8n-workflows/
│   ├── query-bot-workflow.json        # Importable n8n workflow (starter)
│   └── NODE_SETUP.md                 # Manual node-by-node guide
├── cf-worker-bridge/                 # ← Cloudflare Worker (replaces old Node.js bridge)
│   ├── worker.js
│   ├── wrangler.toml
│   └── package.json
├── nostr-bridge/                     # ← Legacy Node.js bridge (kept for reference)
│   ├── bridge.js
│   ├── package.json
│   └── .env.example
└── scripts/
    └── generate-keys.js              # Generates bot nsec/npub pair
```

> **Why both `cf-worker-bridge/` and `nostr-bridge/`?** The `cf-worker-bridge` is the simplified MVP. `nostr-bridge` is the original Node.js implementation — kept as reference if you later want a persistent process for production.

---

## n8n Workflow Nodes (in brief)

| # | Node | What It Does |
|---|------|-------------|
| 1 | **Webhook** | Triggered by the Cloudflare Worker (POST with `{query, pubkey, eventId}`) |
| 2 | **Code** | Extract user query and pubkey from payload |
| 3 | **Code** | Build Gemini prompt from `docs/schema-context.md` + user query |
| 4 | **HTTP Request** | Call Gemini API (`gemini-2.0-flash`) → get SQL |
| 5 | **Code** | Parse SQL out of Gemini's markdown response |
| 6 | **HTTP Request** | Execute SQL on BigQuery (`projects/{BQ_PROJECT_ID}/queries`) |
| 7 | **Code** | Format result rows as a concise text reply |
| 8 | **HTTP Request** | POST result back to Cloudflare Worker `/publish` endpoint |

Full step-by-step instructions in [`n8n-workflows/NODE_SETUP.md`](n8n-workflows/NODE_SETUP.md).

---

## Pricing Reality Check

| Component | Expected Monthly Cost (light usage) |
|-----------|-----------------------------------|
| Cloudflare Worker | **$0** (well under free tier) |
| Cloudflare KV | **$0** (under free tier for cred tracking) |
| Gemini API (Google AI Studio) | **$0** (1,500 free requests/day) |
| BigQuery | **~$0.05–$0.20** (depends on query complexity; simple aggregations cost cents) |
| n8n (Cloud free tier or self-hosted) | **$0** |

**Bottom line:** This MVP costs almost nothing to run.

---

## Known Gaps (Validation → Production)

| Gap | Why It's Okay for MVP |
|-----|----------------------|
| Zap sender not verified cryptographically | Relays could fake receipts. But for a validation test with trusted users, fine. |
| Credit is global, not per-user | Anyone's zap counts for anyone. Fine for a small test group. |
| Ordered reply delivery not guaranteed | DMs may drop on relays. Fine for informational queries. |
| No rate limiting | Could be spammed. Monitor BigQuery costs and set `MAX_BYTES_BILLED`. |
| NIP-04 DMs are not private | The simplest DM standard. NIP-17 (gift-wrapped) is better but harder. |

If demand is proven, **next iteration** is: per-user verified Ledger + NIP-17 private DMs + rate limiting + per-query cost estimation.

---

## What to Test First

1. [ ] Set up a test Nostr account (using `generate-keys.js`), fund it with 10k sats via a lightning wallet
2. [ ] Deploy the Worker and configure the n8n workflow
3. [ ] Send a DM from the test account — watch the Worker log, check n8n execution, get reply
4. [ ] If the reply works, invite 3–5 beta testers
5. [ ] If no one pays for queries after a week, you didn't need to build anything bigger. That's a win.

---

License: MIT
