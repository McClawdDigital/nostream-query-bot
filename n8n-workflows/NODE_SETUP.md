# Manual Node Setup Guide (n8n UI)

If the JSON import doesn't work cleanly, build these nodes manually in n8n.

---

## Step 1: Webhook Trigger

| Setting | Value |
|---------|-------|
| **Node type** | Webhook |
| **HTTP Method** | POST |
| **Path** | `nostr-query` |
| **Response Mode** | Response (the bridge doesn't wait for a body, so this is fine) |

**Test payload** (use n8n Execute workflow or curl):

```bash
curl -X POST "https://<your-n8n>/webhook/nostr-query" \
  -H "Content-Type: application/json" \
  -d '{"query":"How many notes were created last week?","pubkey":"1234abcd...","eventId":"abc123","zapAmountMsats":10000000}'
```

---

## Step 2: Extract Fields (Code Node)

Type: **Code** (v2)

```js
const body = $input.first().json.body || $input.first().json;
return [{
  json: {
    query: body.query,
    pubkey: body.pubkey,
    eventId: body.eventId
  }
}];
```

---

## Step 3: Build Gemini Prompt (Code Node)

Type: **Code** (v2)

```js
// Inline the schema context here, or read from a file via an earlier HTTP/FTP node
const SCHEMA = `You are a SQL assistant for Google BigQuery.\n\nTables:\n... your schema ...`;

return [{
  json: {
    prompt: `${SCHEMA}\n\nUser asked: "${$input.first().json.query}"\n\nReturn ONLY the SQL inside triple backticks. No explanation.`
  }
}];
```

---

## Step 4: Gemini — Generate SQL (HTTP Request Node)

Type: **HTTP Request**

| Setting | Value |
|---------|-------|
| **Method** | POST |
| **URL** | `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` |
| **Query Parameters** | `key` = `={{ $credentials.geminiApiKey.apiKey }}` |
| **Body** (JSON) | `{"contents":[{"parts":[{"text":"{{ $input.first().json.prompt }}"}]}]}` |
| **Credentials** | Gemini API key (create in n8n: Credentials → Add → Gemini or Generic API) |

**Free tier**: 1500 requests/day at time of writing. Requires credit card for rate limits.

---

## Step 5: Parse SQL (Code Node)

```js
const resp = $input.first().json;
let sql = '';

try {
  // Gemini returns JSON response with text in a path like:
  // candidates[0].content.parts[0].text
  const text = resp.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/);
  sql = match ? match[1].trim() : text.trim();
} catch (e) {
  sql = '';
}

if (!sql) {
  throw new Error('No SQL found in Gemini response');
}

// Basic safety: remove backticks if any remain
sql = sql.replace(/`/g, '');

return [{ json: { sql } }];
```

---

## Step 6: Run BigQuery Job (HTTP Request Node)

**Option A — HTTP Request (manual, no native BQ node):**

| Setting | Value |
|---------|-------|
| **Method** | POST |
| **URL** | `https://bigquery.googleapis.com/bigquery/v2/projects/{{ $env.BQ_PROJECT_ID }}/queries` |
| **Authentication** | Google OAuth2 (from n8n credentials) |
| **Body** (JSON) | `{"query":"{{ $input.first().json.sql }}","useLegacySql":false,"maxResults":50}` |

**Option B — Native BigQuery node (if available in your n8n):**

Add a native `BigQuery` node:
- SQL query: `={{ $input.first().json.sql }}`
- Connection: your GCP OAuth2 credential

---

## Step 7: Format Reply (Code Node)

```js
const bq = $input.first().json;
const userPubkey = $items('Extract Fields')[0].json.pubkey;

let text = '';
try {
  if (bq.rows && bq.rows.length > 0) {
    const headers = bq.schema.fields.map(f => f.name);
    const lines = bq.rows.map(row => {
      const vals = row.f.map(v => v.v);
      return headers.map((h, i) => `${h}: ${vals[i]}`).join(', ');
    });
    text = lines.slice(0, 20).join('\n'); // cap to 20 rows
    if (lines.length > 20) text += '\n... more rows ...';
  } else {
    text = 'No data returned.';
  }
  if (text.length > 2000) text = text.slice(0, 1900) + '\n...(truncated)';
} catch (e) {
  text = 'Error: ' + e.message;
}

return [{
  json: {
    content: `Query result:\n${text}`,
    toPubkey: userPubkey
  }
}];
```

---

## Step 8: Publish to Bridge (HTTP Request Node)

| Setting | Value |
|---------|-------|
| **Method** | POST |
| **URL** | `{{ $env.BRIDGE_PUBLISH_URL || 'http://localhost:3000/publish' }}` |
| **Body** (JSON) | `{"content":"{{ $input.first().json.content }}","toPubkey":"{{ $input.first().json.toPubkey }}"}` |

---

## Node Wiring

```
Webhook → Extract Fields → Build Gemini Prompt → Gemini Generate SQL
                                              → Parse SQL from Gemini
                                              → Run BigQuery Job
                                              → Format Reply
                                              → Publish to Bridge
```

Each node connects via the **main** output to the next.

---

## Environment Variables (set in n8n → Settings → Variables)

| Variable | Description |
|----------|-------------|
| `BQ_PROJECT_ID` | GCP project ID (e.g. `replit-gcp`) |
| `BRIDGE_PUBLISH_URL` | Full URL to bridge `/publish` |

## Credentials (set in n8n UI)

| Name | Type | Details |
|------|------|---------|
| `geminiApiKey` | Generic Credential (header) | Key name = `key`, value = your Gemini API key |
| `bigQueryOAuth` | Google OAuth2 | Read-only scope on your Nostr dataset |

---

## Testing

1. Set all env vars and credentials
2. Start the bridge: `node nostr-bridge/bridge.js`
3. In n8n, click **Execute Workflow** on the Webhook node
4. Watch the bridge logs — it should receive the test and send a DM reply
5. Once working, activate the Webhook trigger and watch for real DMs
