# Release notes

What a release has to say beyond its commits: what you must do, and by when. The newest first.

## Next

- **A Gemini plan as a seat: Google AI Pro or Ultra, signed in with Google's Antigravity CLI (agy), as T3 Code drives it.**
  - **What changes:** a seat of a new kind, `google-antigravity` (the web's "Add a Gemini plan", `inv seat add gemini`),
    and a harness, Antigravity, that an agent may be given. Its card opens Google's own sign-in page; the code the page
    that follows shows is pasted back once, to agy in the seat's own VM. agy 1.5.18 is pinned in the tools' image, its
    updates off. It runs on its Google sign-in alone: no model of the gateway's speaks its API.
  - **The risk, yours (27 November 2026):** Google's Antigravity terms call reaching it through another tool a breach
    that may get your Antigravity and Gemini CLI accounts suspended. You chose to run it so, as T3 Code does. The same
    terms let Google use what the seat sends (your code, your words, what its tools print) to improve its products and
    models, and let its staff read it; Antigravity's own settings have an opt-out.
  - **Where it is said:** docs/ARCHITECTURE.md, "Seats"; docs/SECURITY.md, "A seat is signed in by its owner".
- **Every device signs for the node it speaks to, by 14 December 2026.**
  - **What changes:** a request's signature now names the node it is for, so one sent to another node is refused
    there. A node learns which node a peer is from the signed log. A device learns it from whoami, which the node
    proves by signing the device's challenge with its key.
  - **What stops working, from 14 December 2026:** a node refuses a request that names no node, but for whoami's.
  - **Before then:** the iPhone, iPad and Mac apps must be on a build that signs this way (TestFlight, and the Mac's
    Sparkle feed), and so must the Android app. Builds from this release on do: each pins its node from the pairing,
    or at the first proof a node gives. The web app, `inv` and the node's Slack and Telegram bridges come with the node,
    and sign this way now.
  - **What you may see:** a page, or an app, that says the node at its address proved to be another means it isn't the
    node that device paired with, and it sends that node nothing more. `inv` there says the node doesn't know it
    (exit 30). If you set your node up anew at that address, pair again.
  - **Where it is said:** docs/SECURITY.md, "Signed requests".
- **From 14 December 2026, a node's signature on the log and on link calls holds Ed25519's strict rule.**
  - **What changes:** an event stamped from then, or a link call made from then, whose key or signature fails the rule
    (a small-order or mixed-order point, or a point not in its one canonical encoding) is refused. What an honest node
    signs always holds it.
  - **What you must do: run this release on every node before 14 December 2026.** A node still on an older release past
    that day checks signatures the old way: it takes a forgery the others refuse, and keeps it, and serves it, after it
    upgrades, so its log no longer agrees with theirs. Then run `invincible doctor` on one of them: it names every
    device whose key fails the rule, and every device enrolled through one, since whoever signed as it may hold those
    (`mind.keys`). Revoke each (`invincible revoke <id>`): from then nothing signed as it counts, and what it signed
    before stays as it was applied. Pair any device of yours among them again. What a log holds from before is judged
    as it always was.
  - **Where it is said:** docs/SECURITY.md, "Held to Ed25519's strict rule".
