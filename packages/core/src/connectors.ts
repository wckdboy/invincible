import { z } from "zod";
import { canonical, type Json } from "./canonical.ts";
import { findSecrets } from "./secret-scan.ts";

/*
 * Connectors: how Galahad reaches the services you use (GitHub, Cloudflare,
 * Home Assistant…). A connector is a manifest, data rather than code: one pinned
 * origin, the vault secret it authenticates with, and a set of tools. Each tool is
 * one HTTP request template plus its oath class, which decides whether Galahad
 * may simply do it (read, create, modify) or must ask you first (outward, delete).
 *
 * The node that runs a call injects the key on the way out, and only to the origin
 * the key was pinned to when you entered it. No connector code ever runs, and no
 * model, arm or loop ever sees a key.
 *
 * A connector can also be a remote MCP server (streamable HTTP). Its tools are
 * discovered from the server once, when you install or refresh it, and stored here
 * with the class *you* give each one (the server's hints only propose one) and a
 * digest of the server's definition, so a tool that changes later is noticed.
 */

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "lowercase letters, digits and - (max 40)");
export const ToolName = z.string().regex(/^[a-z][a-z0-9_.-]{0,47}$/, "lowercase letters, digits, . _ - (max 48)");
const ParamName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
const SecretName = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/** Headers a manifest may never set: credentials are the broker's job, routing is the fetch's. */
const RESERVED_HEADERS = /^(authorization|proxy-.*|cookie|set-cookie|host|x-api-key|content-length|connection|transfer-encoding)$/i;

export const ConnectorParam = z.strictObject({
  type: z.enum(["string", "integer", "number", "boolean"]),
  description: z.string().max(300).optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string().max(100)).min(1).max(64).optional(),
  /** A regular expression the whole value must match. */
  pattern: z.string().max(200).optional(),
  /** Where the value goes. Default: the path if the path names it, else the query (GET) or the JSON body. */
  in: z.enum(["path", "query", "body"]).optional(),
});
export type ConnectorParam = z.infer<typeof ConnectorParam>;

export const ToolClass = z.enum(["read", "create", "modify", "outward", "delete"]);

/**
 * Tools Galahad implements himself, each bound to the one origin it may talk to, with the
 * connector's own key (the node's natives). A manifest can name one; it can't define one.
 */
export const NATIVE_TOOLS = {
  /** Commit a quest's kept changes on a new branch and open a pull request (GitHub's Git Data API). */
  "github.ship": "https://api.github.com",
  /** A fix to a pull request already shipped: one commit on top of its branch, moved forward from exactly where the fix began. */
  "github.ship.update": "https://api.github.com",
  /** Mail (the node's mail.ts): a search reads each message's headers; a message is read as its words; a reply is
   *  drafted in its thread; nothing comes back as raw MIME. */
  "gmail.search": "https://gmail.googleapis.com",
  "gmail.read": "https://gmail.googleapis.com",
  "gmail.draft": "https://gmail.googleapis.com",
  "gmail.send": "https://gmail.googleapis.com",
  "gmail.archive": "https://gmail.googleapis.com",
  "gmail.trash": "https://gmail.googleapis.com",
  "outlook.search": "https://graph.microsoft.com",
  "outlook.read": "https://graph.microsoft.com",
  "outlook.draft": "https://graph.microsoft.com",
  "outlook.send": "https://graph.microsoft.com",
  "outlook.archive": "https://graph.microsoft.com",
  "outlook.trash": "https://graph.microsoft.com",
  /** Whether a Cloudflare API token works, whoever owns it: a user's address first, then each account it can see. */
  "cloudflare.verify": "https://api.cloudflare.com",
} as const;
export type NativeName = keyof typeof NATIVE_TOOLS;
const NativeName = z.enum(Object.keys(NATIVE_TOOLS) as [NativeName, ...NativeName[]]);

