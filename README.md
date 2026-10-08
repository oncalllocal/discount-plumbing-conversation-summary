# Discount Plumbing: conversation summary

Reads a lead's text messages from Discount Plumbing's GoHighLevel (GHL), has Claude summarise them, and writes the summary, with date stamps, back to the contact so a GHL workflow can send it to the client along with the lead's details.

```
CONVERSATION SUMMARY: Jane Doe
Jane needs an emergency water heater repair in Tacoma.

LEAD SNAPSHOT
• Looking for: Water heater leak repair
• Location: 14 Oak St, Tacoma
• Timing: ASAP

TIMELINE
• Oct 3, 2:14 PM CDT: Lead reported a leaking water heater at 14 Oak St and asked for it to be fixed ASAP.
• Oct 4, 9:02 AM CDT: Business offered Monday at 9 AM; lead confirmed.

OUTCOME: Appointment confirmed for Monday at 9 AM.

Based on 5 text messages from the last 35 days (Oct 3, 2026 – Oct 4, 2026). Last message Oct 4, 2026, 9:30 AM CDT.
```

It fills the **Conversation Summary** contact field (Large Text), adds the same text as a contact note, and then adds the tag **`conversation-summary-ready`**, which a second GHL workflow can use to email the client.

## How it stays accurate

- **Only the last 35 days.** Older texts are ignored, so an old, finished conversation never leaks into a new lead's summary. GHL returns messages newest first, so the tool stops reading as soon as it passes the cutoff (and skips whole conversations that haven't had a message in the window), which keeps it fast on long histories. The footer says which window was used. If several separate matters fall inside the window, each gets its own timeline entries, the headline says so, and the outcome and next step follow the most recent one. Change the default with `SUMMARY_WINDOW_DAYS` in `wrangler.toml`, or per request with `"days"` (see API).
- **Claude never writes a date.** It points at message numbers, and the code stamps each timeline entry from that message's real timestamp in the contact's time zone. A pointer to a message that doesn't exist is repaired or dropped.
- Only what the texts say. Unstated details are left out. The lead's messages are passed as quoted data, never as instructions.
- Failed / undelivered texts are skipped.
- If any page of the history can't be read, the run fails (tag `conversation-summary-failed`) instead of summarising a partial thread.
- No new texts since the last summary → nothing is regenerated, so a retried webhook costs nothing and posts no duplicate note.
- A contact with no texts gets no field, note or tag (status `empty`).

## Setup

### 1. GHL token (Discount Plumbing's sub-account)

Settings → Private Integrations → create a token with these scopes:

| Scope | Used for |
|---|---|
| `contacts.readonly`, `contacts.write` | read the contact, write the field / note / tags |
| `conversations.readonly`, `conversations/message.readonly` | read the text history |
| `locations/customFields.readonly`, `locations/customFields.write` | find / create the two custom fields |

Also note the sub-account's **Location ID** (Settings → Business Profile).

### 2. Deploy

```bash
npm install --legacy-peer-deps
npx wrangler kv namespace create STATE        # paste the id into wrangler.toml
npx wrangler secret put GHL_TOKEN             # Discount Plumbing's token
npx wrangler secret put GHL_LOCATION_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUMMARY_TOKEN         # any long random string; the GHL webhook sends it
npx wrangler deploy
```

Set `SUMMARY_TIMEZONE` in `wrangler.toml` to Discount Plumbing's time zone (default `America/Chicago`). A contact's own GHL time zone wins when it has one.

### 3. Check it

```bash
curl -H "x-summary-token: $SUMMARY_TOKEN" https://<worker-url>/check      # read-only scope probe
curl -X POST -H "x-summary-token: $SUMMARY_TOKEN" https://<worker-url>/fields   # create the 2 custom fields
curl -X POST -H "x-summary-token: $SUMMARY_TOKEN" https://<worker-url>/summarize \
     -d '{"contact_id":"<id of a contact with texts>","dry_run":true}'      # shows the summary, writes nothing
```

### 4. GHL workflows

1. **Trigger the summary.** Trigger = whatever means "send this lead to the client" (a tag, a pipeline stage, a button). Action = Webhook, `POST https://<worker-url>/summarize?token=<SUMMARY_TOKEN>` with custom data `contact_id` = `{{contact.id}}` (the standard `contact_id` GHL sends also works).
2. **Send it to the client.** Trigger = Contact Tag Added `conversation-summary-ready`. Action = email the client with `{{contact.conversation_summary}}` plus the lead's details. The tag is added last, so the field is always filled by then, and it re-fires on every run.
3. Optional: trigger on `conversation-summary-failed` to alert yourself.

## API

All routes except `/healthz` need `SUMMARY_TOKEN` (`?token=`, `x-summary-token` header, or Bearer).

```
POST /summarize          {contact_id, days?, wait?, dry_run?, force?}   202 + background by default; wait/dry_run hold the response
GET  /status/:contactId  the last run (status, message count, summary, what was written, errors)
POST /fields             create the two GHL custom fields if missing
GET  /check              read-only probe of the token's scopes
GET  /healthz
```

`days` is the look-back window: a whole number from 1 to 3650, or `0` / `"all"` for no limit (default `SUMMARY_WINDOW_DAYS`, 35). It can also be sent as `?days=` or in `customData`. A bad value returns 400. A contact with no texts inside the window gets status `empty` (no field, note or tag).

`/api/conversation-summary` is an alias of `/summarize` (and of `/status/:id`).

Settings (`wrangler.toml`): `SUMMARY_WINDOW_DAYS` (default `35`), `SUMMARY_CHANNELS` (default `sms`; any of `sms,email,call,chat`), `SUMMARY_TIMEZONE`, `GHL_TAG_SUMMARY`, `GHL_TAG_SUMMARY_FAILED`, `CLAUDE_MODEL`, `BUSINESS_NAME`.

## Development

```bash
npm install --legacy-peer-deps
npx tsc -p .      # type-check
npx vitest run    # 47 tests: GHL paging / filtering, look-back window, date stamping, validation, pipeline, routes
```

Notes: the per-contact lock uses KV, which is eventually consistent, so it stops a retried webhook running twice but isn't a strict mutex. Run records expire after 90 days.
