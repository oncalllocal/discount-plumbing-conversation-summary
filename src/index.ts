/**
 * Discount Plumbing: conversation summary Worker.
 *
 *   POST /summarize            {contact_id, days?, wait?, dry_run?, force?}  summarise a contact's texts into its
 *                              Conversation Summary field + note + tag. 202 and background by default.
 *                              (/api/conversation-summary is an alias.) GHL webhook payload shapes accepted.
 *   GET  /status/:contactId    the last run for a contact
 *   POST /fields               create the two GHL custom fields if missing
 *   GET  /check                read-only probe of the GHL token's scopes
 *   GET  /healthz
 *
 * Auth (all but /healthz): SUMMARY_TOKEN as ?token=, x-summary-token header or Bearer.
 */
import type { Env } from "./env";
import { ensureContactFields, ghl } from "./ghl/client";
import { jsonResponse, safeEqual } from "./lib/util";
import { getSummaryRecord, parseWindowDays, SUMMARY_FIELDS, summarizeContact } from "./summary";

type Loose = Record<string, unknown>;

export function requestToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  return req.headers.get("x-summary-token") || (auth?.startsWith("Bearer ") ? auth.slice(7) : undefined) || new URL(req.url).searchParams.get("token") || undefined;
}

export function isAuthorized(req: Request, env: Env, bodyToken?: string): boolean {
  const t = requestToken(req) || bodyToken;
  return !!t && !!env.SUMMARY_TOKEN && safeEqual(t, env.SUMMARY_TOKEN);
}

/** The contact id from a GHL workflow webhook ({contact_id}, {contact:{id}}, {customData:{contact_id}}, n8n {body:{…}}) or a plain API call. */
export function summaryContactId(raw: Loose): string | undefined {
  const o = (v: unknown): Loose => (v && typeof v === "object" ? (v as Loose) : {});
  const cd = o(raw.customData);
  const inner = o(raw.body);
  const cands = [raw.contact_id, raw.contactId, cd.contact_id, cd.contactId, o(raw.contact).id, inner.contact_id, o(inner.customData).contact_id, o(inner.contact).id];
  for (const c of cands) if (typeof c === "string" && /^[A-Za-z0-9]{8,40}$/.test(c.trim())) return c.trim();
  return undefined;
}

const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim()));

async function summarize(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let raw: Loose;
  try {
    raw = (await req.json()) as Loose;
  } catch {
    return jsonResponse({ error: "Body must be JSON" }, 400);
  }
  const contactId = summaryContactId(raw);
  if (!contactId) return jsonResponse({ error: "contact_id is required (the GHL contact's id)" }, 400);
  const url = new URL(req.url);
  const flag = (k: string) => truthy(raw[k]) || truthy(url.searchParams.get(k)) || truthy((raw.customData as Loose | undefined)?.[k]);
  const rawDays = raw.days ?? url.searchParams.get("days") ?? (raw.customData as Loose | undefined)?.days;
  const days = parseWindowDays(rawDays);
  if (rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== "" && days === null) return jsonResponse({ error: "days must be a whole number from 1 to 3650, or 0 / \"all\" for no limit" }, 400);
  const opts = { force: flag("force"), dryRun: flag("dry_run"), days: days ?? undefined };
  if (flag("wait") || opts.dryRun || !ctx) {
    const r = await summarizeContact(env, contactId, opts);
    return jsonResponse(r, r.status === "error" ? 502 : 200);
  }
  // GHL webhooks time out in a few seconds and the summary takes longer: answer now, finish in the background.
  ctx.waitUntil(summarizeContact(env, contactId, opts));
  return jsonResponse({ status: "queued", contactId, statusUrl: `${url.origin}/status/${contactId}` }, 202);
}

/** Read-only probe: which of the scopes this tool needs does the token have? */
async function check(env: Env): Promise<Response> {
  const loc = env.GHL_LOCATION_ID;
  const probes: [string, () => Promise<{ ok: boolean; status?: number; error?: string }>][] = [
    ["contacts.readonly", () => ghl(env, "GET", `/contacts/?locationId=${loc}&limit=1`)],
    ["locations/customFields.readonly", () => ghl(env, "GET", `/locations/${loc}/customFields?model=contact`)],
    ["conversations.readonly", () => ghl(env, "GET", `/conversations/search?locationId=${loc}&limit=1`, undefined, "2021-04-15")],
  ];
  const results: Record<string, string> = {};
  for (const [scope, run] of probes) {
    const r = await run();
    results[scope] = r.ok ? "ok" : `FAILED (${r.status ?? "network"})`;
  }
  results["conversations/message.readonly"] = "checked on the first real run (needs a conversation with messages)";
  results["contacts.write, locations/customFields.write"] = "checked on the first real run (POST /fields or a non-dry run)";
  const ok = Object.values(results).every((v) => !v.startsWith("FAILED"));
  return jsonResponse({ ok, business: env.BUSINESS_NAME, locationId: loc, scopes: results }, ok ? 200 : 502);
}

export async function handle(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/healthz") return jsonResponse({ ok: true });
  if (!isAuthorized(req, env)) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!env.GHL_TOKEN || !env.GHL_LOCATION_ID) return jsonResponse({ error: "GHL_TOKEN / GHL_LOCATION_ID not set" }, 503);

  if ((path === "/summarize" || path === "/api/conversation-summary") && req.method === "POST") return summarize(req, env, ctx);
  const st = path.match(/^\/(?:status|api\/conversation-summary)\/([A-Za-z0-9]{8,40})$/);
  if (st && req.method === "GET") {
    const r = await getSummaryRecord(env, st[1]);
    return r ? jsonResponse(r) : jsonResponse({ error: "No summary has been run for that contact" }, 404);
  }
  if (path === "/fields" && req.method === "POST") {
    const r = await ensureContactFields(env, SUMMARY_FIELDS);
    return jsonResponse({ ok: !r.error, keys: r.keys, error: r.error }, r.error ? 502 : 200);
  }
  if (path === "/check" && req.method === "GET") return check(env);
  return jsonResponse({ error: "Not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      console.error("Unhandled error", e);
      return jsonResponse({ error: "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