export const ConnectorTool = z.strictObject({
  description: z.string().min(1).max(500),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Relative to the origin (and basePath), with {param} placeholders. */
  path: z
    .string()
    .max(300)
    .regex(/^\/[A-Za-z0-9._~\-/{}:@!$&'()*+,;=%]*$/, "an absolute path such as /repos/{owner}/{repo}"),
  params: z.record(ParamName, ConnectorParam).optional(),
  /** The oath class: read, create and modify run freely (logged); outward and delete ask you first. */
  class: ToolClass,
  /** Carried out by Galahad himself (several requests, one approval); method and path say where it acts. */
  native: NativeName.optional(),
});
export type ConnectorTool = z.infer<typeof ConnectorTool>;

/** One top-level argument of an MCP tool, summarized from its JSON schema (the server checks the full schema). */
export const McpParam = z.strictObject({
  type: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string().max(100)).min(1).max(64).optional(),
});

export const McpTool = z.strictObject({
  /** The tool's name on the server (local names are lowercase). */
  remote: z.string().min(1).max(128),
  description: z.string().max(1000),
  params: z.record(z.string().min(1).max(64), McpParam).optional(),
  /** Yours to choose. Proposed from the server's hints: read-only → read, destructive → delete, anything else → outward. */
  class: ToolClass,
  /** Digest of the server's definition (name, description, input schema) when it was installed. */
  schema: z.string().min(1).max(64),
  /** What the server claimed. Hints, never trusted on their own. */
  hints: z.strictObject({ readOnly: z.boolean().optional(), destructive: z.boolean().optional() }).optional(),
});
export type McpTool = z.infer<typeof McpTool>;
export const isMcpTool = (tool: ConnectorTool | McpTool): tool is McpTool => "remote" in tool;

const Origin = z
  .string()
  .max(256)
  .regex(/^https?:\/\/[^/?#\s]+$/, "an origin such as https://api.github.com (no path)")
  .refine((origin) => {
    try {
      const url = new URL(origin);
      // Plain http only for this machine and private networks (Home Assistant on the LAN, a tailnet service).
      return url.protocol === "https:" || isPrivateHost(url.hostname);
    } catch {
      return false;
    }
  }, "use https (plain http only for localhost and private networks)");

export const ConnectorAuth = z.strictObject({
  /** The vault secret holding the key. Its pinned origin must be this connector's origin. */
  secret: SecretName,
  /**
   * bearer: Authorization: Bearer <key> · header: <header>: <key> · basic: the key is "user:password" · oauth: you sign
   * in as yourself with an app you registered (brain oauth.ts); the secret keeps the app and the sign-in, and each call
   * carries a short-lived access token the node gets for it.
   */
  scheme: z.enum(["bearer", "header", "basic", "oauth"]),
  header: HeaderName.optional(),
  /** Call without a key when none is set (public APIs with a lower rate limit). */
  optional: z.boolean().optional(),
  /**
   * scheme oauth: whose sign-in, and what it asks you to allow. mcp: an MCP server's own (its authorization server found
   * from the server, Galahad registered there as a client of its own: brain mcp-oauth.ts), asking what it names when
   * no scopes are given here.
   */
  oauth: z
    .strictObject({
      provider: z.enum(["google", "microsoft", "mcp"]),
      scopes: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9.:/_-]+$/)).max(16),
    })
    .refine((o) => o.provider === "mcp" || o.scopes.length > 0, "a Google or Microsoft sign-in names what it asks you to allow")
    .optional(),
});

/** An agent as a connector's access names it: its label (Galahad's own is galahad; a knight's, team.…). */
export const AgentLabel = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * Who may call a connector beyond you, your loops and your quests. Absent, every agent: Galahad, the knights, agents
 * over MCP. "galahad": Galahad himself and the agents you allowed, by label; any other asks first (connector_request).
 */
export const ConnectorAccess = z.strictObject({
  only: z.literal("galahad"),
  allowed: z.array(AgentLabel).max(64),
});
export type ConnectorAccess = z.infer<typeof ConnectorAccess>;

/**
 * Whether a caller may use a connector: `by` as a connector call names its caller (arm:<label>, node:<name> for your
 * loops, quest for your quests). You are never asked this: a call of yours is yours.
 */
export function mayCall(access: ConnectorAccess | undefined, by: string): boolean {
  if (!access || !by.startsWith("arm:")) return true;
  const label = by.slice(4);
  return label === "galahad" || access.allowed.includes(label);
}

