import { readAgentSkill, type SkillDoc } from "@galahad/core";

/*
 * Skills from elsewhere (PLAN #34): an Agent Skill's folder on GitHub (its SKILL.md: a name, when to use it, then
 * instructions in Markdown), taken in as text alone. Only its SKILL.md is read, from GitHub's raw files at the address
 * you gave and nowhere it might send us; nothing in the folder runs, and nothing else in it (scripts, other files) is
 * taken in. It becomes a skill that waits for your approval, as his untrusted ones do: no model is given it before you
 * have read it and said yes, and then only as a note, fenced as data.
 */

export const RAW_GITHUB = "https://raw.githubusercontent.com";
/** A SKILL.md larger than this is no skill to read (Agent Skills ask for under 500 lines). */
const MAX_SKILL_MD = 256 * 1024;

export class SkillImportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SkillAddress {
  owner: string;
  repo: string;
  /** A branch, a tag or a commit (HEAD: the repository's default branch). */
  ref: string;
  /** The folder in the repository ("" for its top). */
  path: string;
  /** Where it is, as its skill names its author: github.com/<owner>/<repo>[/<folder>]. */
  where: string;
  /** Its SKILL.md's raw file, where it's read from. */
  raw: string;
  /** Its folder's page on GitHub, kept as where the skill came from. */
  page: string;
}

const SEGMENT = /^[A-Za-z0-9._@+-]{1,200}$/;
const named = (segment: string | undefined): segment is string => !!segment && SEGMENT.test(segment) && segment !== "." && segment !== "..";

/**
 * A folder of an Agent Skill on GitHub, from its address: github.com/<owner>/<repo>/tree/<ref>/<folder>, its SKILL.md's
 * (…/blob/<ref>/<folder>/SKILL.md), or a repository whose top is the skill. Anything else is refused.
 */
export function skillAddress(url: string): SkillAddress {
  let address: URL;
  try {
    address = new URL(url.trim());
  } catch {
    throw new SkillImportError(400, "that isn't an address (a skill's folder on GitHub: https://github.com/<owner>/<repo>/tree/<branch>/<folder>)");
  }
  if (address.protocol !== "https:" || address.hostname !== "github.com" || address.port || address.username || address.password) {
    throw new SkillImportError(400, "a skill is taken in from its folder on GitHub: https://github.com/<owner>/<repo>/tree/<branch>/<folder>");
  }
  let parts: string[];
  try {
    parts = address.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new SkillImportError(400, "that address doesn't read as a folder on GitHub");
  }
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!named(owner) || !named(repo)) throw new SkillImportError(400, "that address names no repository on GitHub");
  if (kind !== undefined && kind !== "tree" && kind !== "blob") throw new SkillImportError(400, "that address is no folder on GitHub (…/tree/<branch>/<folder>)");
  if (kind !== undefined && !named(ref)) throw new SkillImportError(400, "that address names no branch, tag or commit");
  if (kind === "blob" && rest.at(-1) !== "SKILL.md") throw new SkillImportError(400, "that's a file, not a skill: give its folder, or its SKILL.md");
  const folder = kind === "blob" ? rest.slice(0, -1) : rest;
  if (!folder.every(named)) throw new SkillImportError(400, "that address's folder doesn't read as one");
  const path = folder.join("/");
  const at = ref ?? "HEAD";
  const repository = `${owner}/${repo.replace(/\.git$/, "")}`;
  const encoded = [...folder, "SKILL.md"].map(encodeURIComponent).join("/");
  return {
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref: at,
    path,
    where: `github.com/${repository}${path ? `/${path}` : ""}`,
    raw: `${RAW_GITHUB}/${repository}/${encodeURIComponent(at)}/${encoded}`,
    page: `https://github.com/${repository}/tree/${encodeURIComponent(at)}${path ? `/${folder.map(encodeURIComponent).join("/")}` : ""}`,
  };
}

/** A body read no further than `max` bytes: past it, the read stops and nothing is kept. */
async function capped(response: Response, max: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Read an Agent Skill's SKILL.md from its folder on GitHub, as a skill of his: words, nothing that runs. */
export async function fetchAgentSkill(url: string, o: { fetch?: typeof fetch; base?: string } = {}): Promise<{ doc: SkillDoc; where: string; source: string; shortened: boolean }> {
  const at = skillAddress(url);
  const target = o.base ? at.raw.replace(RAW_GITHUB, o.base) : at.raw;
  let response: Response;
  try {
    // That address and no other: a redirect is never followed.
    response = await (o.fetch ?? fetch)(target, { redirect: "manual", headers: { "user-agent": "galahad/0.1 (+https://galahad.sh)" }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new SkillImportError(502, `GitHub couldn't be reached: ${(error as Error).message}`);
  }
  if (response.status === 404) throw new SkillImportError(404, `there's no SKILL.md in ${at.where} (on ${at.ref}): give the folder that holds one`);
  if (response.status >= 300 && response.status < 400) throw new SkillImportError(502, `GitHub sent that address elsewhere (${response.status}); give the skill's address as it is now`);
  if (!response.ok) throw new SkillImportError(502, `GitHub answered ${response.status} for ${at.where}`);
  const text = await capped(response, MAX_SKILL_MD);
  if (text === null) throw new SkillImportError(413, `its SKILL.md is over ${MAX_SKILL_MD / 1024} KB: no skill to read`);
  const read = readAgentSkill(text, at.where);
  if (!read.ok) throw new SkillImportError(422, `That isn't an Agent Skill: ${read.why}.`);
  return { doc: read.doc, where: at.where, source: at.page, shortened: read.shortened };
}
