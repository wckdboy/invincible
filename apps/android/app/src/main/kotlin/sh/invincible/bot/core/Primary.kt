package sh.invincible.bot.core

/**
 * The primary: the one agent you talk to (docs/ARCHITECTURE.md §1), which plans, remembers and gives the work to the
 * agents. Its handle on the wire is core's TEAM_PRIMARY, a handle no agent can have. Its name is the node's to say, and it
 * is "Invincible" until you name it there (`GET /api/whoami`'s `primaryName`, which a node that names it sends). The app
 * is called Invincible whatever the primary is named: what it says of itself (its notifications, a device's name) says
 * "Invincible". The Apple app's Primary.
 */
object Primary {
    /** Its handle in rooms, tasks, messages and seats (core's TEAM_PRIMARY). */
    const val HANDLE = "primary"

    /** What it is called until the node names it. */
    const val UNNAMED = "Invincible"

    @Volatile private var given: String? = null

    /** What it is called: the node's name for it, else "Invincible". */
    val name: String get() = given ?: UNNAMED

    /** The node's word for it, as `whoami` gave it: a name, or none (null, or nothing but spaces: unnamed). */
    fun named(name: String?) {
        given = name?.trim()?.takeIf { it.isNotEmpty() }?.take(40)
    }
}
