//! `autobot config`, `autobot tools` and `autobot model`: the owner changes a bot's
//! configuration from the command line. Every change is made in the bot's own file
//! (`config.toml` for the default bot, `bots/<name>/bot.toml` for the others) with comments and
//! layout kept, checked by loading the result before it is written, and written whole (a
//! temporary file renamed over the old one). `autobot serve` picks it up within seconds.

use std::path::Path;

use crate::bots::Def;
use crate::config::Config;

/// A dotted key: `agent.max_steps`, `gateway.model`, `mcp.github.command`.
fn parts(key: &str) -> Result<Vec<&str>, String> {
    let parts: Vec<&str> = key.split('.').collect();
    let plain = |p: &&str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if parts.is_empty() || !parts.iter().all(plain) {
        return Err(format!("{key:?}: a dotted key like agent.max_steps or gateway.model"));
    }
    Ok(parts)
}

/// What [text] is as a TOML value: `true`, `24`, `["a", "b"]`, `"quoted"`; anything else is a
/// string (`qwen3`, `ask`).
pub fn value(text: &str) -> toml_edit::Item {
    let trimmed = text.trim();
    match trimmed.parse::<toml_edit::Value>() {
        Ok(mut value) if !trimmed.is_empty() => {
            value.decor_mut().clear();
            toml_edit::Item::Value(value)
        }
        _ => toml_edit::value(text),
    }
}

/// The item at [key] in [doc], if it is set there.
fn lookup<'a>(doc: &'a toml_edit::DocumentMut, key: &[&str]) -> Option<&'a toml_edit::Item> {
    let mut item = doc.as_item();
    for part in key {
        item = item.as_table_like()?.get(part)?;
    }
    Some(item)
}

/// [doc] with [key] set to [item] (tables made as needed), or taken out (`None`); whether
/// anything was there before.
fn edit(doc: &mut toml_edit::DocumentMut, key: &[&str], item: Option<toml_edit::Item>) -> Result<bool, String> {
    let (last, path) = key.split_last().ok_or("an empty key")?;
    let mut table: &mut dyn toml_edit::TableLike = doc.as_table_mut();
    for (i, part) in path.iter().enumerate() {
        if table.get(part).is_none() {
            if item.is_none() {
                return Ok(false);
            }
            let mut new = toml_edit::Table::new();
            // `[mcp.github]` rather than an empty `[mcp]` above it.
            new.set_implicit(true);
            table.insert(part, toml_edit::Item::Table(new));
        }
        let next = table.get_mut(part).expect("just made");
        table = next.as_table_like_mut().ok_or_else(|| format!("{} is not a table", key[..=i].join(".")))?;
    }
    Ok(match item {
        // In place: the comments above the key and after its value stay.
        Some(mut item) => match table.get_mut(last) {
            Some(old) => {
                if let (Some(was), Some(new)) = (old.as_value(), item.as_value_mut()) {
                    *new.decor_mut() = was.decor().clone();
                }
                *old = item;
                true
            }
            None => {
                table.insert(last, item);
                false
            }
        },
        None => table.remove(last).is_some(),
    })
}

/// Checks a bot's file as it would be after a change: it must load (no unknown keys, values of
/// the right kind) and name only tool groups and tools there are.
fn check(def: &Def, text: &str) -> Result<Config, String> {
    let config = if def.default {
        Config::parse(text)?
    } else {
        let main = invincible::fsutil::read_optional(&def.root.join("config.toml"))?.unwrap_or_default();
        crate::bots::merge(&main, text)?
    };
    if let Some(groups) = &config.agent.tools
        && let Some(bad) = groups.iter().find(|g| !crate::tools::GROUPS.iter().any(|(n, _)| n == g))
    {
        return Err(format!("agent.tools: there is no tool group {bad:?} ({})", group_names()));
    }
    if let Some(bad) = config.agent.disabled_tools.iter().find(|t| group_of(t).is_none()) {
        return Err(format!("agent.disabled_tools: there is no tool {bad:?} (`autobot tools` lists them)"));
    }
    config.agent.heartbeat_every()?;
    Ok(config)
}

fn group_names() -> String {
    crate::tools::GROUPS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")
}

