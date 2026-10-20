//! Recall across conversations: `search_sessions` and `/recall`.
//!
//! **The index.** Each conversation (`sessions/<id>.jsonl`, append-only) has a term index beside
//! it, `sessions/.index/<id>.json`: every word of three or more letters in the owner's and the
//! agent's messages (and the summaries), with the lines it is on. A conversation that grew is
//! indexed from where its index ended; one that was rewritten (`/retry`, `/undo`) is indexed
//! again, found by its length and the hash of its last bytes. A search reads the small index
//! files, not the transcripts, and then only the lines it shows. No database: the files are
//! JSON, and deleting `.index` only costs one slower search.
//!
//! **The summary.** For the conversations that match best, a short call to the model (the
//! bot's own, or `[agent] recall_model`, a smaller one) says what each of them holds about the
//! query: decisions, facts, paths, what was left open. On the gateway like any call, so private
//! turns stay on local models, with a receipt. Kept in `sessions/.recall/`, by the hash of the
//! conversation as it was and of the query, so asking again costs nothing until it changes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Read, Seek};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Bytes at the end of a conversation whose hash says it was not rewritten.
const TAIL: u64 = 256;
/// Conversations summarized per recall.
const SUMMARIZED: usize = 3;
/// Characters of a conversation's matching part sent to be summarized.
const EXCERPT: usize = 12_000;
/// Summaries kept in the cache at most (the oldest go first).
const CACHED: usize = 500;

#[derive(Default, Serialize, Deserialize)]
struct Index {
    /// The bytes of the conversation it covers.
    len: u64,
    /// SHA-256 of the last [TAIL] bytes of those.
    tail: String,
    /// The lines it covers.
    lines: usize,
    /// Each word, and the lines it is on (0-based).
    terms: BTreeMap<String, Vec<usize>>,
}

/// The words of [text], lowercased: runs of letters and digits, three to 40 characters.
pub fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| (3..=40).contains(&w.chars().count()))
        .map(str::to_lowercase)
        .collect()
}

/// The text of a line of a conversation that is searched: the owner's and the agent's messages
/// and the summaries; None for tool calls, tool results and the rest.
fn searched(line: &str) -> Option<(String, String)> {
    let message: Value = serde_json::from_str(line).ok()?;
    let content = message["content"].as_str()?;
    let role = if message["autobot"] == "summary" { "summary" } else { message["role"].as_str()? };
    matches!(role, "user" | "assistant" | "summary").then(|| (role.to_owned(), content.to_owned()))
}

fn index_dir(dir: &Path) -> PathBuf {
    dir.join(".index")
}

fn tail_hash(file: &mut std::fs::File, len: u64) -> String {
    let from = len.saturating_sub(TAIL);
    let mut bytes = Vec::new();
    if file.seek(std::io::SeekFrom::Start(from)).is_ok() {
        let _ = file.take(len - from).read_to_end(&mut bytes);
    }
    invincible::token::hex(&Sha256::digest(&bytes))
}

/// The index of the conversation [id] in [dir], brought up to date (and saved) when it changed.
fn index(dir: &Path, id: &str) -> Option<Index> {
    let path = dir.join(format!("{id}.jsonl"));
    let mut file = std::fs::File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    let saved = index_dir(dir).join(format!("{id}.json"));
    let mut index: Index =
        std::fs::read(&saved).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if index.len == len && index.len > 0 && index.tail == tail_hash(&mut file, len) {
        return Some(index);
    }
    // Grown since (the part it covered unchanged), or new, or rewritten: from where it holds.
    let grown = index.len > 0 && index.len < len && index.tail == tail_hash(&mut file, index.len);
    if !grown {
        index = Index::default();
    }
    file.seek(std::io::SeekFrom::Start(index.len)).ok()?;
    let mut reader = std::io::BufReader::new(&mut file);
    let mut read = index.len;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).ok()?;
        // A line still being written is left for next time.
        if n == 0 || !line.ends_with('\n') {
            break;
        }
        read += n as u64;
        if let Some((_, text)) = searched(line.trim_end()) {
            let at = index.lines;
            for word in words(&text).into_iter().collect::<BTreeSet<_>>() {
                index.terms.entry(word).or_default().push(at);
            }
        }
        index.lines += 1;
    }
    drop(reader);
    index.len = read;
    index.tail = tail_hash(&mut file, read);
    if std::fs::create_dir_all(index_dir(dir)).is_ok()
        && let Ok(text) = serde_json::to_vec(&index)
    {
        let _ = invincible::fsutil::replace_private(&saved, &String::from_utf8_lossy(&text));
    }
    Some(index)
}

