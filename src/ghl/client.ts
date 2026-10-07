/**
 * GoHighLevel (LeadConnector API v2): only the calls the conversation summary needs.
 * Every call returns { ok:false, error } instead of throwing, and retries 429/5xx.
 */
import type { Env } from "../env";
import { errorMessage, sleep, withTimeout } from "../lib/util";

const BASE = "https://services.leadconnectorhq.com";

export interface GhlResult {
  ok: boolean;
  status?: number;
  error?: string;
  data?: Record<string, unknown>;
}

export async function ghl(env: Env, method: string, path: string, body?: unknown, version = "2021-07-28"): Promise<GhlResult> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await withTimeout(
        fetch(`${BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: version, Accept: "application/json", "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
        15000,
        "GHL",
      );
      if (res.ok) {
        const text = await res.text();
        let data: Record<string, unknown> | undefined;
        try {
          data = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
        } catch {
          data = undefined;
        }
        return { ok: true, status: res.status, data };
      }
      last = `GHL ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status < 500 && res.status !== 429) return { ok: false, status: res.status, error: last };
    } catch (e) {
      last = errorMessage(e);
    }
    await sleep(800 * (attempt + 1));
  }
  return { ok: false, error: last };
}

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  timezone?: string;
  customFields?: { id: string; value?: unknown }[];
}

export async function getContact(env: Env, contactId: string): Promise<GhlContact | null> {
  const r = await ghl(env, "GET", `/contacts/${contactId}`);
  return r.ok ? ((r.data?.contact as GhlContact) || null) : null;
}

/** Set contact custom fields by key. Blank values are skipped. */
export function setCustomFields(env: Env, contactId: string, fields: { key: string; value: string | number }[]) {
  const list = fields.filter((f) => f.value != null && f.value !== "").map((f) => ({ key: f.key.replace(/^contact\./, ""), field_value: f.value }));
  if (!list.length) return Promise.resolve({ ok: true } as GhlResult);
  return ghl(env, "PUT", `/contacts/${contactId}`, { customFields: list });
}

export function addNote(env: Env, contactId: string, body: string) {
  return ghl(env, "POST", `/contacts/${contactId}/notes`, { body: body.slice(0, 60000) });
}

export function addTags(env: Env, contactId: string, tags: string[]) {
  return ghl(env, "POST", `/contacts/${contactId}/tags`, { tags: tags.filter(Boolean) });
}

export function removeTags(env: Env, contactId: string, tags: string[]) {
  return ghl(env, "DELETE", `/contacts/${contactId}/tags`, { tags: tags.filter(Boolean) });
}

/**
 * Add tags so GHL's "Contact Tag Added" trigger fires EVERY time (it only fires for a new tag):
 * each tag is removed first, then added back.
 */
export async function refireTags(env: Env, contactId: string, tags: string[]) {
  const list = tags.filter(Boolean);
  await removeTags(env, contactId, list);
  return addTags(env, contactId, list);
}

/**
 * Make sure these contact custom fields exist (creating missing ones) and return wanted key → actual key.
 * GHL derives a field's key from its name, so an existing field is matched by key or by name.
 * Needs the token's locations/customFields read + write scopes; on failure returns an error and the
 * caller falls back to the default keys.
 */
export async function ensureContactFields(env: Env, fields: { key: string; name: string; dataType?: string }[]): Promise<{ keys: Record<string, string>; ids: Record<string, string>; error?: string }> {
  const loc = env.GHL_LOCATION_ID;
  const bare = (k?: string) => (k || "").replace(/^contact\./, "");
  const list = await ghl(env, "GET", `/locations/${loc}/customFields?model=contact`);
  if (!list.ok) return { keys: {}, ids: {}, error: list.error };
  const existing = ((list.data?.customFields || []) as { id?: string; name?: string; fieldKey?: string }[]).map((x) => ({ id: x.id, name: (x.name || "").trim().toLowerCase(), key: bare(x.fieldKey) }));
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const found = existing.find((x) => x.key === f.key) || existing.find((x) => x.key.startsWith(`${f.key}_`)) || existing.find((x) => x.name === f.name.toLowerCase());
    if (found) {
      keys[f.key] = found.key;
      if (found.id) ids[f.key] = found.id;
      continue;
    }
    const r = await ghl(env, "POST", `/locations/${loc}/customFields`, { name: f.name, dataType: f.dataType || "TEXT", model: "contact" });
    const cf = r.data?.customField as { fieldKey?: string; id?: string } | undefined;
    const created = bare(cf?.fieldKey);
    if (r.ok && created) {
      keys[f.key] = created;
      if (cf?.id) ids[f.key] = cf.id;
    } else errors.push(`${f.name}: ${r.error || "no field key returned"}`);
  }
  return { keys, ids, error: errors.length ? errors.join("; ") : undefined };
}