/// Changes [key] in [def]'s file to [item] (`None`: takes it out). The new text, checked, is
/// written only when it loads; whether the key was set before.
pub fn change(def: &Def, key: &str, item: Option<toml_edit::Item>) -> Result<bool, String> {
    let key = parts(key)?;
    let file = def.file();
    let text = invincible::fsutil::read_optional(&file)?.unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{}: {e}", file.display()))?;
    let unsetting = item.is_none();
    let was = edit(&mut doc, &key, item)?;
    if unsetting && !was {
        return Ok(false);
    }
    let new = doc.to_string();
    check(def, &new).map_err(|e| format!("not changed: {}", e.trim()))?;
    write(&file, &new)?;
    Ok(was)
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Where [key] is set for [def], and its value as written: in its own file, or (a named bot)
/// inherited from `config.toml`. None when it is not set anywhere (the default applies).
pub fn get(def: &Def, key: &str) -> Result<Option<(String, &'static str)>, String> {
    let key = parts(key)?;
    let shown = |item: &toml_edit::Item| match item.as_str() {
        Some(text) => text.to_owned(),
        None => item.to_string().trim().to_owned(),
    };
    let read = |path: &Path| -> Result<toml_edit::DocumentMut, String> {
        let text = invincible::fsutil::read_optional(path)?.unwrap_or_default();
        text.parse().map_err(|e| format!("{}: {e}", path.display()))
    };
    let own = read(&def.file())?;
    if let Some(item) = lookup(&own, &key) {
        return Ok(Some((shown(item), if def.default { "config.toml" } else { "bot.toml" })));
    }
    if !def.default && crate::bots::inherits(key[0]) {
        let main = read(&def.root.join("config.toml"))?;
        if let Some(item) = lookup(&main, &key) {
            return Ok(Some((shown(item), "config.toml")));
        }
    }
    Ok(None)
}

/// `autobot config [get|set|unset]`.
pub fn config(def: &Def, action: Option<(&str, &str, Option<&str>)>) -> Result<(), String> {
    match action {
        None => {
            let file = def.file();
            println!("{} ({})\n", file.display(), def.name);
            print!("{}", invincible::fsutil::read_optional(&file)?.unwrap_or_default());
            println!(
                "\n`autobot config get|set|unset <key>` with dotted keys: agent.max_steps, gateway.model, approvals.mode"
            );
        }
        Some(("get", key, _)) => match get(def, key)? {
            Some((value, _)) => println!("{value}"),
            None => return Err(format!("{key} is not set (the default applies)")),
        },
        Some(("set", key, Some(text))) => {
            change(def, key, Some(value(text)))?;
            let (now, _) = get(def, key)?.unwrap_or_default();
            println!("{key} = {now}  ({})", def.file().display());
        }
        Some(("unset", key, _)) => {
            if !change(def, key, None)? {
                return Err(format!("{key} is not set in {}", def.file().display()));
            }
            println!("{key} unset; the default applies  ({})", def.file().display());
        }
        Some((other, _, _)) => return Err(format!("{other:?}: get, set or unset")),
    }
    Ok(())
}

/// The group tool [name] is in.
pub fn group_of(name: &str) -> Option<&'static str> {
    crate::tools::GROUPS.iter().find(|(_, tools)| tools.contains(&name)).map(|(g, _)| *g)
}

/// Whether each group, and each tool in it, is on for [config]: (group, on, [(tool, on)]).
pub fn tool_states(config: &Config) -> Vec<(&'static str, bool, Vec<(&'static str, bool)>)> {
    let off = &config.agent.disabled_tools;
    crate::tools::GROUPS
        .iter()
        .map(|(group, tools)| {
            let on = config.agent.tools.as_ref().is_none_or(|groups| groups.iter().any(|g| g == group));
            (*group, on, tools.iter().map(|t| (*t, on && !off.iter().any(|o| o == t))).collect())
        })
        .collect()
}

