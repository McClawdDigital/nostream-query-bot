# Table Schema Reference for the LLM

This file is read by the n8n workflow on every query and injected into the Gemini prompt.

Keep it under 2000 tokens. Describe only tables users can realistically query.

---

## Tables

### `replit-gcp.Nostr.events` (or `events`)

Raw Nostr events. ~278 GB. Partitioned by `created_at`. Clustered by `kind`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | STRING | Event ID, hex, 64 chars |
| `pubkey` | STRING | Author public key, hex, 64 chars |
| `created_at` | TIMESTAMP | Event creation time in UTC |
| `kind` | INTEGER | NIP-01 event kind (e.g., 1 = text note, 0 = metadata) |
| `tags` | ARRAY<STRUCT<STRING, STRING>> | Tags array, each tag is a pair of strings |
| `content` | STRING | Content/body of the event |
| `sig` | STRING | Schnorr signature (hex) |

Example row (simplified):
```
{
  id: "abc123…def",
  pubkey: "0123…abcd",
  created_at: "2024-05-01 12:00:00 UTC",
  kind: 1,
  tags: [["e", "<reply_to_id>"], ["p", "<mentioned_pubkey>"]],
  content: "Hello Nostr!",
  sig: "<signature_hex>"
}
```

**Sample query:**
```sql
SELECT COUNT(*) as total_events
FROM `replit-gcp.Nostr.events`
WHERE TIMESTAMP_TRUNC(created_at, DAY) = TIMESTAMP("2024-05-01")
```

### `staging.flat_events` (if available from dbt pipeline)

Flattened and de-duplicated events from the raw table.

| Column | Type | Description |
|--------|------|-------------|
| `event_id` | STRING | Same as `id` above |
| `author_pubkey` | STRING | Same as `pubkey` |
| `event_kind` | INTEGER | Same as `kind` |
| `created_at` | TIMESTAMP | Same as above |
| `event_content` | STRING | Same as `content` |
| `reply_to_event_id` | STRING | Parsed from `e` tag, if exists |
| `mentions` | ARRAY<STRING> | Parsed `p` tag mentions |

---

## Query Writing Guidelines (for the LLM prompt)

- Use fully-qualified table names: `PROJECT.DATASET.TABLE`
- Prefer `COUNT(*)`, `COUNT(DISTINCT ...)`, `TIMESTAMP_TRUNC(...)` over raw string filters
- For date filtering use `TIMESTAMP("YYYY-MM-DD")` or `DATE("YYYY-MM-DD")`
- For text searches on `content` use `LOWER(content) LIKE '%keyword%'`
- `kind` values:
  - `0` = metadata
  - `1` = short text note
  - `3` = contacts / follow list
  - `4` = encrypted DMs
  - `5` = delete event
  - `6` = repost
  - `7` = reaction
  - `9735` = zap receipt
- The `events` table is large; always include a `WHERE` clause on `created_at` or another clustered column. Full table scans cost money.
