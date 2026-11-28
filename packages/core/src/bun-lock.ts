/*
 * bun.lock as the node reads it (the install cache a round of another node's task's gates takes its packages from: sandbox
 * install-cache.ts, agents handed-repo.ts). Python, as both sides run it: `lenient` reads bun.lock's own form, JSON with
 * trailing commas, by dropping each comma before a closing bracket outside a string, and `strict` reads it with no key
 * twice, where two readers (this one and bun) could each take a different one. `where` names the file in what it says.
 */
export const BUN_LOCK_PY = String.raw`def lenient(text):
    out, i, n, quoted = [], 0, len(text), False
    while i < n:
        c = text[i]
        if quoted:
            out.append(c)
            if c == "\\":
                out.append(text[i + 1:i + 2])
                i += 2
                continue
            if c == '"':
                quoted = False
        elif c == '"':
            quoted = True
            out.append(c)
        elif c == ",":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            if j < n and text[j] in "}]":
                i += 1
                continue
            out.append(c)
        else:
            out.append(c)
        i += 1
    return "".join(out)
class Unread(Exception):
    pass
def strict(text, where):
    def once(pairs):
        seen = {}
        for key, value in pairs:
            if key in seen:
                raise Unread(where + " names " + key[:100] + " twice")
            seen[key] = value
        return seen
    try:
        return json.loads(lenient(text), object_pairs_hook=once)
    except ValueError as e:
        raise Unread(where + " can't be read: " + str(e)[:100])
`;