/// Turns [target] (a group or a tool) on or off for [def]; what changed, in words.
pub fn set_tool(def: &Def, target: &str, on: bool) -> Result<String, String> {
    let all: Vec<String> = crate::tools::GROUPS.iter().map(|(g, _)| (*g).to_owned()).collect();
    let mut groups = def.config.agent.tools.clone().unwrap_or_else(|| all.clone());
    let mut off = def.config.agent.disabled_tools.clone();
    let said;
    if let Some((group, tools)) = crate::tools::GROUPS.iter().find(|(g, _)| *g == target) {
        // A group is all of its tools: the tool-level switches in it go.
        off.retain(|t| !tools.contains(&t.as_str()));
        if on {
            if !groups.iter().any(|g| g == group) {
                groups.push((*group).to_owned());
            }
        } else {
            groups.retain(|g| g != group);
        }
        said = format!("{group} ({}) {}", tools.join(", "), if on { "on" } else { "off" });
    } else if let Some(group) = group_of(target) {
        let group_on = groups.iter().any(|g| g == group);
        if on {
            off.retain(|t| t != target);
            if !group_on {
                // Only this tool of its group comes on.
                groups.push(group.to_owned());
                let (_, tools) = crate::tools::GROUPS.iter().find(|(g, _)| *g == group).expect("its group");
                for t in tools.iter().filter(|t| **t != target) {
                    if !off.iter().any(|o| o == t) {
                        off.push((*t).to_owned());
                    }
                }
            }
            said = format!("{target} on");
        } else {
            if !off.iter().any(|t| t == target) {
                off.push(target.to_owned());
            }
            said = format!("{target} off");
        }
    } else {
        return Err(format!("there is no tool or tool group {target:?} (`autobot tools` lists them)"));
    }
    // In the order of [GROUPS], and no list at all when every group is on.
    groups = all.iter().filter(|g| groups.contains(g)).cloned().collect();
    let groups_item = (groups.len() < all.len()).then(|| list(&groups));
    let off_item = (!off.is_empty()).then(|| list(&off));
    // Both in one write, checked together.
    let file = def.file();
    let text = invincible::fsutil::read_optional(&file)?.unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{}: {e}", file.display()))?;
    edit(&mut doc, &["agent", "tools"], groups_item)?;
    edit(&mut doc, &["agent", "disabled_tools"], off_item)?;
    let config = check(def, &doc.to_string()).map_err(|e| format!("not changed: {}", e.trim()))?;
    // A named bot that inherits these from config.toml: its own file says them outright.
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };
    if sorted(config.agent.tools.clone().unwrap_or_else(|| all.clone())) != sorted(groups.clone()) {
        edit(&mut doc, &["agent", "tools"], Some(list(&groups)))?;
    }
    if sorted(config.agent.disabled_tools.clone()) != sorted(off.clone()) {
        edit(&mut doc, &["agent", "disabled_tools"], Some(list(&off)))?;
    }
    let new = doc.to_string();
    check(def, &new).map_err(|e| format!("not changed: {}", e.trim()))?;
    write(&file, &new)?;
    Ok(said)
}

fn list(items: &[String]) -> toml_edit::Item {
    let mut array = toml_edit::Array::new();
    for item in items {
        array.push(item.as_str());
    }
    toml_edit::value(array)
}

/// `autobot tools`: every group and tool, on or off for [def], and what is missing for some.
pub fn tools_listing(def: &Def) -> String {
    let mut out = format!("tools of {} ({})\n", def.name, def.file().display());
    let ha = def.config.homeassistant.url.is_some();
    let browser = crate::browser::find().is_some();
    for (group, on, tools) in tool_states(&def.config) {
        out.push_str(&format!("\n{} {group}\n", if on { "●" } else { "○" }));
        for (tool, tool_on) in tools {
            let note = match tool {
                "browser" if !browser => "  (no Chrome, Chromium, Edge or Brave here)",
                "browser" if !def.config.agent.browser => "  ([agent] browser = false)",
                "home" if !ha => "  (Home Assistant not set up: `autobot homeassistant setup`)",
                "mcp" if def.config.mcp.is_empty() => "  (no [mcp] servers)",
                "speak" | "generate_image" => "  (needs the node's [[speech]] or [[images]] backend)",
                _ => "",
            };
            out.push_str(&format!("    {} {tool}{note}\n", if tool_on { "on " } else { "off" }));
        }
    }
    out.push_str("\nautobot tools enable|disable <group|tool>   (--bot NAME for another bot)\n");
    out
}