export const ConnectorManifest = z
  .strictObject({
    id: Id,
    label: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    origin: Origin,
    basePath: z
      .string()
      .max(100)
      .regex(/^(\/[A-Za-z0-9._~-]+)+$/)
      .optional(),
    auth: ConnectorAuth.optional(),
    headers: z.record(HeaderName, z.string().max(300)).optional(),
    /** A remote MCP server (streamable HTTP) at origin + path, instead of request templates. */
    mcp: z
      .strictObject({
        path: z
          .string()
          .max(200)
          .regex(/^\/[A-Za-z0-9._~\-/]*$/, "a path such as /mcp (no query: keys never go in a URL)"),
        /** Install only these of the server's tools (their server names). */
        only: z.array(z.string().min(1).max(128)).max(128).optional(),
      })
      .optional(),
    tools: z.record(ToolName, z.union([ConnectorTool, McpTool])),
    access: ConnectorAccess.optional(),
    /**
     * What it reads is yours alone (mail): once its data is in an answer, nothing that could carry it out of Galahad, or
     * write it into the shared mind, runs for the rest of that answer, its own tools aside (as for the bank).
     */
    private: z.boolean().optional(),
  })
  .superRefine((manifest, issue) => {
    const tools = Object.entries(manifest.tools);
    if (manifest.mcp) {
      // Discovered from the server: none yet is fine (it needs its key first).
      if (tools.length > 64) issue.addIssue({ code: "custom", message: "at most 64 tools: install a few with only", path: ["tools"] });
      if (manifest.basePath) issue.addIssue({ code: "custom", message: "an MCP connector has a path, not a basePath", path: ["basePath"] });
      if (findSecrets(manifest.mcp.path).length) issue.addIssue({ code: "custom", message: "keys go in the vault, never in a URL", path: ["mcp", "path"] });
      for (const [name, tool] of tools) {
        if (!isMcpTool(tool)) issue.addIssue({ code: "custom", message: "an MCP connector's tools come from the server", path: ["tools", name] });
      }
      return;
    }
    if (tools.length === 0 || tools.length > 64) issue.addIssue({ code: "custom", message: "a connector has 1 to 64 tools", path: ["tools"] });
    if ((manifest.auth?.scheme === "oauth") !== Boolean(manifest.auth?.oauth)) {
      issue.addIssue({ code: "custom", message: "auth scheme oauth goes with oauth (its provider and scopes), and only it does", path: ["auth", "oauth"] });
    }
    if (manifest.auth?.scheme === "header" && !manifest.auth.header) {
      issue.addIssue({ code: "custom", message: "auth scheme header needs a header name", path: ["auth", "header"] });
    }
    if (manifest.auth?.header && RESERVED_HEADERS.test(manifest.auth.header) && manifest.auth.header.toLowerCase() !== "x-api-key") {
      issue.addIssue({ code: "custom", message: `the key can't go in ${manifest.auth.header}`, path: ["auth", "header"] });
    }
    for (const [name, value] of Object.entries(manifest.headers ?? {})) {
      if (RESERVED_HEADERS.test(name)) issue.addIssue({ code: "custom", message: `a manifest can't set ${name}`, path: ["headers", name] });
      if (findSecrets(value).length) issue.addIssue({ code: "custom", message: "keys go in the vault, never in a manifest", path: ["headers", name] });
    }
    for (const [name, tool] of tools) {
      const where = ["tools", name];
      if (isMcpTool(tool)) {
        issue.addIssue({ code: "custom", message: "MCP tools belong to an MCP connector (give mcp.path)", path: where });
        continue;
      }
      if (tool.native && new URL(manifest.origin).origin !== NATIVE_TOOLS[tool.native]) {
        issue.addIssue({ code: "custom", message: `${tool.native} only talks to ${NATIVE_TOOLS[tool.native]}`, path: [...where, "native"] });
      }
      if (!classFits(tool.method, tool.class)) {
        issue.addIssue({ code: "custom", message: `${tool.method} can't be class ${tool.class} (${CLASS_RULE})`, path: [...where, "class"] });
      }
      const params = tool.params ?? {};
      const placeholders = [...tool.path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
      if (/[{}]/.test(tool.path.replace(/\{[a-zA-Z][a-zA-Z0-9_]{0,39}\}/g, ""))) {
        issue.addIssue({ code: "custom", message: "bad {placeholder} in path", path: [...where, "path"] });
      }
      if (/\/\.\.?(\/|$)|\/\//.test(tool.path)) issue.addIssue({ code: "custom", message: "no . or .. segments or // in paths", path: [...where, "path"] });
      for (const placeholder of placeholders) {
        const param = params[placeholder];
        if (!param) issue.addIssue({ code: "custom", message: `{${placeholder}} is not a declared param`, path: [...where, "path"] });
        else if (param.in && param.in !== "path") issue.addIssue({ code: "custom", message: `{${placeholder}} must be in: path`, path: [...where, "params", placeholder] });
      }
      for (const [pname, param] of Object.entries(params)) {
        if (param.in === "path" && !placeholders.includes(pname)) {
          issue.addIssue({ code: "custom", message: `the path has no {${pname}}`, path: [...where, "params", pname] });
        }
        if (param.in === "body" && tool.method === "GET") issue.addIssue({ code: "custom", message: "GET has no body", path: [...where, "params", pname] });
        if (param.pattern !== undefined) {
          try {
            new RegExp(param.pattern, "u");
          } catch {
            issue.addIssue({ code: "custom", message: "bad pattern", path: [...where, "params", pname, "pattern"] });
          }
        }
      }
    }
  });
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;

const CLASS_RULE = "GET reads or is outward; DELETE deletes; POST, PUT and PATCH create, modify, are outward or delete";
function classFits(method: ConnectorTool["method"], cls: ConnectorTool["class"]): boolean {
  if (method === "GET") return cls === "read" || cls === "outward";
  if (method === "DELETE") return cls === "delete";
  return cls !== "read";
}

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".ts.net") || h === "::1") return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return /^f[cd][0-9a-f]{2}:/.test(h); // IPv6 unique local
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Plain values for request templates; MCP tools may also take lists and objects. */
export type ArgValue = string | number | boolean | ArgValue[] | { [key: string]: ArgValue };
const ArgJson: z.ZodType<ArgValue> = z.lazy(() =>
  z.union([z.string().max(8000), z.number(), z.boolean(), z.array(ArgJson).max(500), z.record(z.string().max(100), ArgJson)]),
);
export const MAX_ARGS_BYTES = 32 * 1024;
export const ConnectorArgs = z
  .record(z.string().max(64), ArgJson)
  .refine((args) => JSON.stringify(args).length <= MAX_ARGS_BYTES, `arguments are at most ${MAX_ARGS_BYTES / 1024} KB`);

