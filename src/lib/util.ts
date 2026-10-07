/** Small, dependency-free helpers. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Collapse whitespace (including odd Unicode spaces) and trim. */
export function clean(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate on a word boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.4 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** SHA-256 hex of a string. */
export async function sha256(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Promise.race against a timeout. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}
