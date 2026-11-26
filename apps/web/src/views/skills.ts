import { SKILL_LIMITS, SKILLS_BUDGET_MAX, skillAuthor, type SkillDetail, type SkillDoc, skillRecordLine, type SkillsView, type SkillVersionView, type SkillView } from "@galahad/core/skills";
import { ApiError, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { budgetLine, docFromForm, formOf, originWords, shownVersion, type SkillForm, skillGroups, stateBadge, trustWords, waitingVersion } from "../lib/skills.ts";
import { relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, empty, errorState, field, formActions, pageBody, pageHead, section, skeletonBlock, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, keepPlace, nextId, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { trustBadge } from "./memory.ts";

/*
 * His skills (#/skills): how he did a kind of work that passed review, kept as notes he
 * is given again. Each is a page: when to use it, the steps, what proves it worked, the
 * pitfalls, where it came from and its track record. What waits for you comes first, in
 * full, with Approve beside it: an untrusted skill is given to no model before that.
 * You write and edit your own; you lock, retire and roll back any. Nothing here runs:
 * a skill is words, drawn as text.
 */

const skillsChanged = signal(0);
const changed = (): void => skillsChanged.update((n) => n + 1);

const when = (ms: number): HTMLElement => h("span", { title: new Date(ms).toLocaleString() }, relativeTime(ms));

/** A skill's words, as a page: when to use it, the steps, the proof, the pitfalls. Text only, whatever it says. */
function words(doc: SkillDoc | null): HTMLElement[] {
  if (!doc) return [h("p", { class: "subtle" }, "This node can't read this version's words: a newer node wrote it. Open it from that node.")];
  return [
    h("section", { class: "skill-part" }, h("h4", {}, "When to use it"), h("p", {}, doc.when)),
    h("section", { class: "skill-part" }, h("h4", {}, "Steps"), h("ol", {}, ...doc.steps.map((s) => h("li", {}, s)))),
    doc.proof.length
      ? h(
          "section",
          { class: "skill-part" },
          h("h4", {}, "What proves it worked"),
          h("ul", { class: "skill-proof" }, ...doc.proof.map((p) => h("li", {}, h("code", {}, `$ ${p.command}`), h("div", { class: "expect" }, `Expect: ${p.expect}`)))),
        )
      : null,
    doc.pitfalls.length ? h("section", { class: "skill-part" }, h("h4", {}, "Pitfalls"), h("ul", {}, ...doc.pitfalls.map((p) => h("li", {}, p)))) : null,
    // A skill taken in from elsewhere: its instructions as they were written there, as text (what a model is given).
    doc.body ? h("section", { class: "skill-part" }, h("h4", {}, "Its instructions"), h("pre", { class: "skill-body" }, doc.body)) : null,
  ].filter((el): el is HTMLElement => el !== null);
}

/** Where a version came from: who wrote it, from what, and what its trust means. */
function origin(v: SkillVersionView): HTMLElement {
  return h("div", { class: "skill-origin" }, h("p", {}, originWords(v)), h("div", { class: "meta" }, trustBadge(v.trust), when(v.at)), h("p", { class: "tiny subtle" }, trustWords(v)));
}

async function act(ctx: Ctx, path: string, body: unknown, done: string): Promise<boolean> {
  try {
    await ctx.api.post(path, body);
    toast(done, { tone: "ok" });
    changed();
    return true;
  } catch (error) {
    toast("That didn't go through", { tone: "error", description: errorMessage(error) });
    return false;
  }
}

/** Approve exactly the version on screen: said once more, with where it came from, before it's sent. */
async function approve(ctx: Ctx, skill: SkillDetail, version: SkillVersionView): Promise<boolean> {
  const ok = await confirmAction({
    title: "Approve this version?",
    body: [
      h("p", { class: "wrap-anywhere plain" }, version.doc?.title ?? skill.title),
      h("p", {}, originWords(version)),
      h("p", {}, "Approved, he's given it as a note when it bears on a quest or a question: data, fenced, still marked untrusted. It never runs anything by itself, and you can retire it or roll it back."),
    ],
    confirmLabel: "Approve",
    tone: "primary",
  });
  return ok ? act(ctx, "/api/skills/approve", { id: skill.id, version: version.id }, "Approved: it's in use on every node") : false;
}

/* ---------- the editor: yours ---------- */

export function openSkillEditor(ctx: Ctx, existing?: { id: string; doc: SkillDoc | null; by: string }): void {
  const form = formOf(existing?.doc ?? null);
  const title = h("input", { class: "input", id: "skill-title", maxlength: SKILL_LIMITS.title, placeholder: "What kind of work this is", autocomplete: "off" });
  const whenTo = h("textarea", { class: "textarea", id: "skill-when", rows: 2, maxlength: SKILL_LIMITS.when, placeholder: "When he should reach for it" });
  const steps = h("textarea", { class: "textarea", id: "skill-steps", rows: 6, placeholder: "One step a line, in plain words" });
  const proof = h("textarea", { class: "textarea mono", id: "skill-proof", rows: 3, placeholder: "bun test => 0 fail", autocorrect: "off", spellcheck: "false" });
  const pitfalls = h("textarea", { class: "textarea", id: "skill-pitfalls", rows: 3, placeholder: "One a line: what goes wrong, and how to tell" });
  const inputs: Record<keyof SkillForm, HTMLInputElement | HTMLTextAreaElement> = { title, when: whenTo, steps, proof, pitfalls };
  for (const key of Object.keys(inputs) as (keyof SkillForm)[]) inputs[key].value = form[key];
  const status = h("div", { role: "status" });
  const save = button(existing ? "Save a new version" : "Save skill", { variant: "primary", icon: "check", onClick: () => body.requestSubmit() });
  /** What's wrong, said where it's seen: beside the buttons, with the field marked. */
  const say = (tone: "warn" | "danger", message: string, at?: keyof SkillForm): void => {
    for (const key of Object.keys(inputs) as (keyof SkillForm)[]) inputs[key].toggleAttribute("aria-invalid", key === at);
    replace(status, callout(tone, message));
    status.scrollIntoView({ block: "nearest" });
  };
  const body = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const read = docFromForm({ title: title.value, when: whenTo.value, steps: steps.value, proof: proof.value, pitfalls: pitfalls.value });
        if ("problem" in read) return say("warn", read.problem, read.field);
        void busy(save, async () => {
          try {
            // Instructions it was taken in with stay as they were: this form doesn't hold them.
            const kept = existing?.doc?.body ? { body: existing.doc.body } : {};
            await ctx.api.post("/api/skills", { ...(existing ? { id: existing.id } : {}), doc: { ...read.doc, ...kept } });
            sheet.close();
            changed();
            toast(existing ? "Saved as a new version, yours" : "Saved: it's in use on every node", { tone: "ok" });
          } catch (error) {
            say(error instanceof ApiError && error.status === 422 ? "warn" : "danger", errorMessage(error));
          }
        });
      },
    },
    field("Title", title),
    field("When to use it", whenTo),
    field("Steps", steps, { hint: `One a line, up to ${SKILL_LIMITS.steps}. Words he reads: nothing here runs by itself.` }),
    field("What proves it worked (optional)", proof, { hint: 'One a line: a command, "=>", and what to expect of it.' }),
    field("Pitfalls (optional)", pitfalls),
    existing && existing.by !== "owner" ? callout("quiet", `This version is by ${skillAuthor(existing.by)}. Saving makes the skill yours: he uses it, and never changes what you wrote. The earlier versions stay in its history.`) : null,
    existing?.doc?.body ? callout("quiet", "Its instructions, as it was taken in with them, stay as they are.") : null,
    status,
  );
  const sheet = openSheet({
    title: existing ? "Edit this skill" : "Write a skill",
    description: "Yours: he's given it as a note when it bears on his work. Plain words only; no keys or passwords, they belong in the vault.",
    size: "wide",
    body,
    footer: [button("Cancel", { onClick: () => sheet.close() }), save],
    initialFocus: () => title,
  });
}

