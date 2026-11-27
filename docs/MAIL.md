# Mail and Drive

Invincible can read and write your mail in Gmail and in Outlook (Outlook.com and Microsoft 365), and read your Google
Drive, signed in as you. Each signs in through an app you register yourself, once, with Google or Microsoft, so no one
else's app stands between you and your mail. The vault keeps the app and your sign-in sealed, and they never leave your
nodes. No agent and no model sees either (`packages/models/src/oauth.ts`).

| Who | Can | Can't |
|---|---|---|
| **You** (a paired device, or a terminal on a node) | Install them, seal the app you registered, sign in and out, and let an agent use them. A tool you call yourself (`invincible connector call gmail.send --arg …`) runs at once, a send too: your asking is the yes | |
| **The primary** | Search, read, draft and archive freely, each call in the ledger. A send or a trash waits for your yes, even one you asked for in chat | See your sign-in or the app's secret: the node puts a short-lived token on each call. Seal an app, or sign in |
| **Your loops** | Call a mail tool (`--call gmail.search`) and wake on new mail (`--wake "gmail <search words>"`). They act as the primary, so a send asks you | Act as you |
| **An agent you allowed** (`invincible connector allow gmail <agent>`) | The same as the primary | The same |
| **Any other agent** | Ask to use it (`connector_request`). The request waits a week in Needs you, where you allow it or dismiss it | Use it: each call is refused until you allow it |

## The tools

Gmail and Outlook have the same six (`packages/node/src/mail.ts`):

