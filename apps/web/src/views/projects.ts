import type { ConversationSummary, MemoryView, ProjectView } from "@galahad/core";
import { isUnavailable } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { projectIdFrom } from "../lib/chats.ts";
import { relativeTime } from "../lib/time.ts";
import { badge, button, callout, empty, errorState, field, pageHead, section, skeletonRows } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { toast } from "../ui/toast.ts";

/*
 * Projects: workspaces for your work with Galahad. Each has instructions he follows
 * in its chats, an optional repository, its chats and the memories made in them.
 * Every node knows a project; setting one is yours (brain:write), never an agent's.
 */

/** Make or change a project. Resolves with its id when saved. */
function editProject(ctx: Ctx, all: ProjectView[], existing?: ProjectView): Promise<string | null> {
  return new Promise((resolve) => {
    const name = h("input", { class: "input", type: "text", maxlength: 80, value: existing?.name ?? "", autocomplete: "off", placeholder: "e.g. Rocket engine" });
    const instructions = h("textarea", { class: "input", rows: 8, maxlength: 8000, placeholder: "What Galahad should know and do in this project: goals, conventions, units, what to avoid…" }, existing?.instructions ?? "");
    const repo = h("input", { class: "input mono", type: "url", maxlength: 300, value: existing?.repo ?? "", placeholder: "https://github.com/you/project (optional)", autocomplete: "off" });
    const idHint = h("span", { class: "mono" });
    const problem = h("div");
    const idOf = () => existing?.id ?? projectIdFrom(name.value, all.map((p) => p.id));
    const syncId = () => (idHint.textContent = idOf());
    name.addEventListener("input", syncId);
    syncId();
    let done = false;
    const save = async () => {
      if (!name.value.trim()) return replace(problem, callout("warn", "Give it a name."));
      if (repo.value && !/^https:\/\//.test(repo.value)) return replace(problem, callout("warn", "The repository is an https:// address."));
      try {
        const id = idOf();
        await ctx.api.post("/api/projects", { id, name: name.value.trim(), instructions: instructions.value, repo: repo.value.trim() || null });
        done = true;
        resolve(id);
        sheet.close();
        toast(existing ? "Project saved" : "Project made", { tone: "info" });
      } catch (error) {
        replace(problem, callout("danger", errorMessage(error), { title: "Couldn't save it" }));
      }
    };
    const sheet = openSheet({
      title: existing ? `Edit ${existing.name}` : "New project",
      description: "Galahad follows its instructions in every chat in it. Every node knows it.",
      size: "wide",
      body: h(
        "form",
        { class: "stack", onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
        field("Name", name, { hint: existing ? null : h("span", {}, "Its id: ", idHint) }),
        field("Instructions", instructions, { hint: "Plain words or Markdown. No keys or passwords: they belong in the vault." }),
        field("Repository", repo),
        problem,
      ),
      footer: [button("Cancel", { onClick: () => sheet.close() }), button(existing ? "Save" : "Make project", { variant: "primary", onClick: () => void save() })],
      initialFocus: () => name,
      onClose: () => {
        if (!done) resolve(null);
      },
    });
  });
}

export const projectsView: View = (root, ctx, { scope, opts }) => {
  const canEdit = ctx.can("brain:write");
  const body = h("div", { class: "stack" }, h("div", { class: "card" }, skeletonRows(3)));
  let projects: ProjectView[] = [];
  let chats: ConversationSummary[] = [];

  async function load(): Promise<void> {
    try {
      const [p, c] = await Promise.all([
        ctx.api.get<{ projects: ProjectView[] }>("/api/projects", scope.signal),
        ctx.can("chat") ? ctx.api.get<{ conversations: ConversationSummary[] }>("/api/conversations", scope.signal).catch(() => ({ conversations: [] as ConversationSummary[] })) : { conversations: [] as ConversationSummary[] },
      ]);
      projects = p.projects;
      chats = c.conversations;
      render();
    } catch (error) {
      if (scope.disposed) return;
      replace(
        body,
        isUnavailable(error)
          ? empty({ icon: "folder", title: "Projects aren't available on this node yet", body: "They arrive with an update.", compact: true })
          : errorState("Couldn't load your projects", error, () => void load()),
      );
    }
  }

  const newProject = () =>
    void editProject(ctx, projects).then((id) => {
      if (id) ctx.navigate("projects", { project: id });
    });

  const chatRow = (c: ConversationSummary) =>
    h(
      "button",
      { class: "item chat-row", type: "button", onclick: () => ctx.navigate("chat", { conversation: c.id }) },
      h("span", { class: "avatar" }, icon("chat", { size: 14 })),
      h("div", { class: "grow" }, h("div", { class: "strong small ellipsis" }, c.title), h("div", { class: "meta" }, `${c.count} message${c.count === 1 ? "" : "s"} · ${relativeTime(c.updatedAt)}${c.bank ? " · bank" : ""}`)),
    );

  function list(): HTMLElement {
    if (!projects.length) {
      return empty({
        icon: "folder",
        title: "No projects yet",
        body: "A project keeps related chats together, with instructions Galahad follows in every one of them and the memories made in them.",
        actions: canEdit ? button("New project", { variant: "primary", icon: "plus", onClick: newProject }) : null,
      });
    }
    return h(
      "div",
      { class: "grid cards" },
      ...projects.map((p) => {
        const count = chats.filter((c) => c.project === p.id).length;
        return h(
          "button",
          { class: "card card-link", type: "button", onclick: () => ctx.navigate("projects", { project: p.id }) },
          h(
            "div",
            { class: "card-body stack tight" },
            h("div", { class: "row" }, h("span", { class: "avatar" }, icon("folder", { size: 14 })), h("span", { class: "strong" }, p.name), h("span", { class: "spacer" }), count ? badge(`${count} chat${count === 1 ? "" : "s"}`, "neutral") : null),
            p.instructions ? h("p", { class: "small muted clamp-2" }, p.instructions.split("\n").find((l) => l.trim()) ?? "") : h("p", { class: "small subtle" }, "No instructions yet."),
            p.repo ? h("span", { class: "tiny mono subtle ellipsis" }, p.repo.replace(/^https:\/\//, "")) : null,
          ),
        );
      }),
    );
  }

  function detail(p: ProjectView): HTMLElement {
    const memories = h("div", {}, skeletonRows(2));
    ctx.api
      .post<{ memories: MemoryView[] }>("/api/memories/search", { q: p.id, limit: 100 }, scope.signal)
      .then(({ memories: found }) => {
        const mine = found.filter((m) => m.tags.includes(`project:${p.id}`));
        replace(
          memories,
          mine.length
            ? h("div", { class: "card" }, h("div", { class: "rows" }, ...mine.slice(0, 20).map((m) => h("div", { class: "item" }, h("span", { class: "avatar" }, icon("memory", { size: 14 })), h("div", { class: "grow small wrap-anywhere" }, m.text, h("div", { class: "meta" }, m.trust))))))
            : h("p", { class: "small muted" }, "Nothing remembered in this project yet. What Galahad remembers in its chats lands here."),
        );
      })
      .catch(() => replace(memories));
    const mine = chats.filter((c) => c.project === p.id);
    const remove = async () => {
      const ok = await confirmAction({
        title: `Remove ${p.name}?`,
        body: [h("p", {}, "The project goes from every node. Its chats stay, outside any project, and so do its memories.")],
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await ctx.api.post("/api/projects/remove", { id: p.id }, scope.signal);
        toast("Project removed", { tone: "info" });
        ctx.navigate("projects");
      } catch (error) {
        toast("Couldn't remove it", { tone: "error", description: errorMessage(error) });
      }
    };
    return h(
      "div",
      { class: "stack" },
      h("div", {}, button("All projects", { variant: "ghost", size: "sm", icon: "chevron-left", onClick: () => ctx.navigate("projects") })),
      pageHead(
        p.name,
        p.repo ? h("a", { href: p.repo, target: "_blank", rel: "noopener noreferrer", class: "mono small" }, p.repo.replace(/^https:\/\//, ""), " ", icon("external", { size: 12 })) : null,
        h(
          "div",
          { class: "row wrap" },
          ctx.can("chat") ? button("New chat", { variant: "primary", icon: "plus", onClick: () => ctx.navigate("chat", { project: p.id }) }) : null,
          canEdit ? button("Edit", { icon: "edit", onClick: () => void editProject(ctx, projects, p).then((id) => id && void load()) }) : null,
          canEdit ? button("Remove", { variant: "danger", icon: "trash", onClick: () => void remove() }) : null,
        ),
      ),
      section(
        "Instructions",
        {},
        p.instructions ? h("div", { class: "card" }, h("div", { class: "card-body md" }, renderMarkdown(p.instructions))) : h("p", { class: "small muted" }, canEdit ? "None yet: Edit gives Galahad instructions for this project." : "None yet."),
      ),
      section("Chats", { count: String(mine.length) }, mine.length ? h("div", { class: "card" }, h("div", { class: "rows" }, ...mine.map(chatRow))) : h("p", { class: "small muted" }, "No chats in it yet.")),
      section("Remembered here", {}, memories),
    );
  }

  function render(): void {
    if (opts.project) {
      const p = projects.find((x) => x.id === opts.project);
      replace(body, p ? detail(p) : empty({ icon: "folder", title: "No such project", actions: button("All projects", { onClick: () => ctx.navigate("projects") }) }));
      return;
    }
    replace(body, list());
  }

  replace(
    root,
    h(
      "div",
      { class: "page" },
      opts.project ? null : pageHead("Projects", "Workspaces for your work with Galahad: instructions he follows, an optional repository, and their own chats and memories.", canEdit ? button("New project", { variant: "primary", icon: "plus", onClick: newProject }) : null),
      body,
    ),
  );
  void load();
};
