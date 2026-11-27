# Release notes

What a release has to say beyond its commits: what you must do, and by when. The newest first.

## Next

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
    (a small-order or mixed-order point, or one written two ways) is refused. What an honest node signs always holds it.
  - **What you must do:** nothing. Every node checks the same way from the same moment, so a fleet agrees, and what its
    log holds from before is judged as it always was.
  - **Where it is said:** docs/SECURITY.md, "Held to Ed25519's strict rule".
