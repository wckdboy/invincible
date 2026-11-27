# Release notes

What a release has to say beyond its commits: what you must do, and by when. The newest first.

## Next

- **Every device signs for the node it speaks to, by 14 December 2026.**
  - **What changes:** a request's signature now names the node it is for, so one sent to another node is refused
    there. A node learns which node a peer is from the signed log. A device learns it from whoami, which the node
    proves by signing the device's challenge with its key.
  - **What stops working, from 14 December 2026:** a node refuses a request that names no node, but for whoami's.
  - **Before then:** the iPhone, iPad and Mac apps must be on a build that signs this way (TestFlight, and the Mac's
    Sparkle feed), and so must the Android app. The web app, `inv` and the node's Slack and Telegram bridges come with
    the node, and sign this way now.
  - **What you may see:** a page that says the node at its address proved to be another means it isn't the node that
    browser paired with, and the page sends it nothing more. `inv` there says the node doesn't know it (exit 30). If
    you set your node up anew at that address, pair again.
  - **Where it is said:** docs/SECURITY.md, "Signed requests".
