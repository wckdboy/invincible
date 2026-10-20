# Egress and the kill switch (v0)

What happens to one outbound request from the node or the app: refused before any DNS lookup or
socket, sent directly, or sent through a SOCKS proxy. It is a pure function, so both
implementations run the same vectors: Invincible's `invincible_policy::egress`, and Autobot's
`NetworkMode.decode`, `RouteResolver.routeForHost` and `KillSwitch.blockReason`.

This is about where a connection may go. Whether a request may go to the cloud at all (private
requests, data policies, asking first) is [routing.md](routing.md).

## Network mode

The node's `[node] network` and the app's global mode, encoded as text:

| Value | Meaning |
|---|---|
| `offline` | Nothing leaves (the kill switch). The default |
| `direct` | Connections go straight out, ignoring proxy environment variables |
| `tor:<host>:<port>` | Through Tor's SOCKS port |
| `socks5:<host>:<port>` | Through that SOCKS5 proxy |

Decoding: the kind is what comes before the first `:`, and must be one of the four exactly (case
matters). `offline` and `direct` take nothing after them (`direct:typo` is a mistake). For `tor` and `socks5`, the port is what comes after the last `:` and must be a number
from 1 to 65535, and the host is what lies between, which must not be blank (an IPv6 address keeps
its brackets: `socks5:[::1]:1080`). Anything else, including an empty value, decodes as `offline`:
a mistake fails closed.

## Loopback

A host is loopback, without any lookup, when, after trimming, lowercasing and removing the
brackets of an IPv6 literal, it is `localhost`, ends in `.localhost`, is an IPv4 address in
`127.0.0.0/8` written as four decimal numbers from 0 to 255 without leading zeros, or is `::1`
(in any spelling). A name such as `127.0.0.1.example.com` or `localhost.example.com` is not
loopback.

Autobot also counts `10.0.2.2`, the Android emulator's alias for the machine it runs on. That is
the app's own exception and is not in the vectors: on a node it is an ordinary private address.

## Decision

Input: the encoded `network`, the request's `scheme` (`http` or `https`) and `host` (as the URL
parser gives it, the host the connection then goes to: a parser that writes `127.1` as
`127.0.0.1` decides on `127.0.0.1`), and
`loopback_when_offline` (whether loopback is allowed while offline: an app setting; the node
passes false, and reaches its own services on this machine, its engines and the agent, without
this check). The first rule that applies decides:

1. Offline: a request that is not to loopback, or to loopback while `loopback_when_offline` is
   false, is blocked, reason `offline`.
2. Cleartext: `http` to a host that is not loopback is blocked, reason `cleartext`.
3. Loopback is always direct, whatever the mode: a proxy cannot reach this machine's loopback.
4. `direct` is direct; `tor` and `socks5` go through their proxy, which resolves the name
   (remote DNS: the host name goes to the proxy, never to a local resolver).

Redirects are decided again, as a new request.

Output, with `mode` the decoded network mode encoded again:

```json
{ "mode": "tor:127.0.0.1:9050", "action": "socks", "proxy": "127.0.0.1:9050" }
{ "mode": "offline", "action": "block", "reason": "offline" }
{ "mode": "direct", "action": "direct" }
```

Autobot also drops a request whose route changed after its HTTP client was built (the client's
proxy is fixed when it is built). That depends on the client's lifetime, not on one request, and
is not in the vectors.
