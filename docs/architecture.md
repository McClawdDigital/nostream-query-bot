# Nostream Query Bot - Architecture

This doc covers the full system design. README.md is the quick-start.

## Component Responsibilities

### 1. Nostr Bridge (`nostr-bridge/bridge.js`)

A lightweight Node.js service with two jobs:

1. **Forwarder (WebSocket → HTTP)**
   - Connects to Nostr relays via WebSocket
   - Subscribes to events `#p` = bot pubkey
   - Listens for:
     - `kind:4` (DMs) containing user queries
     - `kind:9735` (Zap Receipt) confirming payment
   - Stores zap timestamps in-memory: `{ pubkey: [timestamps...] }`
   - On DM: checks if pubkey has a zap within `ZAP_WINDOW_MS` that totals ≥ `MIN_ZAP_MSATS`
   - If paid: POSTs to `N8N_WEBHOOK_URL` with JSON payload
   - If not paid: auto-replies via relay telling user to zap

2. **Publisher (HTTP → WebSocket)**
   - Runs an HTTP server on `PORT`
   - Exposes `POST /publish` endpoint
   - Receives JSON from n8n: `{ "content": "result text", "toPubkey": "hex" }`
   - NIP-44 encrypts content to recipient
   - Creates `kind:4` event
   - Signs and sends to all configured relays

**Why separate from n8n?** n8n's Nostr node ecosystem is fragmented. A tiny bridge keeps the protocol logic in our code while n8n handles the orchestration and LLM integration.

### 2. n8n Workflow

The brain of the bot. Triggered by the bridge's HTTP POST to the webhook.

**Nodes (in execution order):**

| # | Node | Purpose |
|---|------|---------|
| 1 | **Webhook** | Receives payload from bridge. `data.query` = user text; `data.pubkey` = user hex key |
| 2 | **Read Schema Context** | Reads `docs/schema-context.md` (or a static variable) into the workflow |
| 3 | **Code: Build Prompt** | Composes the full Gemini prompt with schema + user query |
| 4 | **HTTP Request: Gemini** | POSTs to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` with API key |
| 5 | **Code: Parse SQL** | Extracts SQL from Gemini's JSON response |
| 6 | **HTTP Request: BigQuery** | Posts to `https://bigquery.googleapis.com/bigquery/v2/projects/{projectId}/queries` with parsed SQL |
| 7 | **Code: Format Reply** | Converts BigQuery JSON result to a concise text reply |
| 8 | **HTTP Request: Publish** | POSTs `{ content, toPubkey }` back to the bridge's `/publish` endpoint |

**Payload shape (bridge → n8n webhook):**

```json
{
  "query": "How many notes were created last week?",
  "pubkey": "<user hex pubkey>",
  "eventId": "<kind 4 event id hex>",
  "zapAmountMsats": 10000000
}
```

### 3. Schema Context (`docs/schema-context.md`)

A markdown file that describes the tables the LLM can query. This is embedded into every prompt.

Keep it concise — LLMs have token budgets. One table per section, with: table name, description, key columns, and sample query.

**Example structure:**

```markdown
## `events`
The raw Nostr events table. 278 GB, unclustered.
| Column | Type | Description |
|--------|------|-------------|
| id | STRING | Event id (hex) |
| created_at | TIMESTAMP | Event time |
| kind | INT64 | NIP event kind |
| content | STRING | Body text |
| pubkey | STRING | Author pub key (hex) |
| tags | JSON | Raw tags array |

## `events_daily_stats`
Derived table. Aggregated daily metrics.
| Column | Type | Description |
|--------|------|-------------|
| date | DATE | Calendar date |
| event_count | INT64 | Total events |
| kind | INT64 | NIP event kind |
```

### 4. Nostr Keys (`scripts/generate-keys.js`)

Creates a random `nsec` / `npub` pair for the bot. Run once, save the nsec in the vault.

---

## Data Flow Sequence Diagram

```
User                    Relay              Bridge              n8n              Gemini           BigQuery
  │                       │                  │                  │                │                 │
  │── zap 10k sats ─────────────────────────▶│                  │                │                 │
  │                       │                  │                  │                │                 │
  │                       │◀─ kind 9735 ─────│                  │                │                 │
  │                       │                  │ stores zap credit│                │                 │
  │                       │                  │                  │                │                 │
  │── DM question ──────────────────────────▶│                  │                │                 │
  │                       │                  │                  │                │                 │
  │                       │◀─ kind 4 ────────│                  │                │                 │
  │                       │                  │ check credits    │                │                 │
  │                       │                  │                  │                │                 │
  │                       │                  │─── POST ────────▶│                │                 │
  │                       │                  │  (query, pubkey) │                │                 │
  │                       │                  │                  │                │                 │
  │                       │                  │                  │─── prompt ────▶│                 │
  │                       │                  │                  │                │                 │
  │                       │                  │                  │◀── SQL ────────│                 │
  │                       │                  │                  │                │                 │
  │                       │                  │                  │───────────────────── SQL ──────▶│
  │                       │                  │                  │                │                 │
  │                       │                  │                  │◀──────────────────── result ─────│
  │                       │                  │                  │                │                 │
  │                       │                  │                  │ format reply   │                 │
  │                       │                  │◀── POST /publish─│                │                 │
  │                       │                  │                  │                │                 │
  │                       │◀───── kind 4 ───│                  │                │                 │
  │◀──────────────────────│ (encrypted reply)                 │                │                 │
```

---

## Security Notes

- **Bot `nsec`** is stored in `nostr-bridge/.env` on the VPS. Keep this file `chmod 400`.
- **Gemini API key** should be in n8n credentials manager, not in workflow JSON.
- **BigQuery** should use a service account with read-only access to the specific dataset. Never use a project-wide owner account.
- **GCP budget alert** is recommended. Set a low `MAX_BYTES_BILLED` on the project to prevent runaway costs from SQL injection or hallucinated queries.
- **Rate limiting:** The bridge should rate-limit per-pubkey (e.g., max 1 query per minute). Not in MVP.

## Failure Modes

| Scenario | What Happens |
|----------|--------------|
| No zap credit | Bridge auto-replies "Send a 10,000 sat zap first" |
| Gemini returns non-SQL | n8n catches parse error, replies "I couldn't generate a valid query" |
| BigQuery error | n8n catches and returns error message to user |
| Bridge restarts | In-memory zap cache resets. Users may need to re-zap. Expected for MVP. |
| n8n down | Bridge queues nothing. DMs are lost. No retry. Expected for MVP. |
| Relay drops DM reply | No ACK mechanism. User may need to re-query. |
