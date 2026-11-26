/*
 * Something shared to Galahad from another app. Android's share sheet opens the installed app at
 * /?share-title=…&share-text=…&share-url=… (the manifest's share_target), and what was shared lands in a
 * new chat's message box, unsent: the words are the other app's, and only you send them. (iOS has no
 * share target for a web app.)
 */

/** The query names the manifest's share_target gives what is shared. */
export const SHARE_PARAMS = { title: "share-title", text: "share-text", url: "share-url" } as const;

/** No more of it lands in the message box than this. */
export const SHARE_MAX = 8000;

// Control characters but the line break and the tab, bidirectional overrides and isolates, zero-width characters.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** What was shared, as the message box takes it: the title, the text, the link (each once), or null if there's nothing. */
export function readShare(search: string): string | null {
  const query = new URLSearchParams(search);
  const part = (name: string) => (query.get(name) ?? "").replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim();
  const title = part(SHARE_PARAMS.title);
  const text = part(SHARE_PARAMS.text);
  // Only a web link: anything else (javascript:, a file) is no link of the page's.
  const url = /^https?:\/\/\S+$/i.test(part(SHARE_PARAMS.url)) ? part(SHARE_PARAMS.url) : "";
  const parts = [title && !text.includes(title) ? title : "", text, url && !text.includes(url) ? url : ""].filter(Boolean);
  if (!parts.length) return null;
  const joined = parts.join("\n\n");
  return joined.length > SHARE_MAX ? joined.slice(0, SHARE_MAX) : joined;
}

/** Whether an address is a share (it carries one of the share's names), so it leaves the address bar once read. */
export const isShare = (search: string): boolean => Object.values(SHARE_PARAMS).some((name) => new URLSearchParams(search).has(name));
