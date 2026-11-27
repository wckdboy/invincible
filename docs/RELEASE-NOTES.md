# Release notes

What a release has to say beyond its commits: what you must do, and by when. The newest first.

## Next

- **Every device signs for the node it speaks to, by 14 December 2026.**
  - **What changes:** a request's signature now names the node it is for, so one sent to another node is refused
    there. A node learns which node a peer is from the signed log. A device learns it from whoami, which the node
    proves by signing the device's challenge with its key.
  - **What stops working, from 14 December 2026:** a node refuses a request that names no node, but for whoami's.
  - **Before then:** the iPhone, iPad and Mac apps must be on a build that signs this way (TestFlight, and the Mac's
    Sparkle feed), and so must the Android app. The web app and `inv` come with the node.
  - **Where it is said:** docs/SECURITY.md, "Signed requests".
