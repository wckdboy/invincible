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

A request gets one vault, and its texts are redacted in this order:

1. the `user` field;
2. for each tool that has a `function` (whatever its `type`), the function's `description` and
   every string `description` in its `parameters`, at any depth (a property that is itself called
   `description` is a schema, and is looked into);
3. for each message, its `content` (a string, or the `text` of each text part), its reasoning
   (`reasoning_content`, `reasoning`) and its tool calls' `arguments`.

What stays the same for a whole conversation comes first, so its placeholders keep their numbers
as the conversation grows. Nothing else is redacted: other fields (tool names, `enum` values,
`response_format`) and images leave as they are.

**Tool descriptions** go with every request, and their words are the client's, not the user's. In
them only the rules that guess at no word run: `EMAIL`, `IBAN`, `CARD`, `ACCOUNT` and `PHONE`, not
`ADDRESS` or `PERSON`. So `Create a file called Report`, `My name is Weather Bot` or `Hi Claude,`
makes no value that every later text would then lose. Known values are replaced in them as in any
text (step 3): once the messages are done, each description is redacted again from what it was, so a
value the messages brought (`I am Hannah Weber`) is hidden in it too, and its own values keep the
numbers they got first. A value the first pass hid that the second covers with a longer one
(`Hannah` in `Hannah Weberling`) is then shown nowhere: it is not counted, and its placeholder is
not restored.

**JSON texts.** A tool result (the `content` of a message whose `role` is `tool` or `function`, or
the `text` of each of its parts) and a tool call's `arguments` are often JSON. When such a text
parses as JSON, its literal placeholders are taken first (step 1, over the whole text), then each
string in it, keys included, is redacted as a text of its own in its unescaped form and, where that
changed it, written back as a JSON string (escaped as below); everything else stays byte for byte.
So `"Recipient:\nHauptstraße 12a,\n10115 Berlin"` is read with a line break and `"Hauptstra\u00dfe"`
as `Hauptstraße`, and the text stays JSON. A number is redacted as written (`12345678`), and becomes
a JSON string if that changed it (`"[ACCOUNT_1]"`). A text that does not parse is redacted as a text.

For each text:

1. **Literal placeholders first.** Placeholder-shaped text the user wrote (`[EMAIL_3]`) raises its
   kind's counter to its number, so numbering continues after it. It stands for itself. If it
   already names a value from an earlier text, it gets a placeholder of its own, so the model can
   tell the two apart. Percent-encoded ones (`%5BEMAIL_3%5D`) only raise the counter.
2. **Register what was detected**, in order. Detection reads a JSON escape that stands for
   something other than a letter, digit or `_` (`\n`, `\t`, `\u000a`, not `\\` or `\u00e9`) as
   spaces of the same length, the last one the line break or tab it stands for: in
   `From:\nbob@posteo.de` it finds `bob@posteo.de`, not `nbob@posteo.de`. A span that begins inside
   a `\uXXXX` escape (an email's local part may take the `u` and hex digits of `\u306f`) begins
   after it. A span read across an escape is registered as it is written (`12a,\n10115 Berlin`
   with the backslash and the `n`), so it comes back exactly as it was. A new value gets the next
   number of its kind when it is first replaced (step 3), `[KIND_N]` counting from 1, so the counts
   say what was hidden. Values are compared:
   - emails case-insensitively;
   - IBANs without spaces, in upper case;
   - phones, cards and account numbers with no letters by their digits only (`+49 30 1234567` and
     `+49-30-1234567` are one phone);
   - everything else as written.

   The parts of a full name (words of 3+ characters starting with a capital, not furniture words)
   become candidates. They get a placeholder only when they appear alone: `Hannah Weber` … `Weber`
   gives `[PERSON_1]` … `[PERSON_2]`.

   A span that lies inside a value from an earlier text written escaped for a JSON string (see
   step 3) is part of that value and is not registered.
3. **Replace what was detected where it was found, and every occurrence of every known value**,
   including values first seen in earlier texts. What step 2 detected in this text is replaced
   whatever is next to it. Elsewhere a known value counts only as a whole word: next to it there is
   no digit, `_` or letter of the Latin script; next to a name or an address, which are found by
   their capitals, no letter of any other script with case either (Greek, Cyrillic: `Иван` is not
   replaced in `Ивановка`, nor in `Ивана`); next to a phone, card or account number no ASCII letter,
   digit or `_`, as their patterns read it. A letter of a script without case (Han, kana, Hangul)
   may follow a value without a space (`010-1234-5678으로`, `Annaさん`, `bob@posteo.deまで`) and does not
   make it part of a word. A JSON escape next to a value counts as what it stands for, so `\n`
   before `Hannah` is a line break, `\u00e9` a Latin letter and `\ub85c` (`로`) a letter of a script
   without case, while `\\n` is a backslash and an `n`. Names and addresses are not replaced inside
   code or links, read as detection reads them (a link ends at `\n`). A known value matches as
   it was written, case included (`ANNA BERG` is not `Anna Berg`), but emails match
   case-insensitively, and phone, card and account numbers of 4+ digits also match with their
   digits grouped differently: between two digits at most one space of any width (Unicode `Zs`,
   so also a no-break or narrow no-break space), `-`, `.` or `/`, not two spaces, a tab or a line
   break. The hex digits of a `\uXXXX` escape before such a number are not part of it
   (`\ud63801012345678` is `호` and `01012345678`), but a number it runs on into is
   (`2 4111111111111111` is not the card `4111 1111 1111 1111`). A value is also
   found where it is written escaped for a JSON string, in any text: tool results and tool-call
   arguments are often JSON, and a value given to a tool comes back that way. Escaped means as the
   answer's tool-call arguments are restored (below): `"` as `\"`, `\` as `\\`, `\n`, `\r`, `\t`,
   `\b`, `\f`, any other control character as `\u00xx`, and every other character as it is (so
   where a text is not read as JSON, `ß` written `\u00df` is not matched). Where hits overlap,
   the earliest and then longest wins; a known value that overlaps what was detected in this text
   is replaced only where it covers it.

## Restoring

In the answer, every placeholder the vault handed out is replaced with its value: in each choice's
`content`, `reasoning_content` and `reasoning`, and in its tool calls' `arguments`, where the value
is escaped for a JSON string (so the arguments stay valid JSON). A placeholder the vault does not
know stays as it is, and a percent-encoded placeholder is restored percent-encoded.

When streaming, a placeholder can be split across chunks, so a trailing `[` that may still become a
placeholder is held back until the next piece of the same text, or until that choice finishes. The
content, each reasoning field and each tool call's arguments (by the call's `index`) are held back
separately; what is still held of a tool call when its choice finishes is sent with the finishing
chunk. A tool call without an `index` (a server that sends whole calls) is restored as it comes.

## Vectors

`vectors/redaction.json`: `input` is one text redacted with a fresh vault, and `expect` holds the
redacted `text` and, in `found`, the number of distinct values per kind (kinds with none are absent).
