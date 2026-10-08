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

PHOTOS (2)
• Photo 1 (sent by lead, Oct 3, 2:14 PM CDT): Water pooled on the garage floor under the tank, with rust on the base.
  https://storage.googleapis.com/…/leak1.jpeg
• Photo 2 (sent by lead, Oct 3, 2:14 PM CDT): Data plate on the tank; the model number is readable.
  https://storage.googleapis.com/…/plate2.jpeg

OUTCOME: Appointment confirmed for Monday at 9 AM.

Based on 5 text messages from the last 65 days (Oct 3, 2026 – Oct 4, 2026). Last message Oct 4, 2026, 9:30 AM CDT.
```

It fills the **Conversation Summary** contact field (Large Text), adds the same text as a contact note, and then adds the tag **`conversation-summary-ready`**, which a second GHL workflow can use to email the client.

## How it stays accurate

- **Only the last 65 days.** Older texts are ignored, so an old, finished conversation never leaks into a new lead's summary. GHL returns messages newest first, so the tool stops reading as soon as it passes the cutoff (and skips whole conversations that haven't had a message in the window), which keeps it fast on long histories. The footer says which window was used. If several separate matters fall inside the window, each gets its own timeline entries, the headline says so, and the outcome and next step follow the most recent one. Change the default with `SUMMARY_WINDOW_DAYS` in `wrangler.toml`, or per request with `"days"` (see API).
- **Claude never writes a date.** It points at message numbers, and the code stamps each timeline entry from that message's real timestamp in the contact's time zone. A pointer to a message that doesn't exist is repaired or dropped.
- Only what the texts say. Unstated details are left out. The lead's messages are passed as quoted data, never as instructions.
- Failed / undelivered texts are skipped.
- If any page of the history can't be read, the run fails (tag `conversation-summary-failed`) instead of summarising a partial thread.
- No new texts since the last summary → nothing is regenerated, so a retried webhook costs nothing and posts no duplicate note.
- A contact with no texts gets no field, note or tag (status `empty`).

## Pictures

When a lead texts pictures (MMS), they appear in a **PHOTOS** section: each photo's number, who sent it and when (stamped by the code, like the timeline), what it shows, and a link to the original. The timeline entry for that text mentions "(Photo n)".

- **`describe` (default):** Claude looks at the most recent 8 photos and writes one factual sentence about each (the fixture or equipment, visible condition, leaks, rust or damage, model numbers it can read). It does not guess causes, repair costs or what's behind a wall, and doesn't describe people. Older photos beyond the 8 are still listed with their links.
- **`links`:** every photo is listed with its link; nothing is downloaded and Claude doesn't see them.
- **`off`:** attachments are ignored (and a text that was only a picture is left out).
- Set it with `SUMMARY_PHOTOS` in `wrangler.toml`, or per request with `"photos": "links"`.
- A photo that can't be analyzed is still listed, with the reason: too large (over about 4.5 MB), iPhone HEIC format, link no longer works, or not an image. A failed download never fails the run.
- Videos, PDFs and other files are listed as **Attachments** with their link, never analyzed. The list shows up to 30 and says how many more there are.
- The summary field is plain text, so the photos are links rather than embedded pictures. In a GHL email they show up as clickable links.
- Photos are downloaded only for a fresh summary, never for a run that finds nothing new. A newly arrived photo counts as a change.

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

Two workflows. The first is a "button": adding a tag compiles the summary. The second sends it to the client.

**Pick two different tags.** The *trigger* tag is yours (this guide uses `send-summary`; any name works). The *output* tag, `conversation-summary-ready`, is added by this tool when the summary is done. They must not be the same tag, or the workflows would trigger each other. The tool refuses to use its own output tags as the trigger tag.

**Workflow 1: compile the summary when the trigger tag is added**

1. Automation → Workflows → Create workflow → Start from scratch. Name it e.g. "Compile conversation summary".
2. Add trigger → **Contact Tag** → filter: *Tag added* → *Has tag* → `send-summary`.
3. Add action → **Webhook** (under Custom/Integrations; in some accounts "Custom Webhook").
   - Method: `POST`
   - URL: `https://<worker-url>/summarize?token=<SUMMARY_TOKEN>`
   - Custom data (key → value):

     | Key | Value |
     |---|---|
     | `contact_id` | `{{contact.id}}` |
     | `remove_tag` | `send-summary` |
     | `force` | `true` |

   Leave the default headers and body. The standard GHL payload also carries `contact_id`, so the custom data is belt-and-braces.
