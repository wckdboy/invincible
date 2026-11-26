import type { SlackView, TelegramView } from "@galahad/core";
import { type Ctx, errorMessage } from "../context.ts";
import { relativeTime } from "../lib/time.ts";
import { busy, button, callout, card, copyField, copyText, listRow, note, secretInput, section, skeletonBlock } from "../ui/controls.ts";
import { confirmAction } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";

/*
 * Chat apps (PLAN #19): Telegram, through a bot of yours, and Slack, through an app of yours, on the node this device
 * talks to. Connecting takes the bot's token, or the app's two (sealed on the node, as a key is), and gives a code to
 * send it from your own account; only that account is answered, as a device of its own that may chat. Its chats are
 * yours, here.
 */

/** The code Connect answered, held here only (the node shows it to nobody after): it links your account once. */
interface LinkCode {
  code: string;
  expires: number;
}

export function chatAppsSection(ctx: Ctx): { el: HTMLElement; refresh: () => Promise<void> } {
  const body = h("div", { class: "stack" }, skeletonBlock(120));
  const el = section("Chat apps", { note: "Talk to Galahad from a chat app you already use. Approvals stay here." }, body);
  el.hidden = !ctx.can("mind:read");
  let code: LinkCode | null = null;
  let slackCode: LinkCode | null = null;

  async function refresh(): Promise<void> {
    if (el.hidden) return;
    try {
      // (The app to make in Slack comes from the node, as data: this page carries no copy of its own.)
      const [{ telegram }, { slack, manifest }] = await Promise.all([ctx.api.get<{ telegram: TelegramView }>("/api/telegram"), ctx.api.get<{ slack: SlackView; manifest: unknown }>("/api/slack")]);
      if (telegram.owner || !telegram.connected) code = null;
      if (slack.owner || !slack.connected) slackCode = null;
      replace(
        body,
        telegramCard(ctx, telegram, code, (given) => ((code = given), refresh()), refresh),
        slackCard(ctx, slack, manifest, slackCode, (given) => ((slackCode = given), refresh()), refresh),
      );
    } catch (error) {
      replace(body, callout("danger", errorMessage(error), { title: "Couldn't read the chat apps" }));
    }
  }
  return { el, refresh };
}

function telegramCard(ctx: Ctx, telegram: TelegramView, code: LinkCode | null, connected: (code: LinkCode) => Promise<void>, refresh: () => Promise<void>): HTMLElement {
  const admin = ctx.can("fleet:admin");
  const status = h("div");
  const disconnect = button("Disconnect", {
    size: "sm",
    variant: "ghost",
    icon: "x",
    onClick: async (event) => {
      const ok = await confirmAction({ title: "Disconnect Telegram?", body: "Its device is revoked and the bot's token deleted. The chats it had stay yours.", confirmLabel: "Disconnect" });
      if (!ok) return;
      await busy(event.currentTarget as HTMLButtonElement, async () => {
        try {
          await ctx.api.post("/api/telegram/disconnect", {});
          toast("Telegram disconnected", { tone: "ok" });
          await refresh();
        } catch (error) {
          replace(status, callout("danger", errorMessage(error)));
        }
      });
    },
  });

  const token = secretInput({ label: "The bot's token", placeholder: "123456789:AA… from @BotFather" });
  const connect = button(telegram.connected ? "New code" : "Connect", { variant: "primary", type: "submit", icon: "chat" });
  const form = h(
    "form",
    {
      class: "row",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        // Read, then cleared at once: the token lives in this page as briefly as possible.
        const value = token.input.value.trim();
        token.input.value = "";
        if (!value) return void token.input.focus();
        void busy(connect, async () => {
          try {
            const done = await ctx.api.post<{ bot: string; code: string; expires: number }>("/api/telegram/connect", { token: value });
            toast(`${done.bot} connected`, { tone: "ok", description: "Send it the message below from your own Telegram account." });
            await connected({ code: done.code, expires: done.expires });
          } catch (error) {
            replace(status, callout("danger", `${errorMessage(error)}. The field was cleared; paste the token again.`));
          }
        });
      },
    },
    h("div", { class: "grow" }, token.wrap),
    connect,
  );

  const head = listRow({
    lead: "chat",
    title: "Telegram",
    sub: telegram.connected ? `${telegram.bot ?? "Your bot"} on ${telegram.node}` : "Not connected",
    meta: telegram.owner ? [h("span", {}, `Answers ${telegram.owner}, and nobody else`)] : [],
  });

  if (!telegram.connected) {
    return card(
      { label: "Telegram" },
      head,
      note("Through a bot of yours: make one with @BotFather (send it /newbot), and paste the token it gives you. Only your own account is answered, as a device of its own that may chat; nothing on your network is opened."),
      admin ? form : callout("quiet", "Connecting needs a device with fleet:admin, or a terminal on a node: galahad telegram connect."),
      status,
    );
  }
  return card(
    { label: "Telegram" },
    head,
    telegram.problem ? callout("warn", telegram.problem) : null,
    !telegram.owner && code && code.expires > Date.now()
      ? h(
          "div",
          { class: "stack tight" },
          note(`From your own Telegram account, send ${telegram.bot ?? "the bot"} this message (it stops working ${relativeTime(code.expires)}):`),
          copyField(`/start ${code.code}`, "Copy the message"),
        )
      : null,
    !telegram.owner && !(code && code.expires > Date.now())
      ? callout("info", telegram.linkExpires ? "Waiting for the code Connect gave. Lost it? Give the token again for a new one." : "No account is linked yet: give the token again for a new code.")
      : null,
    telegram.owner ? note("Your chats from Telegram are kept with your other chats here, and a photo or a text file you send there goes with your message.") : null,
    admin && (!telegram.owner || telegram.problem) ? form : null,
    admin ? h("div", { class: "row" }, disconnect) : null,
    status,
  );
}