/// `autobot model [id]`: sets [def]'s model to [id], which the gateway must serve (or `auto`);
/// what it says.
pub fn set_model(def: &Def, id: &str, served: Option<&[crate::gateway::ModelInfo]>) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("a model id, or auto".to_owned());
    }
    match served {
        Some(models) if id != "auto" && !models.iter().any(|m| m.id == id) => {
            let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
            return Err(format!("the gateway does not serve {id:?} (it serves: {}, and auto)", ids.join(", ")));
        }
        _ => {}
    }
    change(def, "gateway.model", Some(toml_edit::value(id)))?;
    let cloud = served.and_then(|m| m.iter().find(|m| m.id == id)).is_some_and(|m| m.is_cloud());
    let mut said = format!("model {id} for {} ({})", def.name, def.file().display());
    if cloud && def.config.gateway.private {
        said.push_str(
            "\nit is a cloud model, and turns are private ([gateway] private = true): `autobot config set gateway.private false` lets them leave the machine",
        );
    }
    Ok(said)
}

/// The rows `autobot model` offers: (id, what it is), `auto` last.
pub fn model_rows(models: &[crate::gateway::ModelInfo]) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = models
        .iter()
        .map(|m| {
            let context = m.context.map(|c| format!(" · {}k context", c / 1000)).unwrap_or_default();
            let health = if m.healthy { "" } else { " · unhealthy" };
            (m.id.clone(), format!("{}{context}{health}", m.tier))
        })
        .collect();
    rows.push(("auto".to_owned(), "the gateway's router picks".to_owned()));
    rows
}

