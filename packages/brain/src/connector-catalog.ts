import type { ConnectorManifest } from "@galahad/core";

/*
 * Connectors that ship with Galahad. Each is only a manifest: install one with
 * `galahad connector add <id>`, put its key in the vault, and every node can use it.
 * Tools that change the world outside are classed outward or delete, so Galahad
 * asks you before each one; reading and creating are his to do (and logged).
 */

export interface CatalogEntry {
  manifest: Omit<ConnectorManifest, "origin"> & { origin?: string };
  /** The origin is yours (a Home Assistant on your LAN): give it at install. */
  needsOrigin?: boolean;
  /** Where to get a key, shown when it's missing. */
  keyHelp?: string;
  /**
   * The shape of the service's own ids where they look like keys (Drive's files, Graph's messages): its answers keep
   * them and its tools take them. Keys by their known shapes, and the connector's own, are refused and redacted still.
   */
  ids?: RegExp;
}

const owner = { type: "string", pattern: "[A-Za-z0-9_.-]{1,100}", required: true } as const;
const repo = owner;
const perPage = { type: "integer", description: "results per page (max 100)" } as const;
const page = { type: "integer", description: "which page of results (from 1)" } as const;
const number = { type: "integer", required: true } as const;
const account = { type: "string", pattern: "[a-f0-9]{32}", required: true, description: "Cloudflare account id" } as const;
const bucketName = { type: "string", pattern: "[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", required: true } as const;
// Mail: the words to search with, how many, a message's id as search gives it, and what a message says.
const query = { type: "string", description: "the words to search with" } as const;
const limit = { type: "integer", description: "how many messages (at most 25)" } as const;
const gmailId = { type: "string", pattern: "[A-Za-z0-9_-]{6,64}", required: true, description: "the message's id, as search gives it" } as const;
const outlookId = { type: "string", pattern: "[A-Za-z0-9=_+/-]{6,512}", required: true, description: "the message's id, as search gives it" } as const;
const driveId = { type: "string", pattern: "[A-Za-z0-9_-]{10,100}", required: true, description: "the file's id, as files gives it" } as const;
const compose = {
  to: { type: "string", required: true, description: "addresses, comma-separated" },
  cc: { type: "string", description: "addresses, comma-separated" },
  subject: { type: "string", description: "its subject (a reply's is its message's, with Re:)" },
  body: { type: "string", required: true, description: "its words, plain text" },
  replyTo: { type: "string", pattern: "[A-Za-z0-9=_+/-]{6,512}", description: "the id of the message it answers" },
} as const;

/** A shipped connector's own ids, where it says what they look like (CatalogEntry.ids); one of yours by the same name, elsewhere, has none. */
export function publicIds(manifest: Pick<ConnectorManifest, "id" | "origin">): ((token: string) => boolean) | undefined {
  const entry = Object.hasOwn(CATALOG, manifest.id) ? CATALOG[manifest.id] : undefined;
  const shape = entry?.ids;
  if (!shape || entry.manifest.origin !== manifest.origin) return undefined;
  return (token) => shape.test(token);
}