/** Every string inside the arguments, however deep (for secret scanning). */
export function argStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) argStrings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      argStrings(item, out);
    }
  }
  return out;
}

export class ConnectorError extends Error {}

export interface BuiltRequest {
  kind: "http";
  method: ConnectorTool["method"];
  url: string;
  /** Static, non-secret headers from the manifest (the broker adds the key). */
  headers: Record<string, string>;
  body?: string;
  class: ConnectorTool["class"];
  /** What the ledger and approvals show, e.g. "POST /repos/amiriteorg/galahad/issues". */
  target: string;
}

const placementOf = (tool: ConnectorTool, name: string, param: ConnectorParam): "path" | "query" | "body" =>
  param.in ?? (tool.path.includes(`{${name}}`) ? "path" : tool.method === "GET" || tool.method === "DELETE" ? "query" : "body");

function checkValue(name: string, param: ConnectorParam, value: ArgValue): ArgValue {
  switch (param.type) {
    case "string":
      if (typeof value !== "string") throw new ConnectorError(`${name} must be text`);
      if (param.enum && !param.enum.includes(value)) throw new ConnectorError(`${name} must be one of ${param.enum.join(", ")}`);
      if (param.pattern !== undefined && !new RegExp(`^(?:${param.pattern})$`, "u").test(value)) {
        throw new ConnectorError(`${name} doesn't match ${param.pattern}`);
      }
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) throw new ConnectorError(`${name} must be a whole number`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ConnectorError(`${name} must be a number`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ConnectorError(`${name} must be true or false`);
      return value;
  }
}

/** Turn a tool call into exactly one request to the connector's origin, or refuse. */
export function buildRequest(manifest: ConnectorManifest, toolName: string, args: Record<string, ArgValue> = {}): BuiltRequest {
  const built = buildHttpOrNative(manifest, toolName, args);
  if (built.kind === "native") throw new ConnectorError(`${manifest.id}.${toolName} is carried out by Galahad, not as one request`);
  return built;
}

/** A request template's call, or a native tool's checked call (same parameter rules). */
function buildHttpOrNative(manifest: ConnectorManifest, toolName: string, args: Record<string, ArgValue>): BuiltRequest | BuiltNative {
  const tool = Object.hasOwn(manifest.tools, toolName) ? manifest.tools[toolName] : undefined;
  if (!tool) throw new ConnectorError(`${manifest.id} has no tool "${toolName}" (it has: ${Object.keys(manifest.tools).join(", ") || "none yet"})`);
  if (isMcpTool(tool)) throw new ConnectorError(`${manifest.id} is an MCP server: its calls go through buildMcpCall`);
  const params = tool.params ?? {};
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(params, name)) throw new ConnectorError(`${manifest.id}.${toolName} takes no "${name}"`);
  }
  let path = tool.path;
  const query = new URLSearchParams();
  const body: Record<string, ArgValue> = {};
  const checked: Record<string, ArgValue> = {};
  for (const [name, param] of Object.entries(params)) {
    const raw = args[name];
    if (raw === undefined) {
      if (param.required || placementOf(tool, name, param) === "path") throw new ConnectorError(`${manifest.id}.${toolName} needs ${name}`);
      continue;
    }
    const value = checkValue(name, param, raw);
    checked[name] = value;
    const where = placementOf(tool, name, param);
    if (where === "path") {
      const text = String(value);
      if (!text || text === "." || text === "..") throw new ConnectorError(`${name} can't be "${text}"`);
      path = path.replace(`{${name}}`, encodeURIComponent(text));
    } else if (where === "query") query.set(name, String(value));
    else body[name] = value;
  }
  const search = query.size ? `?${query}` : "";
  const fullPath = `${manifest.basePath ?? ""}${path}`;
  const url = new URL(`${manifest.origin}${fullPath}${search}`);
  // Belt and braces: whatever the arguments were, the request goes to the pinned origin.
  if (url.origin !== new URL(manifest.origin).origin) throw new ConnectorError("refusing a request off the connector's origin");
  if (tool.native) return { kind: "native", native: tool.native, args: checked, class: tool.class, target: `${tool.method} ${url.pathname} (${toolName})`.slice(0, 256) };
  const hasBody = tool.method !== "GET" && tool.method !== "DELETE" && Object.keys(body).length > 0;
  return {
    kind: "http",
    method: tool.method,
    url: url.toString(),
    headers: { ...(manifest.headers ?? {}) },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    class: tool.class,
    target: `${tool.method} ${url.pathname}${search}`.slice(0, 256),
  };
}