/// A message that matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub session: String,
    /// How many of the query's words it has.
    pub score: usize,
    /// Its line in the conversation.
    pub line: usize,
    /// `user: …`, about 300 characters around the first word found.
    pub snippet: String,
}

/// The lines [lines] of the conversation [id] in [dir] (those there are), by number.
fn read_lines(dir: &Path, id: &str, lines: &BTreeSet<usize>) -> BTreeMap<usize, String> {
    let Ok(file) = std::fs::File::open(dir.join(format!("{id}.jsonl"))) else { return BTreeMap::new() };
    let last = lines.iter().next_back().copied().unwrap_or(0);
    std::io::BufReader::new(file)
        .lines()
        .take(last + 1)
        .enumerate()
        .filter(|(n, _)| lines.contains(n))
        .filter_map(|(n, l)| Some((n, l.ok()?)))
        .collect()
}

fn snippet(role: &str, content: &str, query: &[String]) -> String {
    let lower = content.to_lowercase();
    let at = query.iter().filter_map(|w| lower.find(w.as_str())).min().unwrap_or(0);
    let start = content.char_indices().map(|(i, _)| i).take_while(|i| *i + 120 <= at).last().unwrap_or(0);
    let start = (0..=start).rev().find(|i| content.is_char_boundary(*i)).unwrap_or(0);
    let text: String = content[start..].chars().take(300).collect();
    format!("{role}: {}", text.replace('\n', " "))
}

/// The messages in the conversations in [dir] (all but [skip]) with the most of [query]'s
/// words (a word also matches the longer words it starts), at most [limit]; newer conversations
/// first among equals.
pub fn search(dir: &Path, query: &str, limit: usize, skip: &str) -> Vec<Hit> {
    let query: Vec<String> = words(query).into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    if query.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<(usize, usize, String, usize)> = Vec::new();
    for (order, (id, _)) in crate::session::list(dir).into_iter().enumerate() {
        if id == skip {
            continue;
        }
        let Some(index) = index(dir, &id) else { continue };
        let mut scores: BTreeMap<usize, usize> = BTreeMap::new();
        for word in &query {
            let mut lines = BTreeSet::new();
            for (_, at) in index.terms.range(word.clone()..).take_while(|(term, _)| term.starts_with(word.as_str())) {
                lines.extend(at.iter().copied());
            }
            for line in lines {
                *scores.entry(line).or_default() += 1;
            }
        }
        found.extend(scores.into_iter().map(|(line, score)| (score, order, id.clone(), line)));
    }
    // Most words first; then newer conversations; then later in a conversation.
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(b.3.cmp(&a.3)));
    found.truncate(limit);
    let mut wanted: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for (_, _, id, line) in &found {
        wanted.entry(id.clone()).or_default().insert(*line);
    }
    let texts: BTreeMap<String, BTreeMap<usize, String>> =
        wanted.iter().map(|(id, lines)| (id.clone(), read_lines(dir, id, lines))).collect();
    found
        .into_iter()
        .filter_map(|(score, _, session, line)| {
            let (role, content) = searched(texts.get(&session)?.get(&line)?)?;
            Some(Hit { snippet: snippet(&role, &content, &query), session, score, line })
        })
        .collect()
}

/// The part of conversation [id] around [lines] (the messages before and after each), as
/// `role: text` lines, at most [EXCERPT] characters.
fn excerpt(dir: &Path, id: &str, lines: &BTreeSet<usize>) -> String {
    let near: BTreeSet<usize> = lines.iter().flat_map(|l| l.saturating_sub(2)..=l + 2).collect();
    let mut out = String::new();
    let mut last = None;
    for (n, line) in read_lines(dir, id, &near) {
        let Some((role, content)) = searched(&line) else { continue };
        if last.is_some_and(|l: usize| n > l + 3) {
            out.push_str("…\n");
        }
        last = Some(n);
        let content: String = content.chars().take(1500).collect();
        out.push_str(&format!("{role}: {content}\n"));
        if out.len() > EXCERPT {
            break;
        }
    }
    out.chars().take(EXCERPT).collect()
}

/// What identifies the conversation [id] as it is now: its length and the hash of its end.
fn fingerprint(dir: &Path, id: &str) -> Option<String> {
    let mut file = std::fs::File::open(dir.join(format!("{id}.jsonl"))).ok()?;
    let len = file.metadata().ok()?.len();
    Some(format!("{len}:{}", tail_hash(&mut file, len)))
}

