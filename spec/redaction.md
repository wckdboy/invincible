# Redaction (v1)

Before a request leaves hardware the user owns (a `run` on a `cloud` model, `redact: true` in
[routing.md](routing.md)), personal data in it is replaced with placeholders. The cloud sees
`[EMAIL_1]`, and the answer gets the real value back on the node.

The rules are Autobot's `PiiDetector` and `RedactionVault`, ported pattern for pattern, so the
phone and the node hide the same things: **names, emails, phone numbers, street addresses, card
numbers, IBANs and account numbers**. (Autobot also hides `PRIVATE` memory facts from the user's
vault. Those live only on the phone, so the node has none.)

v0 covered emails, IBANs, cards and phones. v1 adds names, addresses, account numbers and cued
phones, replaces every later occurrence of a known value, and continues numbering after the highest
literal placeholder.

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
| `ACCOUNT` | after a cue (`account`, `acct`, `a/c`, `konto(nummer)`, `routing`, `sort code`, `customer`, `kunden(nummer\|nr)`, `member(ship)`, `policy`, `contract`, `vertrags(nummer\|nr)`, `passport`, `reisepass`, `licen[cs]e`, `driver's license`, `ssn`, `social security`, `tax id`, `steuer-id`, `steuernummer`, `steuer-identifikationsnummer`, `national insurance`, `nino`, `bsn`, `svnr`, `sozialversicherungsnummer`, `personalausweis`, `id card`; case-insensitive), optionally followed by `number`/`num`/`no.`/`nr.`/`#`/`id` and `is`/`:`/`=`/`#`: a code of 4+ digits (letters allowed as Autobot's `ACCOUNT_CUED` defines). A bare four-digit year (`19xx`, `20xx`) is not an account. Also any `\d{3}-\d{2}-\d{4}` (US SSN) | Skipped inside code (cued) or code and links (SSN) |
| `PHONE` (cued) | after `phone`, `tel`, `telephone`, `mobile`, `mob`, `cell`, `cellphone`, `handy`, `telefon`, `telefonnummer`, `whatsapp`, `signal`, `fax`, `call/text/reach me at/on`: `\+?\(?\d[\d ()./\-]{5,20}\d` (7–15 digits) | same checks as the other phones, priority 4 |
| `ADDRESS` | English (`221B Baker Street, Apt 4, London`, with directions, units, city, state and ZIP), German (`Hauptstraße 12a, 10115 Berlin`, `Berliner Straße 5`), French (`12 rue de la Paix, 75002 Paris`), Spanish/Italian/Portuguese (`Calle Mayor 5`, `Via Roma 10`, `Rua Augusta 274`): the five `ADDRESS_PATTERNS` of Autobot's `PiiDetector` | skipped inside code and links |
| `PERSON` (cued) | after an honorific (`Dr. Weber`), a relation (`my sister Hannah`, `meine Schwester Lena`), a naming cue (`named`, `called`, `name is`, `heißt`, `je m'appelle`, …), `I'm`/`I am`/`this is`/`ich bin` (two words, or one listed first name), a greeting at the start of a line (`Hi Lea Wolf,`), or alone on the line after a sign-off (`Best regards,` ⏎ `Xaver Huber`) | Leading honorifics and furniture words are dropped (`Dear Ms Abernathy` → `Abernathy`); a trailing `'s` stays outside; skipped inside code and links |
| `PERSON` (listed) | a capitalised word from Autobot's first-name list, with the surname that follows (particles such as `van der` allowed; not a word from the not-a-name or not-a-surname lists, not all capitals). Ambiguous first names (`Will`, `May`, `Mark`, `Max`, …) count only with a surname | same |

IBAN lengths (SWIFT registry): AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22
CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22
IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30
NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26
UA29 VA22 VG24 XK20.

The word lists (first names, ambiguous first names, not-a-name words, not-a-surname words,
honorifics, particles) are Autobot's, copied verbatim into `crates/invincible/src/redact.rs`.

**Code and links.** Card and phone candidates that overlap code (a fenced block, ```` ``` ```` or
`~~~` to the matching fence or the end, or inline `` `code` ``) or a link
(`(?i)\b(?:https?|ftp|file|wss?)://[^\s<>"'`)\]]+` or `\bwww\.[^\s<>"'`)\]]+`) are skipped, and so are
name, address and SSN candidates. Cued account numbers are skipped only inside code. Emails and
IBANs count everywhere.

Each span is trimmed of leading whitespace and of trailing whitespace and commas.

**Overlaps.** When spans overlap, the most reliable wins: `EMAIL` (0), `IBAN` (1), `CARD` (2),
`ACCOUNT` (3), cued `PHONE` (4), `PHONE` (5), `ADDRESS` (6), cued `PERSON` (7), listed `PERSON` (8).
Ties go to the longer span, then the earlier one.

## Placeholders

A request gets one vault, and its texts are redacted in order: every message's `content` (a string,
or the `text` of each text part) and every tool call's `arguments`. For each text:

1. **Literal placeholders first.** Placeholder-shaped text the user wrote (`[EMAIL_3]`) raises its
   kind's counter to its number, so numbering continues after it. It stands for itself. If it
   already names a value from an earlier text, it gets a placeholder of its own, so the model can
   tell the two apart. Percent-encoded ones (`%5BEMAIL_3%5D`) only raise the counter.
2. **Register what was detected**, in order. A new value gets the next number of its kind,
   `[KIND_N]` counting from 1. Values are compared:
   - emails case-insensitively;
   - IBANs without spaces, in upper case;
   - phones, cards and account numbers with no letters by their digits only (`+49 30 1234567` and
     `+49-30-1234567` are one phone);
   - everything else as written.

   The parts of a full name (words of 3+ characters starting with a capital, not furniture words)
   become candidates. They get a placeholder only when they appear alone: `Hannah Weber` … `Weber`
   gives `[PERSON_1]` … `[PERSON_2]`.
3. **Replace every occurrence of every known value**, including values first seen in earlier texts.
   A value counts only as a whole word (not inside a longer word or number). Names and addresses are
   not replaced inside code or links. Emails match case-insensitively. Numbers of 4+ digits also
   match when written with other spacing or punctuation. Where hits overlap, the earliest and then
   longest wins.

## Restoring

In the answer, every placeholder the vault handed out is replaced with its value. A placeholder the
vault does not know stays as it is, and a percent-encoded placeholder is restored percent-encoded. When streaming, a placeholder can be split across chunks, so a
trailing `[` that may still become a placeholder is held back until the next chunk, or until that
choice finishes.

## Vectors

`vectors/redaction.json`: `input` is one text redacted with a fresh vault, and `expect` holds the
redacted `text` and, in `found`, the number of distinct values per kind (kinds with none are absent).