/// What the owner typed at `autobot model`'s question: a row number or an id.
pub fn pick(answer: &str, rows: &[(String, String)]) -> Option<String> {
    let answer = answer.trim();
    if let Ok(n) = answer.parse::<usize>() {
        return rows.get(n.checked_sub(1)?).map(|(id, _)| id.clone());
    }
    rows.iter().find(|(id, _)| id == answer).map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("autobot-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn values_are_toml_when_they_parse_and_strings_otherwise() {
        assert_eq!(value("true").as_bool(), Some(true));
        assert_eq!(value("24").as_integer(), Some(24));
        assert_eq!(value("qwen3-4b").as_str(), Some("qwen3-4b"));
        assert_eq!(value("\"true\"").as_str(), Some("true"));
        assert_eq!(value("[\"ls\", \"git status\"]").as_array().map(|a| a.len()), Some(2));
        assert_eq!(value("").as_str(), Some(""));
        assert!(parts("agent..x").is_err() && parts("a b").is_err());
    }

    #[test]
    fn set_get_unset_keep_comments_and_refuse_what_does_not_load() {
        let root = root("config");
        let file = root.join("config.toml");
        std::fs::write(&file, "# my agent\n[gateway]\n# the router picks\nmodel = \"auto\"\n").unwrap();
        let def = crate::bots::load_default(&root).unwrap();
        assert!(change(&def, "gateway.model", Some(value("qwen3"))).unwrap());
        assert!(!change(&def, "agent.max_steps", Some(value("40"))).unwrap());
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# my agent") && text.contains("# the router picks"), "{text}");
        assert!(text.contains("model = \"qwen3\""));
        assert_eq!(get(&def, "agent.max_steps").unwrap(), Some(("40".to_owned(), "config.toml")));
        assert_eq!(get(&def, "gateway.model").unwrap().unwrap().0, "qwen3");
        assert_eq!(get(&def, "agent.timeout").unwrap(), None);
        // Refused, and the file as it was.
        for (key, bad) in [
            ("agent.shell", "\"bash\""),
            ("approvals.mode", "yolo"),
            ("agent.max_steps", "lots"),
            ("agent.tools", "[\"lasers\"]"),
            ("agent.heartbeat", "sometimes"),
        ] {
            assert!(change(&def, key, Some(value(bad))).unwrap_err().starts_with("not changed"), "{key}");
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        assert!(change(&def, "agent.max_steps", None).unwrap());
        assert!(!change(&def, "agent.max_steps", None).unwrap(), "not there any more");
        assert!(!change(&def, "telegram.enabled", None).unwrap());
        // Nested tables are made as needed.
        change(&def, "mcp.files.command", Some(value("npx"))).unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("[mcp.files]\ncommand = \"npx\""));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_named_bot_inherits_and_is_changed_in_its_own_file() {
        let root = root("bot");
        std::fs::write(root.join("config.toml"), "[agent]\nmax_steps = 30\n[telegram]\nenabled = true\n").unwrap();
        crate::bots::add(&root, "ops", &crate::bots::NewBot::default()).unwrap();
        let def = crate::bots::load(&root, "ops").unwrap();
        assert_eq!(get(&def, "agent.max_steps").unwrap(), Some(("30".to_owned(), "config.toml")));
        assert_eq!(get(&def, "telegram.enabled").unwrap(), None, "channels are not inherited");
        change(&def, "agent.max_steps", Some(value("12"))).unwrap();
        assert_eq!(get(&def, "agent.max_steps").unwrap(), Some(("12".to_owned(), "bot.toml")));
        assert!(std::fs::read_to_string(root.join("config.toml")).unwrap().contains("max_steps = 30"));
        // Tools it inherits are changed in its own file, the others' untouched.
        let main = root.join("config.toml");
        std::fs::write(&main, "[agent]\ntools = [\"files-read\"]\ndisabled_tools = [\"search\"]\n").unwrap();
        set_tool(&crate::bots::load(&root, "ops").unwrap(), "files-read", true).unwrap();
        let ops = crate::bots::load(&root, "ops").unwrap();
        assert_eq!(ops.config.agent.tools, Some(vec!["files-read".to_owned()]));
        assert!(ops.config.agent.disabled_tools.is_empty(), "search is on for ops");
        assert!(std::fs::read_to_string(&main).unwrap().contains("disabled_tools = [\"search\"]"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tools_turn_on_and_off_by_group_and_by_tool() {
        let root = root("tools");
        std::fs::write(root.join("config.toml"), "").unwrap();
        let load = || crate::bots::load_default(&root).unwrap();
        let on = |def: &Def, tool: &str| {
            tool_states(&def.config).iter().flat_map(|(_, _, t)| t.clone()).find(|(t, _)| *t == tool).unwrap().1
        };
        assert!(on(&load(), "browser"));
        set_tool(&load(), "browser", false).unwrap();
        assert!(!on(&load(), "browser") && on(&load(), "web_fetch"));
        assert_eq!(load().config.agent.tools, None, "every group still on");
        set_tool(&load(), "terminal", false).unwrap();
        let def = load();
        assert!(!on(&def, "terminal") && !on(&def, "execute_code") && on(&def, "read_file"));
        assert!(!def.config.agent.tools.as_ref().unwrap().contains(&"terminal".to_owned()));
        // One tool of a group that is off: only it comes on.
        set_tool(&load(), "process", true).unwrap();
        let def = load();
        assert!(on(&def, "process") && !on(&def, "terminal") && !on(&def, "execute_code"));
        // The whole group again, and the switches inside it go.
        set_tool(&load(), "terminal", true).unwrap();
        set_tool(&load(), "web", true).unwrap();
        let def = load();
        assert!(on(&def, "terminal") && on(&def, "browser"));
        assert_eq!(def.config.agent.tools, None);
        assert!(def.config.agent.disabled_tools.is_empty());
        assert!(set_tool(&load(), "lasers", true).is_err());
        assert!(tools_listing(&load()).contains("● files-read"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn models_are_picked_by_number_or_id_and_checked_against_the_gateway() {
        let model = |id: &str, tier: &str| crate::gateway::ModelInfo {
            id: id.to_owned(),
            tier: tier.to_owned(),
            context: None,
            healthy: true,
            vision: None,
        };
        let models = vec![model("qwen", "node"), model("claude", "cloud")];
        let rows = model_rows(&models);
        assert_eq!(pick("1", &rows).as_deref(), Some("qwen"));
        assert_eq!(pick("3", &rows).as_deref(), Some("auto"));
        assert_eq!(pick("claude", &rows).as_deref(), Some("claude"));
        assert_eq!(pick("9", &rows), None);
        assert_eq!(pick("0", &rows), None);
        let root = root("model");
        std::fs::write(root.join("config.toml"), "").unwrap();
        let def = crate::bots::load_default(&root).unwrap();
        assert!(set_model(&def, "gpt-9", Some(&models)).is_err());
        assert!(set_model(&def, "claude", Some(&models)).unwrap().contains("private"));
        assert_eq!(get(&def, "gateway.model").unwrap().unwrap().0, "claude");
        set_model(&def, "anything", None).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
