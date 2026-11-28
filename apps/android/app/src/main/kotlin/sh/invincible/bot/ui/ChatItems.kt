package sh.invincible.bot.ui

/*
 * What a chat lists, in order, each by its key. ChatScreen's and Timeline's LazyColumns draw exactly these lists, so every
 * key is made here, and once (ChatItemsTest): a key used twice in one LazyColumn stops the app as it is drawn (Compose
 * throws), as "asks" did on a new chat's welcome, the welcome's suggestions and the asks in the flow (28 November 2026).
 */

/** An item of your agent's chat (ChatScreen). */
sealed class ChatItem(val key: String) {
    data object Reading : ChatItem("reading")
    data object Welcome : ChatItem("welcome")
    data object Suggestions : ChatItem("suggestions")
    data object Recent : ChatItem("recent")
    data object Away : ChatItem("away")
    data class Message(val index: Int) : ChatItem("m:$index")
    data class Steer(val index: Int) : ChatItem("s:$index")
    data object Needs : ChatItem("needs")
    data class Task(val id: String) : ChatItem("u:$id")
    data class Look(val id: String) : ChatItem("l:$id")
    data object Queued : ChatItem("queued")
    data object Notice : ChatItem("notice")
    data object Problem : ChatItem("problem")

    companion object {
        fun of(reading: Boolean, welcome: Boolean, away: Boolean, messages: Int, steers: Int, tasks: List<String>, looks: List<String>, queued: Boolean, notice: Boolean, problem: Boolean): List<ChatItem> = buildList {
            if (reading) add(Reading)
            if (welcome) {
                add(Welcome)
                add(Suggestions)
                add(Recent)
            }
            if (away) add(Away)
            repeat(messages) { add(Message(it)) }
            repeat(steers) { add(Steer(it)) }
            add(Needs)
            tasks.forEach { add(Task(it)) }
            looks.forEach { add(Look(it)) }
            if (queued) add(Queued)
            if (notice) add(Notice)
            if (problem) add(Problem)
        }
    }
}

/** An item of an agent's or a room's chat (AgentScreen's Timeline): its head, a problem, what was said and its tasks by
 * their own keys ("m:<id>", "t:<id>"), then what it asks of you. */
sealed class TimelineItem(val key: String) {
    data object Header : TimelineItem("header")
    data object Problem : TimelineItem("problem")
    data class Entry(val index: Int, val entryKey: String) : TimelineItem(entryKey)
    data object Needs : TimelineItem("needs")

    companion object {
        fun of(entries: List<String>, problem: Boolean, needs: Boolean): List<TimelineItem> = buildList {
            add(Header)
            if (problem) add(Problem)
            entries.forEachIndexed { i, key -> add(Entry(i, key)) }
            if (needs) add(Needs)
        }
    }
}
