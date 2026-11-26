package sh.invincible.bot.core

/**
 * An agent's orb's colours (core's avatar.ts, held to it by the vectors' `agentOrbs`; your word, 25 November 2026: "drop
 * the agent avatars, and just use custom/procedurally generated colored particle orbs"): the colour you chose for it (an
 * orb profile, `{ "v": 2, "color": "#rrggbb" }`, saved as its avatar), or else one of these 24, picked by its handle, the
 * same on every device. A profile from the drawings (v 1) is still what an older app may have saved, but it colours
 * nothing. Pure, so the JVM's tests hold it to core byte for byte.
 */
object Avatar {
    /** Each OKLCH lightness 0.76 and chroma 0.15 (less where a screen can't show it), every 15 degrees round the hue circle
     * from 10. */
    val AGENT_TINTS: List<String> = listOf(
        "#fe879c", "#ff8a83", "#ff8d65", "#f99549", "#ed9e2f", "#dca81c", "#c8b222", "#afbc3a", "#91c456", "#6eca73", "#41ce90", "#0cceac",
        "#0dcbc3", "#11c8d8", "#04c4ed", "#3abeff", "#6fb6fe", "#8bafff", "#a2a8fe", "#b89ffe", "#ce94f8", "#e08ee5", "#ef89cf", "#fa86b6",
    )

    /** Each tint's name, as a colour picker says it. */
    val AGENT_TINT_NAMES: List<String> = listOf(
        "Rose", "Coral", "Salmon", "Orange", "Amber", "Gold", "Mustard", "Olive", "Lime", "Green", "Jade", "Mint",
        "Teal", "Turquoise", "Cyan", "Sky", "Azure", "Cornflower", "Periwinkle", "Lavender", "Violet", "Orchid", "Pink", "Blush",
    )

    private val hex = Regex("^#[0-9a-fA-F]{6}$")

    /** A colour you chose for an agent's orb (core's isOrbProfile): `v` 2 and a six-digit hex `color`, and nothing else. */
    fun isOrbProfile(profile: Json?): Boolean {
        val f = (profile as? Json.Obj)?.fields ?: return false
        return f.size == 2 && f["v"].double == 2.0 && hex.matches(f["color"].string ?: "")
    }

    /** The colour a saved avatar chose, in lower case; null where it chose none. */
    fun chosen(profile: Json?): String? = if (isOrbProfile(profile)) profile["color"].string!!.lowercase() else null

    /** The avatar saved for a colour you chose. */
    fun orbProfile(color: String): Json = Json.obj("v" to 2, "color" to color.lowercase())

    /**
     * What a colour picker saves as an agent's avatar (the PWA's avatarEditor's value): nothing while it is untouched
     * (null: the avatar is left out, and what is saved stays), the colour you chose, or Json.Null to let it go back to its
     * handle's.
     */
    fun edited(chosen: String?, touched: Boolean): Json? = if (!touched) null else chosen?.let(::orbProfile) ?: Json.Null

    /** A whole number for a handle: FNV-1a over its UTF-16 code units, unsigned 32-bit (OrbMotion.seed, the same). */
    fun handleSeed(id: String): Long = OrbMotion.seed(id)

    /** Each channel [t] of the way from one colour to another (sRGB, as whole numbers: `c + (to - c) * t`, rounded half
     * up as JavaScript's Math.round is), so every app comes to the same colour. */
    fun blendHex(from: String, to: String, t: Double): String {
        fun channel(hex: String, at: Int) = hex.substring(at, at + 2).toInt(16)
        val out = StringBuilder("#")
        for (at in intArrayOf(1, 3, 5)) {
            val c = channel(from, at)
            out.append(java.lang.Long.toHexString(Math.round(c + (channel(to, at) - c) * t)).padStart(2, '0'))
        }
        return out.toString()
    }

    /** Which of the 24 tints is nearest a colour (by the sum of each channel's difference squared; the first, on a tie). */
    fun nearestTint(color: String): Int {
        fun rgb(hex: String) = intArrayOf(hex.substring(1, 3).toInt(16), hex.substring(3, 5).toInt(16), hex.substring(5, 7).toInt(16))
        val (r, g, b) = rgb(color.lowercase())
        var best = 0
        var bestApart = Int.MAX_VALUE
        AGENT_TINTS.forEachIndexed { n, tint ->
            val (tr, tg, tb) = rgb(tint)
            val apart = (r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb)
            if (apart < bestApart) {
                best = n
                bestApart = apart
            }
        }
        return best
    }

    /** An agent's orb's colours: its tint, the tint lit (45 % of the way to white) and in shadow (52 % of the way to
     * black), a second colour a few of its points are (the tint three to six steps on round the circle from its own), and
     * whether you chose its tint. */
    data class AgentColors(val tint: String, val light: String, val deep: String, val second: String, val chosen: Boolean)

    fun agentColors(id: String, profile: Json? = null): AgentColors {
        val seed = handleSeed(id)
        val picked = chosen(profile)
        val at = if (picked != null) nearestTint(picked) else (seed % AGENT_TINTS.size).toInt()
        val tint = picked ?: AGENT_TINTS[at]
        val second = AGENT_TINTS[(at + 3 + ((seed ushr 8) % 4).toInt()) % AGENT_TINTS.size]
        return AgentColors(tint, blendHex(tint, "#ffffff", 0.45), blendHex(tint, "#000000", 0.52), second, picked != null)
    }

    /** A six-digit hex colour as 0xRRGGBB. */
    fun rgb(hex: String): Long = hex.substring(1, 7).toLong(16)
}