4. Save and **Publish** the workflow (the toggle in the top right).

What those do:
- `remove_tag` takes `send-summary` off the contact when the run finishes (success, nothing to summarise, or error). GHL only fires "Tag Added" for a tag that is new on the contact, so without this, adding the tag a second time would do nothing. Don't add your own "Remove Tag" step instead: the tool removes it at the right moment, after the summary exists.
- `force` makes every tag add produce a fresh summary, note and `conversation-summary-ready` tag, even if no new texts arrived since last time. Adding the tag is an explicit request, so it always re-runs (and re-sends). Leave it out if you'd rather a repeat with no new texts do nothing. The webhook answers in a fraction of a second and the work runs in the background, so GHL doesn't retry and you won't get duplicates.

**Workflow 2: send it to the client**

1. New workflow, trigger **Contact Tag** → *Tag added* → `conversation-summary-ready`.
2. Add action **Send Email** (to the client) with the lead's details plus the merge field **`{{contact.conversation_summary}}`** (the Conversation Summary custom field). That field is always filled before the tag is added.
3. Publish.

Optional: a third workflow on `conversation-summary-failed` that alerts you (the run couldn't read the texts or Claude failed; `GET /status/<contactId>` has the reason).

**Test it:** open a test contact that has some texts, add the tag `send-summary`, and within about 30 seconds the Conversation Summary field, a note and `conversation-summary-ready` appear and `send-summary` disappears. Add it again to confirm it re-runs.

## API

All routes except `/healthz` need `SUMMARY_TOKEN` (`?token=`, `x-summary-token` header, or Bearer).

```
POST /summarize          {contact_id, days?, photos?, remove_tag?, wait?, dry_run?, force?}   202 + background by default; wait/dry_run hold the response
GET  /status/:contactId  the last run (status, message count, summary, what was written, errors)
POST /fields             create the two GHL custom fields if missing
GET  /check              read-only probe of the token's scopes
GET  /healthz
```

`days` is the look-back window: a whole number from 1 to 3650, or `0` / `"all"` for no limit (default `SUMMARY_WINDOW_DAYS`, 65). It can also be sent as `?days=` or in `customData`. A bad value returns 400. A contact with no texts inside the window gets status `empty` (no field, note or tag).

`photos` is `"describe"`, `"links"` or `"off"` (default `SUMMARY_PHOTOS`, `describe`); anything else returns 400. `remove_tag` is the GHL tag that triggered the run; it is removed from the contact when the run finishes (not on a dry run) so adding it again fires again. It can't be one of this tool's own output tags (400). Also accepted as `?remove_tag=` or in `customData`.

`/api/conversation-summary` is an alias of `/summarize` (and of `/status/:id`).

Settings (`wrangler.toml`): `SUMMARY_WINDOW_DAYS` (default `65`), `SUMMARY_PHOTOS` (default `describe`), `SUMMARY_CHANNELS` (default `sms`; any of `sms,email,call,chat`), `SUMMARY_TIMEZONE`, `GHL_TAG_SUMMARY`, `GHL_TAG_SUMMARY_FAILED`, `CLAUDE_MODEL`, `BUSINESS_NAME`.

## Development

```bash
npm install --legacy-peer-deps
npx tsc -p .      # type-check
npx vitest run    # 76 tests: GHL paging / filtering, look-back window, date stamping, validation, pipeline, routes
```

Notes: the per-contact lock uses KV, which is eventually consistent, so it stops a retried webhook running twice but isn't a strict mutex. Run records expire after 90 days.
