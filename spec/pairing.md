# Pairing (draft)

> **Draft.** Not normative and not implemented. Needs a security review before any code depends on
> it (INV-13). No vectors yet.

How a phone running Autobot and an Invincible node come to trust each other, with no accounts, no
passwords and no third-party relay.

## Keys

Each side has a long-lived X25519 static key for Noise. The node also has an Ed25519 key that signs
receipts ([receipts.md](receipts.md)). Private keys never leave the device that made them; they live
in the OS keychain, a TPM or the Secure Enclave where present.

## Pairing

1. `invincible pair` prints a QR code holding:
   - the node's static public key,
   - its addresses (LAN, WireGuard / Tailscale, onion),
   - a one-time pairing secret (32 random bytes) that expires after 10 minutes or one use.
2. Autobot scans it and opens a `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s` handshake: the phone already
   knows the node's static key from the QR code; the pairing secret is the PSK, so only someone who
   saw the code can complete it.
3. On success both sides pin each other's static key. The node shows the phone's key fingerprint and
   name; the pairing secret is burned.

## Sessions

Later connections use `Noise_IK_25519_ChaChaPoly_BLAKE2s` with the pinned keys. A node refuses any
initiator whose static key is not pinned. The transport carries the node API (to be specified).

## Revocation

- Unpairing on either side deletes the pinned key; the other side's next handshake fails.
- A panic wipe in Autobot deletes the node's key with everything else.
- `invincible devices remove <name>` revokes a phone from the node.

## Open questions

- Key rotation and re-pairing without a fresh QR code.
- Whether the node API inside the Noise channel is HTTP/2 or a framed protocol.
- How the node reaches the phone for results (recipes) when the phone is asleep: polling only, or
  an optional push path that reveals nothing.
