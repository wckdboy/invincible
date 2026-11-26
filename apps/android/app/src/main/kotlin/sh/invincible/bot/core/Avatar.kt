package sh.invincible.bot.core

/**
 * What an agent's saved avatar says beyond its mark (core's avatar.ts): a colour chosen for it before the marks (an orb
 * profile, `{ "v": 2, "color": "#rrggbb" }`), which its mark snaps to one of the eight (AgentMark.markOf), and the whole
 * number its handle gives it, which sets its mark's colour and form until a node gives it one, and its slats' phase.
 */
object Avatar {
    private val hex = Regex("^#[0-9a-fA-F]{6}$")

    /** A colour chosen for an agent before the marks (core's isOrbProfile): `v` 2 and a six-digit hex `color`, and nothing else. */
    fun isOrbProfile(profile: Json?): Boolean {
        val f = (profile as? Json.Obj)?.fields ?: return false
        return f.size == 2 && f["v"].double == 2.0 && hex.matches(f["color"].string ?: "")
    }

    /** A whole number for a handle (core's handleSeed): FNV-1a over its UTF-16 code units, unsigned 32-bit. */
    fun handleSeed(id: String): Long {
        var hash = 0x811c9dc5.toInt()
        for (unit in id) hash = (hash xor unit.code) * 0x01000193
        return hash.toLong() and 0xffffffffL
    }
}