function slackCard(ctx: Ctx, slack: SlackView, manifest: unknown, code: LinkCode | null, connected: (code: LinkCode) => Promise<void>, refresh: () => Promise<void>): HTMLElement {
  const admin = ctx.can("fleet:admin");
  const status = h("div");
  const disconnect = button("Disconnect", {
    size: "sm",
    variant: "ghost",
    icon: "x",
    onClick: async (event) => {
      const ok = await confirmAction({ title: "Disconnect Slack?", body: "Its device is revoked and the app's tokens deleted. The chats it had stay yours.", confirmLabel: "Disconnect" });
      if (!ok) return;
      await busy(event.currentTarget as HTMLButtonElement, async () => {
        try {
          await ctx.api.post("/api/slack/disconnect", {});
          toast("Slack disconnected", { tone: "ok" });
          await refresh();
        } catch (error) {
          replace(status, callout("danger", errorMessage(error)));
        }
      });
    },
  });

  const app = secretInput({ label: "The app-level token", placeholder: "App-level token (xapp-…)" });
  const bot = secretInput({ label: "The bot token", placeholder: "Bot token (xoxb-…)" });
  const connect = button(slack.connected ? "New code" : "Connect", { variant: "primary", type: "submit", icon: "chat" });
  const form = h(
    "form",
    {
      class: "stack tight",
      autocomplete: "off",
      onsubmit: (event: Event) => {
        event.preventDefault();
        // Read, then cleared at once: the tokens live in this page as briefly as possible.
        const appToken = app.input.value.trim();
        const botToken = bot.input.value.trim();
        app.input.value = "";
        bot.input.value = "";
        if (!appToken) return void app.input.focus();
        if (!botToken) return void bot.input.focus();
        void busy(connect, async () => {
          try {
            const done = await ctx.api.post<{ bot: string; workspace: string; code: string; expires: number }>("/api/slack/connect", { appToken, botToken });
            toast(`${done.bot} connected in ${done.workspace}`, { tone: "ok", description: "Send it the code below in a direct message from your own Slack account." });
            await connected({ code: done.code, expires: done.expires });
          } catch (error) {
            replace(status, callout("danger", `${errorMessage(error)}. The fields were cleared; paste the tokens again.`));
          }
        });
      },
    },
    app.wrap,
    h("div", { class: "row" }, h("div", { class: "grow" }, bot.wrap), connect),
  );

  const head = listRow({
    lead: "chat",
    title: "Slack",
    sub: slack.connected ? `${slack.bot ?? "Your app"} in ${slack.workspace ?? "your workspace"}, on ${slack.node}` : "Not connected",
    meta: slack.owner ? [h("span", {}, `Answers ${slack.owner}, and nobody else`)] : [],
  });

  if (!slack.connected) {
    return card(
      { label: "Slack" },
      head,
      note("An app of yours answers you in its direct messages. At api.slack.com/apps, make it from the manifest copied here (Create New App → From a manifest) and install it; then paste its app-level token (Basic Information → App-Level Tokens, with connections:write) and its bot token (OAuth & Permissions). Your node opens the connection, so nothing on your network is opened, and only your own account is answered, as a device of its own that may chat."),
      // (Its JSON is long: copied whole, never shown.)
      h("div", { class: "row" }, button("Copy the app's manifest", { size: "sm", icon: "copy", onClick: () => void copyText(JSON.stringify(manifest, null, 2), "Manifest copied") })),
      admin ? form : callout("quiet", "Connecting needs a device with fleet:admin, or a terminal on a node: galahad slack connect."),
      status,
    );
  }
  return card(
    { label: "Slack" },
    head,
    slack.problem ? callout("warn", slack.problem) : null,
    !slack.owner && code && code.expires > Date.now()
      ? h(
          "div",
          { class: "stack tight" },
          note(`From your own Slack account, send ${slack.bot ?? "the app"} this in a direct message (it stops working ${relativeTime(code.expires)}):`),
          copyField(code.code, "Copy the code"),
        )
      : null,
    !slack.owner && !(code && code.expires > Date.now())
      ? callout("info", slack.linkExpires ? "Waiting for the code Connect gave. Lost it? Give the tokens again for a new one." : "No account is linked yet: give the tokens again for a new code.")
      : null,
    slack.owner ? note("Your chats from Slack are kept with your other chats here, and a picture or a text file you share there goes with your message. new, on its own, starts a new one there.") : null,
    admin && (!slack.owner || slack.problem) ? form : null,
    admin ? h("div", { class: "row" }, disconnect) : null,
    status,
  );
}