fn cache_path(dir: &Path, id: &str, query: &str) -> Option<PathBuf> {
    let normal = words(query).into_iter().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(" ");
    let key = format!("{id}\n{}\n{normal}", fingerprint(dir, id)?);
    Some(dir.join(".recall").join(format!("{}.txt", invincible::token::hex(&Sha256::digest(key.as_bytes())))))
}

/// Keeps the cache to [CACHED] summaries, the oldest going first.
fn prune(cache: &Path) {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(cache)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= CACHED {
        return;
    }
    files.sort();
    for (_, path) in &files[..files.len() - CACHED] {
        let _ = std::fs::remove_file(path);
    }
}

/// When the conversation [id] last changed, for people: `2026-10-18`.
fn day(dir: &Path, id: &str) -> String {
    std::fs::metadata(dir.join(format!("{id}.jsonl")))
        .and_then(|m| m.modified())
        .ok()
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The plain result: the matching messages, one per line.
pub fn plain(hits: &[Hit]) -> String {
    if hits.is_empty() {
        return "nothing found".to_owned();
    }
    hits.iter().map(|h| format!("[{}] {}", h.session, h.snippet)).collect::<Vec<_>>().join("\n")
}

/// Recalls what the earlier conversations in [dir] (all but [skip]) hold about [query]: for
/// the best few, a summary by [agent]'s model (cached), then the messages that matched.
pub async fn recall(
    agent: &crate::agent::Agent,
    dir: &Path,
    query: &str,
    skip: &str,
    events: &(dyn Fn(crate::agent::Event) + Send + Sync),
) -> String {
    let hits = {
        let (dir, query, skip) = (dir.to_owned(), query.to_owned(), skip.to_owned());
        tokio::task::spawn_blocking(move || search(&dir, &query, 40, &skip)).await.unwrap_or_default()
    };
    if hits.is_empty() {
        return "nothing found".to_owned();
    }
    // The conversations in the order of their best match.
    let mut sessions: Vec<String> = Vec::new();
    for hit in &hits {
        if !sessions.contains(&hit.session) {
            sessions.push(hit.session.clone());
        }
    }
    let gateway = match agent.options.recall_model.as_deref() {
        Some("off") => None,
        Some(model) => Some(agent.gateway.with_model(model)),
        None => Some(agent.gateway.clone()),
    };
    let mut out = String::new();
    for id in sessions.iter().take(SUMMARIZED) {
        let lines: BTreeSet<usize> = hits.iter().filter(|h| &h.session == id).map(|h| h.line).collect();
        let summary = match &gateway {
            Some(gateway) => summarize(gateway, dir, id, query, &lines, events).await,
            None => None,
        };
        out.push_str(&format!("[{id} · {}]\n", day(dir, id)));
        if let Some(summary) = summary {
            out.push_str(summary.trim());
            out.push('\n');
        }
        for hit in hits.iter().filter(|h| &h.session == id).take(3) {
            out.push_str(&format!("  {}\n", hit.snippet));
        }
        out.push('\n');
    }
    let rest: Vec<&Hit> = hits.iter().filter(|h| !sessions.iter().take(SUMMARIZED).any(|s| *s == h.session)).collect();
    if !rest.is_empty() {
        out.push_str("Also mentioned in:\n");
        for hit in rest.iter().take(5) {
            out.push_str(&format!("  [{}] {}\n", hit.session, hit.snippet));
        }
    }
    out.trim_end().to_owned()
}

/// What conversation [id] says about [query] (from the cache when it did not change); None
/// when the model cannot say (it is down, it needs the owner's confirmation).
async fn summarize(
    gateway: &crate::gateway::Gateway,
    dir: &Path,
    id: &str,
    query: &str,
    lines: &BTreeSet<usize>,
    events: &(dyn Fn(crate::agent::Event) + Send + Sync),
) -> Option<String> {
    let cache = cache_path(dir, id, query)?;
    if let Ok(text) = std::fs::read_to_string(&cache) {
        return Some(text);
    }
    let excerpt = excerpt(dir, id, lines);
    if excerpt.trim().is_empty() {
        return None;
    }
    let ask = [
        json!({ "role": "system", "content": "You help an agent recall an earlier conversation with its owner. From the excerpt, say briefly what it holds about the query: decisions made, facts, names, paths and commands, and what was left open. At most 100 words, plain text, no preamble. If it holds nothing about the query, answer exactly: nothing relevant." }),
        json!({ "role": "user", "content": format!("Query: {query}\n\nExcerpt from conversation {id} ({}):\n{excerpt}", day(dir, id)) }),
    ];
    let reply = match gateway.chat(&ask, &json!([]), false).await {
        Ok(reply) => reply,
        Err(e) => {
            tracing::info!("recall: no summary of {id} ({e})");
            return None;
        }
    };
    if let Some(receipt) = &reply.request_id {
        let decision = reply.decision.as_ref();
        events(crate::agent::Event::Receipt {
            id: receipt,
            model: decision.and_then(|d| d["model"].as_str()),
            tier: decision.and_then(|d| d["tier"].as_str()),
        });
    }
    let text = reply.message["content"].as_str().unwrap_or_default().trim().to_owned();
    if text.is_empty() {
        return None;
    }
    if let Some(parent) = cache.parent()
        && std::fs::create_dir_all(parent).is_ok()
    {
        let _ = invincible::fsutil::replace_private(&cache, &text);
        prune(parent);
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("autobot-recall-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, id: &str, messages: &[(&str, &str)]) {
        let mut text = String::new();
        for (role, content) in messages {
            text.push_str(&json!({ "role": role, "content": content }).to_string());
            text.push('\n');
        }
        std::fs::write(dir.join(format!("{id}.jsonl")), text).unwrap();
    }

    #[test]
    fn words_are_lowercase_runs_of_three_or_more() {
        assert_eq!(words("Deploy the API to fly.io, v2!"), ["deploy", "the", "api", "fly"]);
        assert_eq!(words("Grüße — größer"), ["grüße", "größer"]);
    }

    #[test]
    fn the_index_follows_growth_and_rewrites() {
        let dir = dir("index");
        write(&dir, "a", &[("user", "deploy the staging server"), ("tool", "deploy output"), ("assistant", "done")]);
        let first = index(&dir, "a").unwrap();
        assert_eq!(first.terms["deploy"], [0], "tool results are not searched");
        assert!(dir.join(".index/a.json").is_file());
        // Appended: indexed from where it ended.
        let mut text = std::fs::read_to_string(dir.join("a.jsonl")).unwrap();
        text.push_str(&json!({ "role": "user", "content": "deploy production too" }).to_string());
        text.push('\n');
        // A line being written is not indexed yet.
        text.push_str("{\"role\": \"user\", \"content\": \"half");
        std::fs::write(dir.join("a.jsonl"), &text).unwrap();
        let grown = index(&dir, "a").unwrap();
        assert_eq!(grown.terms["deploy"], [0, 3]);
        assert_eq!(grown.lines, 4);
        assert!(!grown.terms.contains_key("half"));
        // Rewritten (the same length, other words): indexed again.
        write(&dir, "a", &[("user", "rollback the staging server")]);
        let again = index(&dir, "a").unwrap();
        assert!(!again.terms.contains_key("deploy"));
        assert_eq!(again.terms["rollback"], [0]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn search_ranks_by_words_matched_and_skips_the_current_conversation() {
        let dir = dir("search");
        write(&dir, "old", &[("user", "we chose postgres for the billing service"), ("assistant", "noted")]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&dir, "new", &[("user", "billing is slow"), ("assistant", "the billing database is postgres 16")]);
        write(&dir, "here", &[("user", "what database for billing?")]);
        let hits = search(&dir, "Billing database", 10, "here");
        assert_eq!(hits[0].session, "new");
        assert_eq!(hits[0].score, 2);
        assert!(hits[0].snippet.starts_with("assistant: the billing database"), "{:?}", hits[0]);
        assert!(hits.iter().all(|h| h.session != "here"));
        assert!(hits.iter().any(|h| h.session == "old"));
        // A word finds the longer words it starts.
        assert_eq!(search(&dir, "postgre", 10, "")[0].score, 1);
        assert!(search(&dir, "xy", 10, "").is_empty(), "too short");
        assert_eq!(plain(&[]), "nothing found");
        let excerpt = excerpt(&dir, "old", &BTreeSet::from([0]));
        assert!(excerpt.contains("user: we chose postgres") && excerpt.contains("assistant: noted"));
        // The cache key follows the conversation.
        let before = cache_path(&dir, "old", "billing database").unwrap();
        assert_eq!(before, cache_path(&dir, "old", "database  BILLING").unwrap(), "the same words");
        write(&dir, "old", &[("user", "we chose sqlite after all")]);
        assert_ne!(before, cache_path(&dir, "old", "billing database").unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