/** A native tool's call: its checked arguments, carried out by the node (see NATIVE_TOOLS). */
export interface BuiltNative {
  kind: "native";
  native: NativeName;
  args: Record<string, ArgValue>;
  class: ConnectorTool["class"];
  target: string;
}

export interface BuiltMcpCall {
  kind: "mcp";
  /** The server's name for the tool. */
  remote: string;
  args: Record<string, ArgValue>;
  class: ConnectorTool["class"];
  /** What the ledger and approvals show, e.g. "mcp create_issue {"owner":"amiriteorg",…}". */
  target: string;
}

export type ConnectorRequest = BuiltRequest | BuiltMcpCall | BuiltNative;

const jsonType = (value: ArgValue): string =>
  Array.isArray(value) ? "array" : value === null ? "null" : typeof value === "object" ? "object" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;

/** Turn an MCP tool call into exactly one tools/call, or refuse (the server checks the full schema). */
export function buildMcpCall(manifest: ConnectorManifest, toolName: string, args: Record<string, ArgValue> = {}): BuiltMcpCall {
  const tool = Object.hasOwn(manifest.tools, toolName) ? manifest.tools[toolName] : undefined;
  if (!tool) throw new ConnectorError(`${manifest.id} has no tool "${toolName}" (it has: ${Object.keys(manifest.tools).join(", ") || "none yet"})`);
  if (!isMcpTool(tool) || !manifest.mcp) throw new ConnectorError(`${manifest.id}.${toolName} is not an MCP tool`);
  const params = tool.params ?? {};
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(params, name)) throw new ConnectorError(`${manifest.id}.${toolName} takes no "${name}"`);
  }
  for (const [name, param] of Object.entries(params)) {
    const value = args[name];
    if (value === undefined) {
      if (param.required) throw new ConnectorError(`${manifest.id}.${toolName} needs ${name}`);
      continue;
    }
    const type = jsonType(value);
    const wanted = param.type.split("|");
    const fits = wanted.includes("any") || wanted.includes(type) || (type === "integer" && wanted.includes("number"));
    if (!fits) throw new ConnectorError(`${name} must be ${param.type.replace("|", " or ")}`);
    if (param.enum && typeof value === "string" && !param.enum.includes(value)) throw new ConnectorError(`${name} must be one of ${param.enum.join(", ")}`);
  }
  return { kind: "mcp", remote: tool.remote, args, class: tool.class, target: `mcp ${tool.remote} ${canonical(args as Json)}`.slice(0, 256) };
}

/** Build the one request a call makes, whichever kind of connector it is. */
export const buildCall = (manifest: ConnectorManifest, toolName: string, args: Record<string, ArgValue> = {}): ConnectorRequest =>
  manifest.mcp ? buildMcpCall(manifest, toolName, args) : buildHttpOrNative(manifest, toolName, args);

/** A local tool name for a server's tool name (lowercase, safe), unique among `taken`. */
export function localToolName(remote: string, taken: Set<string>): string {
  const base =
    remote
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .slice(0, 44) || "tool";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

/** The class an MCP tool starts with: read-only → read, destructive → delete, anything else → outward. You can change it. */
export function proposedClass(hints: { readOnly?: boolean; destructive?: boolean } | undefined): ConnectorTool["class"] {
  if (hints?.readOnly === true) return "read";
  if (hints?.destructive === true) return "delete";
  return "outward";
}

