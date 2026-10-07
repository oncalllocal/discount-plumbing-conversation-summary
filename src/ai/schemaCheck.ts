/**
 * Structural check of a tool call's input against the tool's JSON Schema.
 *
 * Forced tool calls usually match the schema, but not always: occasionally a
 * required array (e.g. a service page's "signs") is left out, and the
 * renderer then crashes on `undefined.map`. This catches missing required
 * fields and wrong types so callTool can ask Claude to fix them.
 *
 * Deliberately checks structure only (required, type, anyOf, properties,
 * items) — not lengths or enums, which the per-call validators handle where
 * they matter.
 */
type Schema = {
  type?: string | string[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
};

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && isFinite(v);
    default:
      return true;
  }
}

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function schemaProblems(schema: Schema | undefined, value: unknown, path = "", max = 25): string[] {
  const out: string[] = [];
  walk(schema, value, path, out, max);
  return out;
}

function walk(s: Schema | undefined, v: unknown, path: string, out: string[], max: number): void {
  if (!s || out.length >= max) return;
  const at = path || "input";
  if (s.anyOf?.length) {
    const tries = s.anyOf.map((alt) => schemaProblems(alt, v, path, max));
    const ok = tries.find((t) => !t.length);
    if (!ok) out.push(...tries.reduce((a, b) => (b.length < a.length ? b : a)).slice(0, max - out.length));
    return;
  }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeOk(t, v))) {
      out.push(`${at} must be ${types.join(" or ")} (got ${describe(v)})`);
      return;
    }
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(s.items, item, `${path}[${i}]`, out, max));
    return;
  }
  if (typeof v === "object" && v !== null && s.properties) {
    const o = v as Record<string, unknown>;
    for (const k of s.required || []) {
      if (out.length >= max) return;
      if (!(k in o) || o[k] === undefined) out.push(`${path ? `${path}.` : ""}${k} is required`);
    }
    for (const [k, sub] of Object.entries(s.properties)) if (k in o && o[k] !== undefined) walk(sub, o[k], path ? `${path}.${k}` : k, out, max);
  }
}

/**
 * Last resort after a repair round: give every missing or mistyped required
 * field an empty value of the right type (null where allowed, else [] / "" /
 * false / 0 / {…}), so nothing downstream reads `undefined`. Mutates and
 * returns `value`.
 */
export function fillDefaults<T>(schema: Schema | undefined, value: T): T {
  return fill(schema, value) as T;
}

function empty(s: Schema | undefined): unknown {
  if (!s) return null;
  if (s.anyOf?.length) return s.anyOf.some((a) => a.type === "null") ? null : empty(s.anyOf[0]);
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.includes("null")) return null;
  switch (types[0]) {
    case "array":
      return [];
    case "string":
      return "";
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "object":
      return fill(s, {});
    default:
      return null;
  }
}

function fill(s: Schema | undefined, v: unknown): unknown {
  if (!s) return v;
  if (s.anyOf?.length) {
    const match = s.anyOf.find((alt) => !schemaProblems(alt, v).length);
    if (match) return v;
    const objAlt = s.anyOf.find((a) => a.type === "object");
    if (objAlt && typeof v === "object" && v !== null && !Array.isArray(v)) return fill(objAlt, v);
    return empty(s);
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length && !types.some((t) => typeOk(t, v))) return empty(s);
  if (Array.isArray(v)) return v.map((x) => fill(s.items, x));
  if (typeof v === "object" && v !== null && s.properties) {
    const o = v as Record<string, unknown>;
    for (const [k, sub] of Object.entries(s.properties)) {
      if (k in o && o[k] !== undefined) o[k] = fill(sub, o[k]);
      else if ((s.required || []).includes(k)) o[k] = empty(sub);
    }
  }
  return v;
}
