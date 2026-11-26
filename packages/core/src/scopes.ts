import { z } from "zod";

/**
 * Per-method authorization. Authenticating a request does not authorize every
 * method; each route names the one scope it needs and the server checks it at
 * execution time. No scope ever exposes a secret's plaintext to a client.
 */
export const SCOPES = [
  "mind:read",
  "mind:write",
  "chat",
  "vault:read", // secret names + metadata only
  "vault:write", // add / replace / delete / rotate
  "brain:write", // providers, roster, loops and connectors: how Galahad thinks and acts on his own
  "gateway:mint", // mint scoped model-gateway tokens for arms
  "fleet:admin", // invite, approve, revoke devices; decide approvals; dismiss notices (never an agent's)
  "sandbox", // create, use and destroy sandboxes on sandbox hosts
  "connect", // call connector tools (never their keys); outward and delete still ask
  "bank:read", // your bank accounts' balances and transactions (read-only); granted per agent, never by default
] as const;

export const Scope = z.enum(SCOPES);
export type Scope = z.infer<typeof Scope>;

export const OWNER_SCOPES: Scope[] = [...SCOPES];

/**
 * What a newly paired phone or browser gets unless the invite says otherwise.
 * It can do almost everything you can, except mint gateway tokens. Approving
 * new *machines* additionally requires a terminal on an existing node (see the server).
 */
export const CLIENT_DEFAULT_SCOPES: Scope[] = OWNER_SCOPES.filter((s) => s !== "gateway:mint");
