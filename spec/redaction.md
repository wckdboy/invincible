# Redaction (v0)

Before a request leaves hardware the user owns (a `run` on a `cloud` model, `redact: true` in
[routing.md](routing.md)), personal data in it is replaced with placeholders. The cloud sees
`[EMAIL_1]`, and the answer gets the real value back on the node.

v0 is the high-precision subset of Autobot's `PiiDetector`, with the same patterns and checks:
**emails, IBANs, card numbers and phone numbers**. Autobot also finds names, street addresses and
cued account numbers on the phone. Those are not in v0 on the node, so text that passes through a
node to the cloud without passing through Autobot first is redacted less. That gap is tracked, and
v1 closes it.

## What is found

Each rule gives candidate spans. Character classes are ASCII unless they say `\p{…}`
(`\w` = `[A-Za-z0-9_]`, `\d` = `[0-9]`).

| Kind | Pattern | Then |
|---|---|---|
| `EMAIL` | `(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}][\p{L}\p{N}._%+-]*@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,24}(?![\p{L}\p{N}-])` | Skipped when the top-level domain is a file extension (`png jpg jpeg gif svg webp pdf heic ico bmp`), the local part is a service name (`git noreply no-reply donotreply do-not-reply mailer-daemon postmaster`), or the domain is `example.com/.org/.net/.edu`, `example`, a subdomain of one of those, or ends in `.invalid`, `.test` or `.localhost` |
| `IBAN` | `(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,32}` | Cut at the country's IBAN length (counting non-space characters); skipped if the country is unknown, the candidate is shorter, a letter or digit follows the cut, or the ISO 13616 mod-97 check fails |
| `CARD` | `(?<![\w.\-])\d(?:[ \-]?\d){12,18}(?![\w\-]\|\.\d)` | 13–19 digits, the first `2`–`6`, not all the same digit, Luhn check passes |
| `PHONE` | international `(?<![\w+])\+\d{1,3}(?:[ .\-]?\(\d{1,4}\))?(?:[ .\-]?\d{1,5}){2,5}(?![\w]\|[.\-]\d)` (8–15 digits) | for every phone pattern: skipped if it contains a date (`\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b`, `\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b`) or, trimmed, is an IPv4-like `\d{1,3}(?:\.\d{1,3}){3}` or a time `\d{1,2}[:.]\d{2}(?:[:.]\d{2})?` |
| | North American `(?<![\w)])\(\d{3}\) ?\d{3}[ .\-]\d{4}(?![\w]\|[.\-]\d)` and `(?<![\w.\-/])\d{3}([.\-])\d{3}\1\d{4}(?![\w]\|[.\-/]\d)` (10 digits) | |
| | national `(?<![\w.\-+/:])0\d{2,4}(?:[ /\-]\d{2,8}){1,3}(?![\w]\|[.\-/:]\d)` (9–12 digits) and `(?<![\w.\-+/:])0[1-9]\d{8,9}(?![\w]\|[.\-/:]\d)` (10–11 digits) | |

IBAN lengths (SWIFT registry): AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22
CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22
IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30
NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26
UA29 VA22 VG24 XK20.

**Code and links.** Card and phone candidates that overlap code (a fenced block, ```` ``` ```` or
`~~~` to the matching fence or the end, or inline `` `code` ``) or a link
(`(?i)\b(?:https?|ftp|file|wss?)://[^\s<>"'`)\]]+` or `\bwww\.[^\s<>"'`)\]]+`) are skipped. Emails
and IBANs count everywhere.

Each span is trimmed of leading whitespace and of trailing whitespace and commas.

**Overlaps.** When spans overlap, the most reliable wins: `EMAIL` (0), `IBAN` (1), `CARD` (2), `PHONE`
(5). Ties go to the longer span, then the earlier one.

## Placeholders

A request gets one vault. The first time a value is seen it gets the next free number of its kind,
`[KIND_N]` counting from 1, and keeps it everywhere in the request. Values are compared:

- emails case-insensitively;
- phones and cards by their digits only (`+49 30 1234567` and `+49-30-1234567` are one phone);
- IBANs without spaces, in upper case.

Placeholder-shaped text already in the request (`[EMAIL_1]` that the user wrote) keeps its number
reserved, so a real value never shares a placeholder with it.

What is redacted: the `content` of every message (a string, or the `text` of each text part) and the
`arguments` of every tool call.

## Restoring

In the answer, every placeholder the vault handed out is replaced with its value. A placeholder the
vault does not know stays as it is. When streaming, a placeholder can be split across chunks, so a
trailing `[` that may still become a placeholder is held back until the next chunk, or until that
choice finishes.

## Vectors

`vectors/redaction.json`: `input` is one text redacted with a fresh vault, and `expect` holds the
redacted `text` and, in `found`, the number of distinct values per kind (kinds with none are absent).
