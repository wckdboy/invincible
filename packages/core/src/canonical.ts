export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON (RFC 8785-style): object keys sorted by UTF-16 code units,
 * no whitespace, `undefined` members dropped. Identical values always produce
 * identical bytes, which is what makes content-addressed event ids possible.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical: non-finite number");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical: unsupported type ${typeof value}`);
  }
}