| Tool | What it does | Asks you first |
|---|---|---|
| `search` | Messages matching your words (Gmail's own, such as `from:someone@example.test is:unread newer_than:7d`). Without any, the inbox's latest. Ten unless asked for more, at most 25: who, to whom, when, the subject, a snippet, unread or not | no |
| `read` | One message: its headers, its words (its plain text, or its HTML's words, up to 20,000 characters) and what it has attached (Outlook: whether it has attachments) | no |
| `draft` | A draft in your Drafts, unsent, in plain text: a new message, or a reply (`replyTo`) in its thread | no |
| `send` | Sends a message, or a reply in its thread | **yes** |
| `archive` | Out of the inbox (Gmail: into All Mail; Outlook: into Archive); back any time | no |
| `trash` | Into Trash (Gmail keeps it 30 days) or Deleted Items (Outlook) | **yes** |

Google Drive is a connector of its own (`gdrive`), to read. It writes, changes and deletes nothing there:

| Tool | What it does | Asks you first |
|---|---|---|
| `files` | Files anywhere in your Drive and shared drives, by Drive's own search words (`name contains 'Report'`, `fullText contains 'invoice'`) | no |
| `file` | One file or folder by its id: the fields asked for, such as its name, type, folder and link | no |
| `export` | A Google Doc or Slides as text or Markdown, or a Sheet's first sheet as CSV | no |

A send or a trash waits for you in Needs you for a day, and no answer is no. You can change a send's words before your
yes (`invincible action approve <id> --edit body="…"`). A standing order you sign can answer for you
([POLICY.md](POLICY.md)); one for `trash` names one message, and one for `send` names every address it may send to,
in `to` and in `cc`, never a pattern: a send that names anyone else asks
(`invincible order add gmail.send --arg to=someone@example.test --label "Replies to someone"`).

## Private, in the primary's answers

Gmail, Outlook and Drive are private connectors, and so are Home Assistant and Dinero. Each is private by its id,
however you installed it: from before the catalog said so, or from its own server's address, as Dinero is
(`PRIVATE_CONNECTORS` in `packages/models/src/connector-catalog.ts`).
- **The rule.** Once a call to one of them comes back in one of the primary's answers, nothing that could carry what it
  read out of Invincible runs for the rest of that answer: not the web, another connector, a sandbox or another model.
  Nothing that writes into the shared memory or the archive runs either. Only that connector's own tools still run: a
  reply drafted there stays there, and sending it still asks (`chatTools` in `packages/node/src/tools.ts`).
- **Nothing of it in what replicates.** The ledger and the loops' runs replicate to every node of yours.
  - A call's line in the ledger names the tool, the verdict, whether it went or failed and why (a status), and the
    answer's size. It holds no word of the answer and none of the call's arguments.
  - A receipt, and a loop's run that called one, say the same and no more. An order's line names the order, not its words.
  - A call to one is marked private however it was approved: by you, by a standing order of yours, or by your agent's
    own approval.
  - New mail that wakes a loop is recorded as "new Gmail mail" (or Outlook mail), never who wrote or what about.
  - The run it wakes is told who wrote and the first lines, on its own node. What that run says it did isn't recorded.
  - Nor is what it ran. Each command it runs writes a line that says only that it ran one and how it ended. So does a
    tripwire's line that stopped one, and a rule's notice that one ran.
  - Nor what it searched. Its web search's line carries its run and says only that it searched.
  - The node writes no memory of that run and learns no skill from it. What it keeps is labeled as its loop is, not by
    what woke it.
  - Its calls, to any connector, are written as a private connector's are: the tool, how it went, the answer's size.
  - A loop that mail ever woke stays private, as the log says: set again without its mail, or removed, its runs are
    still yours.
- **Your words, only on your devices.** An agent with `mind:read` reads none of a private connector's lines in the
  ledger, not even one written before this. The ledger keeps every line it was given, so the view leaves them out.
  - Nor does it read a line of a loop's run that new mail wakes, or that calls one of them.
  - Nor does it read what such a loop said of its runs, however old: in its runs, its last run, and the lines of while
    you were away. Of a notice it raised, it reads only the title (the loop's label).
  - Nor does it read such a loop's waiting call's words, whichever connector it goes to, nor what its runs kept: that is
    listed on your devices alone.
  - In a waiting call, the agent reads that it waits and where it stands, never its words: a send's recipients, subject
    and words, why it was asked, what came back.
  - Nor does it read an order's label or arguments, the search words of a loop that calls one, what mail a loop watches
    for, the goal of a run that mail woke, or a question its server asks you.
  - A connector once installed private stays private. Removing it, or installing it again without the mark, doesn't make
    its calls' words anyone else's.
  - Only your devices, which hold `fleet:admin`, see them. A chat bridge (Telegram, Slack) doesn't hold it, so it reads
    them as an agent does.
  - The tests are `packages/node/test/private-answers.e2e.test.ts`, `private-answers-2.e2e.test.ts` and
    `private-run.e2e.test.ts`.
- **Someone else's words.** The policy has the primary treat mail as data, never as instructions
  ([POLICY.md](POLICY.md), limit 5).
- **What the rule doesn't cover.**
  - An agent you allowed. Its own tools aren't under the rule, so what it does with what it read is its choice.
  - The run new mail wakes. It is told who wrote and the first lines, and so is the model it runs with.
  - What that run keeps. Its files hold what it wrote there, on the node that keeps them, and their names are in the
    record every node replicates; only your devices list them.
  - Your own words for a loop: its label, what it tells you, the goal you set it. Agents read them as you wrote them.
  - A loop's name. A new loop with the name of one that was private is private too.
  - A waiting send's words. They are in the log every node of yours keeps, since each of your devices must be able to
    show it to you; only your devices read them.
  - A connector you installed under another id. It is private only if its manifest says so (`"private": true`).

## Gmail: register your app with Google

1. In [Google Cloud](https://console.cloud.google.com), make a project (say, "Invincible mail").
2. **APIs & Services → Library**: enable the **Gmail API**, and the **Google Drive API** if you want Drive.
3. **Google Auth Platform** (the OAuth consent screen): get started with an app name ("Invincible") and your address.
   The audience is **External**, or **Internal** on Google Workspace: only your organization's accounts sign in, and
   step 5's warning and its seven days don't apply.
4. **Data access**: add the scopes `https://www.googleapis.com/auth/gmail.modify`, `openid` and `email` (Google lists
   `email` as `.../auth/userinfo.email`). For Drive, add `.../auth/drive.readonly` too.
5. **Audience**: **publish the app** (In production). A sign-in to an app left in Testing ends after seven days. Google
   shows an app it hasn't verified with a warning on its consent page; as its only user, go on through **Advanced**.
6. **Clients → Create client**: a **Web application**, with this **authorized redirect URI**: the address you open
   Invincible at, then `/oauth/callback`, such as `https://node.example.test/oauth/callback`. Gmail's card in
   Connectors shows it exactly. Google returns only to https, or to `http://localhost` on the node's own machine.
7. Copy its **client ID** and **client secret**.

In the app, on Gmail's card in **Connectors**: **Install** (**Add Gmail** in the iPhone, Mac and Android apps), then
**Seal the app** with the two, then **Sign in with Google**. Google's page opens: choose your account, and allow it,
ticking the box it shows. It comes back to your node, whose page says whether you're in. If you left the box unticked,
nothing is kept, and the page says to sign in again and tick it. At a terminal:

```sh
invincible connector add gmail
invincible connector app gmail --client-id <client id>        # the secret is asked for, hidden
invincible connector signin gmail --redirect https://<your node's address>/oauth/callback
```

The redirect is the address of the node the terminal talks to, as your browser reaches it: the sign-in waits there.

**Drive** signs in with the same app. With the Drive API on and its scope added (steps 2 and 4), seal the same client
ID and secret on Drive's card, then sign in to it on its own. At a terminal: `invincible connector add gdrive`,
`invincible connector app gdrive --client-id <client id>`, then `invincible connector signin gdrive --redirect …` as
for Gmail.

## Outlook: register your app with Microsoft

1. In [Microsoft Entra](https://entra.microsoft.com), **App registrations → New registration**: a name
   ("Invincible"), and **Accounts in any organizational directory and personal Microsoft accounts**. No redirect URI.
2. **Authentication → Advanced settings**: **Allow public client flows: Yes**.
3. **API permissions → Add a permission → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `Mail.Send`,
   `User.Read`, `offline_access`, `openid`, `email`, `profile`. A work account's administrator may have to consent to
   them.
4. Copy its **Application (client) ID**.

Registering needs a Microsoft Entra tenant: a work account has one, and a free Azure account gives a personal
Outlook.com address one.

In the app, on Outlook's card: **Install** (**Add Outlook** in the apps), **Seal the app** with the client ID, then
**Sign in with Microsoft**. Open the page it shows ([microsoft.com/devicelogin](https://microsoft.com/devicelogin)),
sign in, and type the code; the card says when you're in. At a terminal: `invincible connector add outlook`,
`invincible connector app outlook --client-id <id>`, then `invincible connector signin outlook`, which shows the code
and waits.

## Signing out, and when a sign-in ends

- **Sign out** on the card (or `invincible connector signout <id>`) forgets the sign-in and keeps the app: sign in
  again any time. It doesn't end the sign-in at Google or Microsoft; remove the app's access in your account there for
  that.
- **A sign-in ends** when you remove the app's access at Google or Microsoft, after seven days for a Google app left in
  Testing, or after months unused. The next call says so ("Gmail's sign-in has ended: sign in again from its card in
  Connectors"). The card still says you're signed in: sign out, then sign in again.
- **Replacing the app** with another client ID (**Replace the app** on the card, or `invincible connector app` again)
  ends the sign-in it had. The same client ID with a new secret keeps it.
- **A sign-in you start** waits ten minutes for Google to come back, and Microsoft's code lasts as long as Microsoft
  says. `invincible connector ls` says where each stands.

How it works, in full: the sign-ins in `packages/node/src/sign-ins.ts`, the connectors as they ship in
`packages/models/src/connector-catalog.ts`, and the approvals and the private-data rule in [SECURITY.md](SECURITY.md)
(*Loops, connectors and approvals*, and *Invincible's chat tools*).