/* ---------- one from elsewhere: yours to take in ---------- */

/** An Agent Skill's folder on GitHub, taken in as text: it waits for your approval like any skill shaped by the outside. */
export function openSkillImport(ctx: Ctx): void {
  const url = h("input", { class: "input", id: "skill-import-url", type: "url", inputmode: "url", placeholder: "https://github.com/owner/repo/tree/main/skills/name", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const status = h("div", { role: "status" });
  const take = button("Take it in", { variant: "primary", icon: "download", onClick: () => body.requestSubmit() });
  const body = h(
    "form",
    {
      class: "stack loose",
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (!url.value.trim()) return void url.focus();
        void busy(take, async () => {
          try {
            const done = await ctx.api.post<{ skill: SkillView; shortened: boolean }>("/api/skills/take-in", { url: url.value.trim() });
            sheet.close();
            changed();
            toast(`Taken in: ${done.skill.title}`, { tone: "ok", description: `It waits for your approval below${done.shortened ? "; its instructions were cut where it says" : ""}.` });
          } catch (error) {
            url.setAttribute("aria-invalid", "true");
            replace(status, callout(error instanceof ApiError && error.status < 500 ? "warn" : "danger", errorMessage(error)));
          }
        });
      },
    },
    field("Its folder on GitHub", url, { hint: "An Agent Skill: a folder whose SKILL.md says its name, when to use it, and how." }),
    callout("quiet", "Only its SKILL.md is read, as text: nothing in the folder runs, and its scripts and other files stay where they are. It waits here for you; no model is given it before you've read it and approved it."),
    status,
  );
  const sheet = openSheet({
    title: "Take in a skill",
    description: "From a folder of Agent Skills on GitHub, as words he reads.",
    body,
    footer: [button("Cancel", { onClick: () => sheet.close() }), take],
    initialFocus: () => url,
  });
}

/* ---------- one skill, as a page ---------- */

async function openSkill(ctx: Ctx, id: string, title: string): Promise<void> {
  const own = ctx.can("fleet:admin");
  const body = h("div", { class: "skill-page", "aria-busy": "true" }, skeletonBlock(220));
  // The sheet's own footer starts with Close, so it's there (and in the tab order) before the skill has loaded.
  const sheet = openSheet({ title, size: "wide", body, footer: button("Close", { onClick: () => sheet.close() }) });
  const heading = sheet.el.querySelector(".sheet-head h2");
  let shown = "";

  async function load(): Promise<void> {
    let skill: SkillDetail;
    try {
      ({ skill } = await ctx.api.post<{ skill: SkillDetail }>("/api/skills/get", { id }, sheet.scope.signal));
    } catch (error) {
      if (!sheet.scope.disposed) replace(body, errorState("Couldn't open this skill", error, () => void load()));
      return;
    }
    if (sheet.scope.disposed) return;
    const key = JSON.stringify(skill);
    if (key === shown) return;
    shown = key;
    const version = shownVersion(skill);
    const waiting = waitingVersion(skill);
    const head = skill.history.find((v) => v.id === skill.head);
    const state = stateBadge(skill);
    // Its title is the sheet's (a rollback or an edit may have changed it).
    if (heading) heading.textContent = skill.title;
    const again = async (work: Promise<boolean>): Promise<void> => {
      if (await work) void load();
    };
    keepPlace(body, () =>
      replace(
        body,
        h("header", { class: "skill-head" }, h("div", { class: "meta" }, badge(state.label, state.tone), version ? trustBadge(version.trust) : null, skill.locked ? badge("locked", "neutral", "shield") : null, h("span", {}, skillRecordLine(skill)))),
        ...words(version?.doc ?? null),
        version ? h("section", { class: "skill-part" }, h("h4", {}, "Where it came from"), origin(version)) : null,
        waiting && waiting.id !== version?.id
          ? h(
              "section",
              { class: "skill-part skill-waiting" },
              h("h4", {}, "A new version waits for your approval"),
              h("p", { class: "tiny subtle" }, "The version above goes on being used until you decide."),
              h("div", { class: "card skill-page" }, h("header", { class: "skill-head" }, h("h3", {}, waiting.doc?.title ?? "(unreadable here)")), ...words(waiting.doc), origin(waiting)),
              own
                ? h(
                    "div",
                    { class: "skill-foot" },
                    waiting.doc ? button("Approve this version", { variant: "primary", icon: "check", onClick: () => void again(approve(ctx, skill, waiting)) }) : null,
                    button("Decline it", { icon: "undo", onClick: () => void again(act(ctx, "/api/skills/rollback", { id }, "Declined: the version in use stays")) }),
                  )
                : null,
            )
          : null,
        skill.record.length
          ? h(
              "section",
              { class: "skill-part" },
              h("h4", {}, "Used in"),
              h("ul", { class: "skill-record" }, ...skill.record.slice(0, 12).map((u) => h("li", {}, h("span", { class: "mono" }, u.quest.startsWith("chat:") ? "a chat answer" : u.quest), u.status ? badge(u.status === "done" ? "passed review" : u.status, u.status === "done" ? "ok" : "neutral") : null, when(u.at)))),
            )
          : null,
        h(
          "section",
          { class: "skill-part" },
          h("h4", {}, `Versions (${skill.history.length}; none is ever deleted)`),
          h(
            "ul",
            { class: "skill-record" },
            ...[...skill.history].reverse().map((v) =>
              h(
                "li",
                { class: "skill-version" },
                h("span", { class: "grow wrap-anywhere" }, h("span", { class: "tnum subtle" }, `v${v.n} `), v.doc?.title ?? "(unreadable here)"),
                h("span", { class: "meta" }, v.id === skill.offered ? badge("in use", "ok") : v.id === skill.pending ? badge("waits for you", "warn") : null, trustBadge(v.trust), h("span", {}, `by ${skillAuthor(v.by)}`), when(v.at)),
              ),
            ),
          ),
        ),
      ),
    );
    body.setAttribute("aria-busy", "false");
    replace(
      sheet.foot,
      ctx.can("mind:write") && skill.state !== "retired" ? button("Edit", { icon: "edit", onClick: () => (sheet.close(), openSkillEditor(ctx, { id, doc: version?.doc ?? null, by: version?.by ?? "" })) }) : null,
      own && head?.prev && !(waiting && waiting.id !== version?.id)
        ? button("Roll back one version", {
            icon: "undo",
            onClick: async () => {
              const prev = skill.history.find((v) => v.id === head.prev);
              const ok = await confirmAction({ title: "Go back one version?", body: [h("p", {}, `From v${head.n} to v${prev?.n ?? "?"}: “${prev?.doc?.title ?? "the version before"}”. Both stay in its history.`)], confirmLabel: "Roll back", tone: "primary" });
              if (ok) void again(act(ctx, "/api/skills/rollback", { id }, "Rolled back one version"));
            },
          })
        : null,
      own && skill.state !== "retired"
        ? button(skill.locked ? "Unlock" : "Lock", { icon: "shield", title: skill.locked ? "He may revise it again, if he wrote it" : "He may use it, but not change it", onClick: () => void again(act(ctx, "/api/skills/lock", { id, locked: !skill.locked }, skill.locked ? "Unlocked" : "Locked: he uses it, and can't change it")) })
        : null,
      own
        ? skill.state === "retired"
          ? button("Put back in use", { icon: "retry", onClick: () => void again(act(ctx, "/api/skills/retire", { id, retired: false }, "Back in use")) })
          : button("Retire", { icon: "archive", title: "Kept with every version, and offered to nobody", onClick: () => void again(act(ctx, "/api/skills/retire", { id, retired: true }, "Retired: kept, and offered to nobody")) })
        : null,
      button("Close", { onClick: () => sheet.close() }),
    );
  }

  sheet.scope.add(skillsChanged.subscribe(() => void load()));
  await load();
}

/* ---------- the page ---------- */

export const skillsView: View = (root, ctx, { scope, opts }) => {
  const own = ctx.can("fleet:admin");
  const waitingSlot = h("div", { class: "stack" });
  const list = h("div", { class: "card", "aria-busy": "true" }, skeletonRows(4));
  const retiredSlot = h("div");
  const budgetSlot = h("div", { class: "skills-budget" });
  let loaded = false;
  let shown = "";

  /** A skill that waits, in full, with your answer beside it. */
  function waitingCard(skill: SkillDetail): HTMLElement | null {
    const waiting = waitingVersion(skill);
    if (!waiting) return null;
    const revision = skill.offered !== null;
    const heading = nextId("skill");
    return h(
      "article",
      { class: "card skill-page", "aria-labelledby": heading, "data-skill": skill.id },
      h(
        "header",
        { class: "skill-head" },
        h("h3", { id: heading }, waiting.doc?.title ?? "(unreadable here)"),
        h(
          "div",
          { class: "meta" },
          badge(revision ? "a new version waits for you" : "waits for you", "warn"),
          trustBadge(waiting.trust),
          h("span", {}, `by ${skillAuthor(waiting.by)}`),
          revision ? h("span", {}, `· of “${skill.title}”, which stays in use until you decide`) : null,
        ),
      ),
      ...words(waiting.doc),
      h("section", { class: "skill-part" }, h("h4", {}, "Where it came from"), origin(waiting)),
      own
        ? h(
            "footer",
            { class: "skill-foot" },
            waiting.doc ? button("Approve", { variant: "primary", icon: "check", onClick: () => void approve(ctx, skill, waiting) }) : null,
            revision
              ? button("Decline it", { icon: "undo", onClick: () => void act(ctx, "/api/skills/rollback", { id: skill.id }, "Declined: the version in use stays") })
              : button("Retire", { icon: "archive", title: "Kept in the mind, and offered to nobody", onClick: () => void act(ctx, "/api/skills/retire", { id: skill.id, retired: true }, "Retired: kept, and offered to nobody") }),
            h("span", { class: "grow" }),
            h("span", { class: "tiny subtle" }, "Read it all first: once approved, he's given it as a note."),
          )
        : h("footer", { class: "skill-foot tiny subtle" }, "This device can't approve skills (it was paired without fleet:admin)."),
    );
  }

  function row(skill: SkillView): HTMLElement {
    const state = stateBadge(skill);
    return h(
      "button",
      { class: "item item-button", type: "button", "data-skill": skill.id, onclick: () => void openSkill(ctx, skill.id, skill.title) },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "skill-row-title wrap-anywhere" }, skill.title),
        skill.when ? h("div", { class: "subtle wrap-anywhere skill-row-when" }, skill.when) : null,
        h(
          "div",
          { class: "meta" },
          badge(state.label, state.tone),
          trustBadge(skill.trust),
          skill.locked ? badge("locked", "neutral", "shield") : null,
          skill.state !== "retired" && skill.pending && skill.offered ? badge("a new version waits", "warn") : null,
          h("span", {}, skillRecordLine(skill)),
          skill.lastUsedAt ? h("span", {}, "last used ", when(skill.lastUsedAt)) : null,
        ),
      ),
    );
  }

  function budget(view: SkillsView): void {
    replace(
      budgetSlot,
      h("span", {}, budgetLine(view.budget)),
      ctx.can("brain:write")
        ? button("Change", {
            size: "sm",
            variant: "ghost",
            onClick: () => {
              const input = h("input", { class: "input tnum", id: "skills-budget", type: "number", min: 0, max: SKILLS_BUDGET_MAX, step: 500, value: String(view.budget.tokensPerDay), inputmode: "numeric" });
              const status = h("div", { role: "status" });
              const save = button("Save", { variant: "primary", type: "submit" });
              const sheet = openSheet({
                title: "Budget for distilling skills",
                description: "When a quest of his passes its review, the cheapest usable role may write one skill from its evidence, in one bounded call. This is the most it may spend in a day; 0 turns it off.",
                size: "small",
                body: h(
                  "form",
                  {
                    class: "stack",
                    onsubmit: (event: Event) => {
                      event.preventDefault();
                      const tokensPerDay = Number(input.value);
                      if (!Number.isInteger(tokensPerDay) || tokensPerDay < 0 || tokensPerDay > SKILLS_BUDGET_MAX) return replace(status, callout("warn", `A whole number of tokens a day, 0 to ${SKILLS_BUDGET_MAX.toLocaleString("en-GB")}.`));
                      void busy(save, async () => {
                        try {
                          await ctx.api.post("/api/skills/budget", { tokensPerDay });
                          sheet.close();
                          changed();
                          toast(tokensPerDay === 0 ? "He distils no skills now" : "Budget saved", { tone: "ok" });
                        } catch (error) {
                          replace(status, callout("danger", errorMessage(error)));
                        }
                      });
                    },
                  },
                  field("Tokens a day", input, { hint: "About four characters a token; one distillation is at most 2,500." }),
                  status,
                  formActions(button("Cancel", { onClick: () => sheet.close() }), save),
                ),
                initialFocus: () => input,
              });
            },
          })
        : null,
    );
  }

  async function load(): Promise<void> {
    try {
      const view = await ctx.api.get<SkillsView>("/api/skills", scope.signal);
      const groups = skillGroups(view.skills);
      // What waits is shown in full: its words are what you approve.
      const details = await Promise.all(groups.waiting.map((s) => ctx.api.post<{ skill: SkillDetail }>("/api/skills/get", { id: s.id }, scope.signal).then((r) => r.skill, () => null)));
      if (scope.disposed) return;
      loaded = true;
      const key = JSON.stringify([view, details]);
      if (key === shown) return;
      shown = key;
      budget(view);
      const cards = details.map((d) => (d ? waitingCard(d) : null)).filter((el): el is HTMLElement => el !== null);
      keepPlace(root, () => {
        replace(waitingSlot, cards.length ? section("Waiting for you", { count: String(cards.length) }, h("div", { class: "stack" }, ...cards)) : null);
        replace(
          list,
          groups.inUse.length
            ? h("div", { class: "rows" }, ...groups.inUse.map(row))
            : empty({
                icon: "scroll",
                title: cards.length ? "None in use yet" : "No skills yet",
                body: "He learns one when a quest of his passes its independent review: one short note on how that kind of work went, from the commands that ran and the plan. You can write one yourself, too.",
                actions: ctx.can("mind:write") ? button("Write a skill", { variant: "primary", icon: "plus", onClick: () => openSkillEditor(ctx) }) : null,
                compact: cards.length > 0,
              }),
        );
        replace(
          retiredSlot,
          groups.retired.length
            ? h(
                "details",
                { class: "card disclosure skills-retired" },
                h("summary", {}, icon("chevron-right", { size: 14, class: "chev" }), h("span", { class: "grow" }, `Retired (${groups.retired.length})`), h("span", { class: "tiny subtle" }, "kept with every version, offered to nobody")),
                h("div", { class: "rows" }, ...groups.retired.map(row)),
              )
            : null,
        );
      });
      list.setAttribute("aria-busy", "false");
    } catch (error) {
      if (scope.disposed || loaded) return;
      list.setAttribute("aria-busy", "false");
      replace(
        list,
        isUnavailable(error)
          ? empty({ icon: "scroll", title: "His skills aren't on this node yet", body: "They arrive with an update.", compact: true })
          : errorState("Couldn't open his skills", error, () => void load()),
      );
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead(
        "Skills",
        "How he did a kind of work that passed its review, kept as notes he's given again when they bear on what he's doing. A skill is words he reads: nothing in one runs. One shaped by the outside world waits here for you first.",
        h(
          "div",
          { class: "row" },
          ctx.can("fleet:admin") ? button("Take one in", { icon: "download", onClick: () => openSkillImport(ctx) }) : null,
          ctx.can("mind:write") ? button("Write a skill", { variant: "primary", icon: "plus", onClick: () => openSkillEditor(ctx) }) : null,
        ),
      ),
      // Shown whole once his skills have answered: the budget and what waits for you came in above those in use.
      pageBody(budgetSlot, waitingSlot, section("In use", {}, list), retiredSlot),
    ),
  );
  scope.add(skillsChanged.subscribe(() => void load()));
  scope.interval(() => void load(), 30_000);
  void load();
  if (opts.intent === "write") openSkillEditor(ctx);
};