export const CATALOG: Record<string, CatalogEntry> = {
  github: {
    keyHelp: "a fine-grained token from https://github.com/settings/personal-access-tokens (public reads work without one)",
    manifest: {
      id: "github",
      label: "GitHub",
      description: "Repositories, issues, pull requests (their files, reviews and checks), Actions runs and notifications.",
      origin: "https://api.github.com",
      auth: { secret: "github", scheme: "bearer", optional: true },
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      tools: {
        me: { description: "Who the token belongs to.", method: "GET", path: "/user", class: "read" },
        notifications: {
          description: "Your unread notifications.",
          method: "GET",
          path: "/notifications",
          params: { all: { type: "boolean" }, participating: { type: "boolean" }, per_page: perPage },
          class: "read",
        },
        repo: { description: "A repository.", method: "GET", path: "/repos/{owner}/{repo}", params: { owner, repo }, class: "read" },
        issues: {
          description: "Issues (and pull requests) in a repository.",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues",
          params: { owner, repo, state: { type: "string", enum: ["open", "closed", "all"] }, labels: { type: "string" }, per_page: perPage },
          class: "read",
        },
        issue: {
          description: "One issue or pull request.",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues/{number}",
          params: { owner, repo, number: { type: "integer", required: true } },
          class: "read",
        },
        pulls: {
          description: "Pull requests in a repository.",
          method: "GET",
          path: "/repos/{owner}/{repo}/pulls",
          params: { owner, repo, state: { type: "string", enum: ["open", "closed", "all"] }, per_page: perPage },
          class: "read",
        },
        pull: {
          description: "One pull request: its head and base (with their commits), whether it can be merged, and its state.",
          method: "GET",
          path: "/repos/{owner}/{repo}/pulls/{number}",
          params: { owner, repo, number },
          class: "read",
        },
        "pull.files": {
          description: "The files a pull request changes, each with its patch.",
          method: "GET",
          path: "/repos/{owner}/{repo}/pulls/{number}/files",
          params: { owner, repo, number, per_page: perPage, page },
          class: "read",
        },
        "pull.reviews": {
          description: "The reviews of a pull request: who approved or asked for changes, and what they said.",
          method: "GET",
          path: "/repos/{owner}/{repo}/pulls/{number}/reviews",
          params: { owner, repo, number, per_page: perPage },
          class: "read",
        },
        "pull.comments": {
          description: "Review comments on a pull request's lines: the file, the line and what was said.",
          method: "GET",
          path: "/repos/{owner}/{repo}/pulls/{number}/comments",
          params: { owner, repo, number, per_page: perPage },
          class: "read",
        },
        runs: {
          description: "Recent GitHub Actions runs.",
          method: "GET",
          path: "/repos/{owner}/{repo}/actions/runs",
          params: { owner, repo, branch: { type: "string" }, status: { type: "string" }, per_page: perPage },
          class: "read",
        },
        "run.jobs": {
          description: "The jobs of an Actions run, each with its steps and how they ended: which one failed.",
          method: "GET",
          path: "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
          params: { owner, repo, run_id: { type: "integer", required: true }, per_page: perPage },
          class: "read",
        },
        checks: {
          description: "The checks run on a commit, a branch or a tag (CI): each one's status and conclusion.",
          method: "GET",
          path: "/repos/{owner}/{repo}/commits/{ref}/check-runs",
          params: { owner, repo, ref: { type: "string", pattern: "[A-Za-z0-9._/-]{1,200}", required: true, description: "a commit's sha, a branch or a tag" }, per_page: perPage },
          class: "read",
        },
        "check.annotations": {
          description: "What a check reported against the code: each file, line and message (where a failing test or a build error usually is).",
          method: "GET",
          path: "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
          params: { owner, repo, check_run_id: { type: "integer", required: true }, per_page: perPage },
          class: "read",
        },
        "branch.create": {
          description: "Create a branch at a commit (ref is refs/heads/<name>).",
          method: "POST",
          path: "/repos/{owner}/{repo}/git/refs",
          params: {
            owner,
            repo,
            ref: { type: "string", pattern: "refs/heads/[A-Za-z0-9._/-]{1,200}", required: true },
            sha: { type: "string", pattern: "[a-f0-9]{40}", required: true },
          },
          class: "create",
        },
        "issue.create": {
          description: "Open an issue. Others see it: Galahad asks first.",
          method: "POST",
          path: "/repos/{owner}/{repo}/issues",
          params: { owner, repo, title: { type: "string", required: true }, body: { type: "string" } },
          class: "outward",
        },
        "pr.create": {
          description: "Open a pull request from head into base. Others see it: Galahad asks first, unless a standing order covers it.",
          method: "POST",
          path: "/repos/{owner}/{repo}/pulls",
          params: {
            owner,
            repo,
            head: { type: "string", required: true, description: "The branch with the changes, e.g. feat/orders" },
            base: { type: "string", required: true, description: "The branch to merge into, e.g. main" },
            title: { type: "string", required: true },
            body: { type: "string" },
            draft: { type: "boolean" },
          },
          class: "outward",
        },
        ship: {
          description:
            "Ship a quest's changes: commit them on a new galahad/… branch (never an existing one) and open a pull request. Others see it: Galahad asks first, unless a standing order covers it.",
          native: "github.ship",
          method: "POST",
          path: "/repos/{owner}/{repo}/pulls",
          params: {
            owner,
            repo,
            artifact: { type: "string", pattern: "art_[A-Za-z0-9_-]{22}", required: true, description: "The kept work holding the shipment (ship/manifest.json)" },
            branch: { type: "string", pattern: "galahad/[A-Za-z0-9._-]{1,80}(/[A-Za-z0-9._-]{1,80})?", required: true, description: "A new branch for the changes, e.g. galahad/units" },
            base: { type: "string", pattern: "[A-Za-z0-9._/-]{1,200}", description: "The branch to merge into (default: the repository's default branch)" },
            title: { type: "string", required: true },
            body: { type: "string" },
            draft: { type: "boolean" },
          },
          class: "outward",
        },
        "ship.update": {
          description:
            "Push a fix onto a pull request's galahad/… branch: one commit on top, only while the branch stands where the fixing work began, never forced. The pull request updates. Others see it: Galahad asks first, unless a standing order covers it.",
          native: "github.ship.update",
          method: "PATCH",
          path: "/repos/{owner}/{repo}/git/refs/heads/{branch}",
          params: {
            owner,
            repo,
            artifact: { type: "string", pattern: "art_[A-Za-z0-9_-]{22}", required: true, description: "The kept work holding the fix's shipment (ship/manifest.json)" },
            branch: { type: "string", pattern: "galahad/[A-Za-z0-9._-]{1,80}(/[A-Za-z0-9._-]{1,80})?", required: true, description: "The pull request's branch, which the fix began on" },
            title: { type: "string", required: true, description: "The commit's first line" },
            body: { type: "string" },
          },
          class: "outward",
        },
        "issue.comment": {
          description: "Comment on an issue or pull request. Others see it: Galahad asks first.",
          method: "POST",
          path: "/repos/{owner}/{repo}/issues/{number}/comments",
          params: { owner, repo, number: { type: "integer", required: true }, body: { type: "string", required: true } },
          class: "outward",
        },
        // Never APPROVE: an approval is your word on your account, and branch protection counts it.
        "pull.review": {
          description: "Review a pull request: a comment, or a request for changes. Others see it: Galahad asks first. (Approving stays yours.)",
          method: "POST",
          path: "/repos/{owner}/{repo}/pulls/{number}/reviews",
          params: { owner, repo, number, event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES"], required: true }, body: { type: "string", required: true } },
          class: "outward",
        },
      },
    },
  },
  cloudflare: {
    keyHelp: "an API token, a user's (https://dash.cloudflare.com/profile/api-tokens) or an account's (Manage Account → Account API Tokens); R2 edit for buckets",
    manifest: {
      id: "cloudflare",
      label: "Cloudflare",
      description: "Accounts, zones, DNS records, Workers and R2 buckets. Creating buckets is free; deleting one asks.",
      origin: "https://api.cloudflare.com",
      basePath: "/client/v4",
      auth: { secret: "cloudflare", scheme: "bearer" },
      tools: {
        "token.verify": {
          description: "Check the API token works, whoever owns it: a user's or an account's (says which, its status and when it expires).",
          native: "cloudflare.verify",
          method: "GET",
          path: "/user/tokens/verify",
          class: "read",
        },
        accounts: { description: "Accounts the token can see.", method: "GET", path: "/accounts", class: "read" },
        zones: {
          description: "Zones (domains).",
          method: "GET",
          path: "/zones",
          params: { name: { type: "string" }, per_page: perPage },
          class: "read",
        },
        "dns.records": {
          description: "DNS records in a zone.",
          method: "GET",
          path: "/zones/{zone}/dns_records",
          params: { zone: { type: "string", pattern: "[a-f0-9]{32}", required: true }, name: { type: "string" } },
          class: "read",
        },
        workers: { description: "Workers scripts.", method: "GET", path: "/accounts/{account}/workers/scripts", params: { account }, class: "read" },
        "r2.buckets": { description: "R2 buckets.", method: "GET", path: "/accounts/{account}/r2/buckets", params: { account }, class: "read" },
        "r2.bucket.create": {
          description: "Create an R2 bucket.",
          method: "POST",
          path: "/accounts/{account}/r2/buckets",
          params: { account, name: bucketName, locationHint: { type: "string", enum: ["apac", "eeur", "enam", "weur", "wnam", "oc"] } },
          class: "create",
        },
        "r2.bucket.delete": {
          description: "Delete an empty R2 bucket. Deleting asks you first.",
          method: "DELETE",
          path: "/accounts/{account}/r2/buckets/{name}",
          params: { account, name: { ...bucketName, in: "path" } },
          class: "delete",
        },
      },
    },
  },
  "home-assistant": {
    needsOrigin: true,
    keyHelp: "a long-lived access token from your Home Assistant profile page",
    manifest: {
      id: "home-assistant",
      label: "Home Assistant",
      description: "Read your home's state. Anything that moves, heats, unlocks or opens asks you first, every time.",
      auth: { secret: "home-assistant", scheme: "bearer" },
      tools: {
        status: { description: "Is Home Assistant up?", method: "GET", path: "/api/", class: "read" },
        states: { description: "Every entity's state.", method: "GET", path: "/api/states", class: "read" },
        state: {
          description: "One entity's state.",
          method: "GET",
          path: "/api/states/{entity_id}",
          params: { entity_id: { type: "string", pattern: "[a-z_]+\\.[a-z0-9_]+", required: true } },
          class: "read",
        },
        service: {
          description: "Call a service (turn on a light, lock a door). The physical world: always asks.",
          method: "POST",
          path: "/api/services/{domain}/{service}",
          params: {
            domain: { type: "string", pattern: "[a-z_]+", required: true },
            service: { type: "string", pattern: "[a-z_]+", required: true },
            entity_id: { type: "string", pattern: "[a-z_]+\\.[a-z0-9_]+", required: true },
          },
          class: "outward",
        },
      },
    },
  },
  gmail: {
    keyHelp: "it signs in with Google, through an app you register once in Google Cloud (docs/MAIL.md says how)",
    manifest: {
      id: "gmail",
      label: "Gmail",
      description: "Your mail at Google: search, read, draft, archive; sending and trashing ask you first. Galahad's alone, and what it reads stays in the answer that read it, as the bank's data does.",
      origin: "https://gmail.googleapis.com",
      auth: { secret: "gmail", scheme: "oauth", oauth: { provider: "google", scopes: ["https://www.googleapis.com/auth/gmail.modify", "openid", "email"] } },
      tools: {
        search: { description: "Find messages, with Gmail's own search words (from:anna is:unread newer_than:7d); without any, the inbox's latest.", native: "gmail.search", method: "GET", path: "/gmail/v1/users/me/messages", params: { query, limit }, class: "read" },
        read: { description: "One message: who, when, its subject, its words and what it has attached.", native: "gmail.read", method: "GET", path: "/gmail/v1/users/me/messages/{id}", params: { id: gmailId }, class: "read" },
        draft: { description: "A draft in your Drafts, unsent: a new message, or a reply (replyTo) in its thread.", native: "gmail.draft", method: "POST", path: "/gmail/v1/users/me/drafts", params: compose, class: "create" },
        send: { description: "Send a message, or a reply (replyTo) in its thread. Others read it: Galahad asks first.", native: "gmail.send", method: "POST", path: "/gmail/v1/users/me/messages/send", params: compose, class: "outward" },
        archive: { description: "Out of the inbox, into All Mail (back any time).", native: "gmail.archive", method: "POST", path: "/gmail/v1/users/me/messages/{id}/modify", params: { id: gmailId }, class: "modify" },
        trash: { description: "Into Trash, where Gmail keeps it 30 days. Galahad asks first.", native: "gmail.trash", method: "POST", path: "/gmail/v1/users/me/messages/{id}/trash", params: { id: gmailId }, class: "delete" },
      },
      access: { only: "galahad", allowed: [] },
      private: true,
    },
  },
  outlook: {
    keyHelp: "it signs in with Microsoft, through an app you register once in Microsoft Entra (docs/MAIL.md says how)",
    // A message's id and its conversation's, as Graph gives them (AAMk…, AQMk…, AAQk…).
    ids: /^A[AQ][MQ]k[A-Za-z0-9_+/=-]{28,196}$/,
    manifest: {
      id: "outlook",
      label: "Outlook",
      description: "Your mail at Microsoft (Outlook.com, Microsoft 365): search, read, draft, archive; sending and trashing ask you first. Galahad's alone, and what it reads stays in the answer that read it, as the bank's data does.",
      origin: "https://graph.microsoft.com",
      auth: { secret: "outlook", scheme: "oauth", oauth: { provider: "microsoft", scopes: ["offline_access", "openid", "email", "profile", "User.Read", "Mail.ReadWrite", "Mail.Send"] } },
      tools: {
        search: { description: "Find messages by their words; without any, the inbox's latest.", native: "outlook.search", method: "GET", path: "/v1.0/me/messages", params: { query, limit }, class: "read" },
        read: { description: "One message: who, when, its subject, its words and whether it has attachments.", native: "outlook.read", method: "GET", path: "/v1.0/me/messages/{id}", params: { id: outlookId }, class: "read" },
        draft: { description: "A draft in your Drafts, unsent: a new message, or a reply (replyTo) in its conversation.", native: "outlook.draft", method: "POST", path: "/v1.0/me/messages", params: compose, class: "create" },
        send: { description: "Send a message, or a reply (replyTo) in its conversation. Others read it: Galahad asks first.", native: "outlook.send", method: "POST", path: "/v1.0/me/sendMail", params: compose, class: "outward" },
        archive: { description: "Out of the inbox, into Archive (back any time).", native: "outlook.archive", method: "POST", path: "/v1.0/me/messages/{id}/move", params: { id: outlookId }, class: "modify" },
        trash: { description: "Into Deleted Items. Galahad asks first.", native: "outlook.trash", method: "POST", path: "/v1.0/me/messages/{id}/move", params: { id: outlookId }, class: "delete" },
      },
      access: { only: "galahad", allowed: [] },
      private: true,
    },
  },
  // The owner's word of 18 November 2026: bilag copied from your mail (node bilag.ts), and all of your Drive to read
  // (drive.readonly). Galahad writes only files of its own there (drive.file), and changes or deletes nothing of yours.
  gdrive: {
    // A file's or a folder's id, and a page's token.
    ids: /^[A-Za-z0-9_-]{32,200}$/,
    keyHelp: "it signs in with Google, through the app you registered for Gmail with the Google Drive API on and the drive.readonly and drive.file scopes added (docs/BOOKS.md)",
    manifest: {
      id: "gdrive",
      label: "Google Drive",
      description: "Your Drive, to read: find files anywhere in it and in shared drives, look one up, read a Google Doc or Sheet. It writes only the bilag it copies from your mail (Bilag/<year>/<month>). Galahad's alone, and what it reads stays in the answer that read it, as the mail's does.",
      origin: "https://www.googleapis.com",
      auth: { secret: "gdrive", scheme: "oauth", oauth: { provider: "google", scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "openid", "email"] } },
      tools: {
        files: {
          description: "Find files anywhere in your Drive. q is Drive's search words: name contains 'ACME', fullText contains 'faktura' (a PDF's words too), '<folder id>' in parents, mimeType = 'application/pdf', trashed = false. fields: files(id,name,mimeType,parents,createdTime,webViewLink),nextPageToken. pageToken for the next page. Shared drives too: corpora allDrives, includeItemsFromAllDrives and supportsAllDrives true.",
          method: "GET",
          path: "/drive/v3/files",
          params: {
            q: { type: "string", description: "Drive's search words, e.g. name contains 'Telia' and trashed = false" },
            fields: { type: "string" },
            orderBy: { type: "string", description: "e.g. createdTime desc" },
            pageSize: { type: "integer", description: "how many (at most 1000)" },
            pageToken: { type: "string", description: "the nextPageToken a search gave" },
            corpora: { type: "string", enum: ["user", "drive", "allDrives"] },
            driveId: { type: "string", pattern: "[A-Za-z0-9_-]{10,100}" },
            includeItemsFromAllDrives: { type: "boolean" },
            supportsAllDrives: { type: "boolean" },
          },
          class: "read",
        },
        file: {
          description: "One file or folder by its id: give fields (id,name,mimeType,parents,size,createdTime,modifiedTime,webViewLink,owners(emailAddress)). Its parents lead to the folder it is in.",
          method: "GET",
          path: "/drive/v3/files/{id}",
          params: { id: driveId, fields: { type: "string" }, supportsAllDrives: { type: "boolean" } },
          class: "read",
        },
        export: {
          description: "A Google Doc, Sheet (its first sheet) or Slides as text: text/plain or text/markdown for a Doc or Slides, text/csv for a Sheet. Other files (a PDF, a picture) aren't read here: find them by their words with files (fullText contains).",
          method: "GET",
          path: "/drive/v3/files/{id}/export",
          params: { id: driveId, mimeType: { type: "string", enum: ["text/plain", "text/markdown", "text/csv"], required: true } },
          class: "read",
        },
      },
      access: { only: "galahad", allowed: [] },
      private: true,
    },
  },
};
