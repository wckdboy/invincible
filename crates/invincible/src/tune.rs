//! Auto-tune (ARCHITECTURE.md §3): what this machine is, and what a model actually runs at on it.
//!
//! `invincible tune probe` reports the hardware and the engines, without personal data.
//! `invincible tune bench` runs `llama-bench` on one model and keeps the numbers in
//! `$INVINCIBLE_HOME/tune/<model>.json`, which is what the cluster's planner reads as its
//! `measured` table: a faster device takes more layers, and the plan states the rate it predicts.
//! `llama-bench` is the one next to the configured `[engine] llama_server` (where the installer
//! puts llama.cpp, off PATH), else the one on PATH.

use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cluster::{self, Device};

/// What this machine has, for `invincible tune probe`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub at: String,
    pub os: String,
    pub arch: String,
    pub cpu: Option<String>,
    pub cores: usize,
    pub memory_bytes: Option<u64>,
    /// Accelerators llama.cpp can put layers on; empty on a machine without one.
    #[serde(default)]
    pub devices: Vec<Device>,
    /// Whether this llama-server was built with RPC shards (`null`: no server to ask).
    #[serde(default)]
    pub rpc_backend: Option<bool>,
    /// The configured engine as a file, and the `llama-bench` found for it.
    pub llama_server: Option<String>,
    pub llama_bench: Option<String>,
    /// The llama.cpp build of that engine (`b6000 (abc1234)`); `null`: it named none.
    #[serde(default)]
    pub llama_build: Option<String>,
}

impl Probe {
    /// The machine in plain words, as `invincible tune probe` prints it.
    pub fn report(&self) -> String {
        let memory = self.memory_bytes.map_or("unknown".to_owned(), crate::models::gib);
        let devices = if self.devices.is_empty() {
            "none llama.cpp can use".to_owned()
        } else {
            self.devices
                .iter()
                .map(|d| {
                    format!("{}: {} ({} free)", d.name, d.description, crate::models::gib(d.free_mib * 1024 * 1024))
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        format!(
            "machine   {} {} · {} cores · {memory} memory\n\
             cpu       {}\n\
             devices   {devices}\n\
             engines   llama.cpp {} · llama-server {} · llama-bench {} · rpc {}\n\
             probe     {}",
            self.os,
            self.arch,
            self.cores,
            self.cpu.as_deref().unwrap_or("unknown"),
            self.llama_build.as_deref().unwrap_or("build unknown"),
            self.llama_server.as_deref().unwrap_or("not found"),
            self.llama_bench.as_deref().unwrap_or("not found"),
            match self.rpc_backend {
                Some(true) => "supported",
                Some(false) => "not in this build",
                None => "unknown",
            },
            self.at,
        )
    }
}

/// One measurement: this model on this device, alone.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    /// The device it ran on (`MTL0`, `CUDA0`), or `CPU`.
    pub device: String,
    /// Generation rate, tokens/s.
    pub tg_tps: f64,
    /// Prompt-processing rate, tokens/s, when it was measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pp_tps: Option<f64>,
    /// The engine and version that produced it (`llama-bench b11799`).
    pub engine: String,
    pub at: String,
}

/// Every device a model has been measured on, on one machine. A profile is valid only for the
/// hardware it was taken on: [hardware_tag] changes when the machine, its accelerators or its
/// llama.cpp build do, and a profile that no longer matches is ignored rather than trusted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Set {
    pub model: String,
    pub hardware: String,
    pub profiles: Vec<Profile>,
}

impl Probe {
    /// What a profile taken now is valid for ([hardware_tag]).
    pub fn hardware_tag(&self) -> String {
        hardware_tag(
            &machine(&self.os, &self.arch, self.cores, self.memory_bytes),
            &self.devices,
            self.llama_build.as_deref(),
        )
    }
}

fn machine(os: &str, arch: &str, cores: usize, memory_bytes: Option<u64>) -> String {
    format!("{os} {arch} {cores}c {}", memory_bytes.map_or("?".to_owned(), crate::models::gib))
}

/// This machine without its accelerators (`linux x86_64 8c 31.2 GiB`), asking no engine anything.
/// It is what a link measurement is valid for: a link does not change with the GPU or the build.
pub fn machine_now() -> String {
    machine(
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::thread::available_parallelism().map_or(1, |n| n.get()),
        cluster::memory_bytes(),
    )
}

/// What a profile is valid for: the [machine] ([machine_now]), the accelerators llama.cpp
/// reports, each with its model and total memory (free memory moves with what runs), and the
/// llama.cpp [build] (`linux x86_64 16c 62.7 GiB; CUDA0 NVIDIA GeForce RTX 4090 24080 MiB;
/// llama.cpp b6000 (abc1234)`). Another GPU or another build is another tag, so its profiles
/// are not used.
pub fn hardware_tag(machine: &str, devices: &[Device], build: Option<&str>) -> String {
    let devices = if devices.is_empty() {
        "no accelerator".to_owned()
    } else {
        devices
            .iter()
            .map(|d| format!("{} {} {} MiB", d.name, d.description, d.total_mib))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!("{machine}; {devices}; llama.cpp {}", build.unwrap_or("?"))
}

/// The tag a profile taken now would carry, asking [llama_server] for its devices and build.
pub async fn hardware_now(llama_server: &Path) -> String {
    let (devices, build) = tokio::join!(cluster::probe_devices(llama_server), cluster::probe_build(llama_server));
    hardware_tag(&machine_now(), &devices, build.as_deref())
}

/// `$INVINCIBLE_HOME/tune`.
pub fn dir(home: &Path) -> PathBuf {
    home.join("tune")
}

/// Where a model's measurements live. The id is sanitised so it cannot leave the directory.
pub fn set_path(home: &Path, model: &str) -> PathBuf {
    let safe: String = model
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    dir(home).join(format!("{safe}.json"))
}

pub fn load(home: &Path, model: &str) -> Option<Set> {
    let text = std::fs::read_to_string(set_path(home, model)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every model measured on this machine.
pub fn load_all(home: &Path) -> Vec<Set> {
    let mut sets: Vec<Set> = std::fs::read_dir(dir(home))
        .map(|dir| {
            dir.filter_map(|entry| {
                let path = entry.ok()?.path();
                let text = std::fs::read_to_string(&path).ok()?;
                serde_json::from_str::<Set>(&text).ok()
            })
            .collect()
        })
        .unwrap_or_default();
    sets.sort_by(|a, b| a.model.cmp(&b.model));
    sets
}

pub fn save(home: &Path, set: &Set) -> Result<(), String> {
    let path = set_path(home, &set.model);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(set).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("{}: {e}", path.display()))
}

/// Record one device's measurement, replacing an earlier one for the same device and hardware.
pub fn record(home: &Path, model: &str, hardware: &str, profile: Profile) -> Result<Set, String> {
    let mut set = match load(home, model) {
        Some(set) if set.hardware == hardware => set,
        _ => Set { model: model.to_owned(), hardware: hardware.to_owned(), profiles: Vec::new() },
    };
    match set.profiles.iter_mut().find(|p| p.device == profile.device) {
        Some(existing) => *existing = profile,
        None => set.profiles.push(profile),
    }
    save(home, &set)?;
    Ok(set)
}

/// One node's link, as measured from this machine, and when it was measured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MeasuredLink {
    #[serde(flatten)]
    pub link: invincible_policy::LinkSpeed,
    /// RFC 3339. Files written before freshness was per measurement have no timestamp on their
    /// entries: that age is unknown, so the entry is treated as stale, never as fresh.
    #[serde(default)]
    pub at: String,
}

/// What the links to paired nodes cost, measured from this machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Links {
    pub hardware: String,
    #[serde(default)]
    pub links: Vec<MeasuredLink>,
}

pub fn links_path(home: &Path) -> PathBuf {
    dir(home).join("links.json")
}

/// The measured links, each one only if it was measured on this machine and is younger than
/// [max_age_hours]. A link's speed changes with the room, the radio and the cable, so an old
/// number is not used — and metering one peer must not freshen another's measurement.
pub fn load_links(home: &Path, max_age_hours: i64) -> Vec<invincible_policy::LinkSpeed> {
    let Ok(text) = std::fs::read_to_string(links_path(home)) else {
        return Vec::new();
    };
    let Ok(stored) = serde_json::from_str::<Links>(&text) else {
        return Vec::new();
    };
    if stored.hardware != machine_now() {
        return Vec::new();
    }
    stored.links.into_iter().filter(|l| fresh(&l.at, max_age_hours)).map(|l| l.link).collect()
}

/// Whether a measurement taken at [at] (RFC 3339) is younger than [max_age_hours]. An entry with
/// no timestamp predates per-measurement freshness: its age is unknown, so it is not used.
fn fresh(at: &str, max_age_hours: i64) -> bool {
    chrono::DateTime::parse_from_rfc3339(at)
        .is_ok_and(|at| Utc::now().signed_duration_since(at.with_timezone(&Utc)).num_hours() < max_age_hours)
}

/// Keep one link measurement, replacing the one for that node and leaving every other node's
/// timestamp as it was.
pub fn record_link(home: &Path, link: invincible_policy::LinkSpeed) -> Result<(), String> {
    let hardware = machine_now();
    let mut stored =
        match std::fs::read_to_string(links_path(home)).ok().and_then(|t| serde_json::from_str::<Links>(&t).ok()) {
            Some(old) if old.hardware == hardware => old,
            _ => Links { hardware, links: Vec::new() },
        };
    let entry = MeasuredLink { link, at: now() };
    match stored.links.iter_mut().find(|l| l.link.node == entry.link.node) {
        Some(existing) => *existing = entry,
        None => stored.links.push(entry),
    }
    std::fs::create_dir_all(dir(home)).map_err(|e| format!("{}: {e}", dir(home).display()))?;
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    std::fs::write(links_path(home), text + "\n").map_err(|e| e.to_string())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn cpu_name() -> Option<String> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl").args(["-n", "machdep.cpu.brand_string"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        return (!text.is_empty()).then_some(text);
    }
    let text = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    text.lines()
        .find_map(|line| {
            line.strip_prefix("model name").and_then(|rest| rest.split_once(':')).map(|(_, v)| v.trim().to_owned())
        })
        .filter(|name| !name.is_empty())
}

/// What this machine has. [llama_server] is the configured engine (`[engine] llama_server`, a
/// path or a name on PATH); when there is none, the probe reports no devices and no build.
pub async fn probe(llama_server: Option<&Path>) -> Probe {
    let server = llama_server.and_then(cluster::resolve_program);
    let (devices, rpc_backend, llama_build) = match &server {
        Some(server) => tokio::join!(
            cluster::probe_devices(server),
            cluster::probe_rpc_backend(server),
            cluster::probe_build(server)
        ),
        None => (Vec::new(), None, None),
    };
    let llama_bench = cluster::find_beside(llama_server.unwrap_or(Path::new("llama-server")), &["llama-bench"]);
    Probe {
        at: now(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        cpu: cpu_name(),
        cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
        memory_bytes: cluster::memory_bytes(),
        devices,
        rpc_backend,
        llama_server: server.map(|p| p.display().to_string()),
        llama_bench: llama_bench.map(|p| p.display().to_string()),
        llama_build,
    }
}

/// What one `llama-bench` run measured.
#[derive(Clone, Debug, PartialEq)]
pub struct Bench {
    /// Prompt-processing rate, tokens/s, when it was measured.
    pub pp_tps: Option<f64>,
    /// Generation rate, tokens/s.
    pub tg_tps: f64,
    /// The llama.cpp build llama-bench says it is ([cluster::build_tag]).
    pub build: Option<String>,
}

/// The generation and prompt rates in `llama-bench -o json` output, tokens/s, and its build.
pub fn parse_bench(text: &str) -> Result<Bench, String> {
    let rows: Value = serde_json::from_str(text).map_err(|e| format!("llama-bench output is not JSON: {e}"))?;
    let rows = rows.as_array().ok_or("llama-bench output is not a list of runs")?;
    let build = rows.first().and_then(|row| {
        let number = row.get("build_number").and_then(Value::as_u64)?;
        cluster::build_tag(number, row.get("build_commit").and_then(Value::as_str).unwrap_or(""))
    });
    let mut pp = None;
    let mut tg = None;
    for row in rows {
        let avg = row.get("avg_ts").and_then(Value::as_f64).ok_or("a run has no avg_ts")?;
        let generated = row.get("n_gen").and_then(Value::as_u64).unwrap_or(0);
        let prompted = row.get("n_prompt").and_then(Value::as_u64).unwrap_or(0);
        if generated > 0 {
            tg = Some(tg.map_or(avg, |t: f64| t.max(avg)));
        }
        if prompted > 0 && generated == 0 {
            pp = Some(pp.map_or(avg, |p: f64| p.max(avg)));
        }
    }
    let tg = tg.ok_or("no generation run in llama-bench output (pass -n)")?;
    Ok(Bench { pp_tps: pp, tg_tps: tg, build })
}

/// Run `llama-bench` on [model]. The node's own resource controls: one repetition, short runs,
/// so a probe stays a probe. It runs with an engine's environment ([crate::engine::inherited_env]),
/// so it measures what an engine would get.
pub fn bench(program: &Path, model: &Path, device: Option<&str>) -> Result<Bench, String> {
    let mut command = std::process::Command::new(program);
    command.env_clear().envs(crate::engine::inherited_env());
    command.args(["-m"]).arg(model).args(["-p", "512", "-n", "128", "-r", "1", "-ngl", "999", "-o", "json"]);
    if let Some(device) = device {
        command.args(["-dev", device]);
    }
    let out = command.output().map_err(|e| format!("{}: {e}", program.display()))?;
    if !out.status.success() {
        return Err(format!("llama-bench failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    parse_bench(&String::from_utf8_lossy(&out.stdout))
}

/// The measurements for [model] on the devices [devices] names, as the planner takes them. A
/// profile from other hardware is ignored: it says nothing about this machine.
pub fn measured(
    home: &Path,
    model: &str,
    node: &str,
    hardware: &str,
    devices: &[Device],
) -> Vec<invincible_policy::Measurement> {
    let Some(set) = load(home, model) else {
        return Vec::new();
    };
    if set.hardware != hardware {
        return Vec::new();
    }
    set.profiles
        .iter()
        .filter(|p| devices.iter().any(|d| d.name == p.device))
        .map(|p| invincible_policy::Measurement { node: node.to_owned(), device: p.device.clone(), tg_tps: p.tg_tps })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("invincible-tune-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(device: &str, tps: f64) -> Profile {
        Profile {
            device: device.into(),
            tg_tps: tps,
            pp_tps: Some(1_200.0),
            engine: "llama-bench b11799".into(),
            at: "2026-10-22T00:00:00Z".into(),
        }
    }

    #[test]
    fn links_round_trip_and_replace_per_node() {
        let home = temp_dir("links");
        record_link(&home, invincible_policy::LinkSpeed { node: "mini".into(), rtt_ms: 0.4, mib_s: 110.0 }).unwrap();
        record_link(&home, invincible_policy::LinkSpeed { node: "mini".into(), rtt_ms: 0.3, mib_s: 120.0 }).unwrap();
        record_link(&home, invincible_policy::LinkSpeed { node: "box".into(), rtt_ms: 0.2, mib_s: 900.0 }).unwrap();
        let links = load_links(&home, 1);
        assert_eq!(links.len(), 2, "one entry per node");
        assert_eq!(links.iter().find(|l| l.node == "mini").unwrap().mib_s, 120.0);
    }

    #[test]
    fn metering_one_peer_does_not_freshen_another() {
        let home = temp_dir("links-per-link");
        let path = links_path(&home);
        record_link(&home, invincible_policy::LinkSpeed { node: "mini".into(), rtt_ms: 0.4, mib_s: 110.0 }).unwrap();
        // Two hours ago this machine metered mini. Then it metered box, which must not make the
        // mini number look new: freshness belongs to the measurement, not to the file.
        let two_hours_ago = (Utc::now() - chrono::Duration::hours(2)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let mut stored: Links = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        stored.links[0].at = two_hours_ago;
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        record_link(&home, invincible_policy::LinkSpeed { node: "box".into(), rtt_ms: 0.2, mib_s: 900.0 }).unwrap();

        let links = load_links(&home, 1);
        assert_eq!(links.len(), 1, "the hour-old measurement is not this hour's: {links:?}");
        assert_eq!(links[0].node, "box");
        // A day's grace takes both: the old one is old, not gone.
        assert_eq!(load_links(&home, 24).len(), 2);
    }

    #[test]
    fn a_link_file_with_no_per_entry_timestamp_loads_and_is_stale() {
        let home = temp_dir("links-legacy");
        // The shape written before freshness was per measurement: one `at` for the whole file.
        let legacy = format!(
            r#"{{"hardware": {:?}, "at": {:?}, "links": [{{"node": "mini", "rtt_ms": 0.4, "mib_s": 110.0}}]}}"#,
            machine_now(),
            now()
        );
        std::fs::create_dir_all(dir(&home)).unwrap();
        std::fs::write(links_path(&home), legacy.clone()).unwrap();

        let loaded: Links = serde_json::from_str(&legacy).expect("an old file still loads");
        assert_eq!(loaded.links.len(), 1);
        assert_eq!(loaded.links[0].at, "", "no timestamp was recorded for this entry");
        assert!(load_links(&home, 24).is_empty(), "age unknown: not used, however high the ceiling");
    }

    #[test]
    fn a_measurement_from_another_machine_is_not_used() {
        let home = temp_dir("links-hardware");
        record_link(&home, invincible_policy::LinkSpeed { node: "mini".into(), rtt_ms: 0.4, mib_s: 110.0 }).unwrap();
        let path = links_path(&home);
        let mut stored: Links = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        stored.hardware = "some other machine".into();
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        assert!(load_links(&home, 24).is_empty(), "another machine's numbers say nothing about this one");
    }

    #[test]
    fn bench_output_is_read_both_ways() {
        // The shape `llama-bench -o json` prints: one run per prompt/generation pair.
        let text = r#"[
            {"build_commit":"abc1234","build_number":6000,"n_prompt":512,"n_gen":0,"avg_ts":1457.2},
            {"build_commit":"abc1234","build_number":6000,"n_prompt":0,"n_gen":128,"avg_ts":41.7}
        ]"#;
        let bench = parse_bench(text).unwrap();
        assert_eq!(bench.pp_tps, Some(1457.2));
        assert_eq!(bench.tg_tps, 41.7);
        assert_eq!(bench.build.as_deref(), Some("b6000 (abc1234)"), "named as llama-server --version names it");
        let unnamed = r#"[{"n_prompt":0,"n_gen":128,"avg_ts":41.7}]"#;
        assert_eq!(parse_bench(unnamed).unwrap().build, None);
    }

    #[test]
    fn bench_output_without_generation_is_refused() {
        let text = r#"[{"n_prompt":512,"n_gen":0,"avg_ts":1457.2}]"#;
        assert!(parse_bench(text).is_err(), "a prompt-only run says nothing about generation");
        assert!(parse_bench("not json").is_err());
        assert!(parse_bench("[]").is_err());
    }

    #[test]
    fn a_profile_round_trips_and_replaces_per_device() {
        let home = temp_dir("store");
        record(&home, "qwen3-4b", "linux x86_64 8c 16.0 GiB", profile("CUDA0", 40.0)).unwrap();
        let set = record(&home, "qwen3-4b", "linux x86_64 8c 16.0 GiB", profile("CUDA0", 44.5)).unwrap();
        assert_eq!(set.profiles.len(), 1, "one measurement per device");
        assert_eq!(load(&home, "qwen3-4b").unwrap().profiles[0].tg_tps, 44.5);
        assert_eq!(load_all(&home).len(), 1);
    }

    #[test]
    fn a_profile_from_other_hardware_is_ignored() {
        let home = temp_dir("hardware");
        let machine = "linux x86_64 8c 16.0 GiB";
        let build = Some("b6000 (abc1234)");
        let rtx = vec![Device {
            name: "CUDA0".into(),
            description: "NVIDIA GeForce RTX 4090".into(),
            total_mib: 24_564,
            free_mib: 24_000,
        }];
        let here = hardware_tag(machine, &rtx, build);
        record(&home, "m", &here, profile("CUDA0", 40.0)).unwrap();
        assert_eq!(measured(&home, "m", "studio", &here, &rtx).len(), 1);
        // Another machine: more memory.
        assert!(
            measured(&home, "m", "studio", &hardware_tag("linux x86_64 8c 32.0 GiB", &rtx, build), &rtx).is_empty()
        );
        // Another GPU behind the same device name, or the same one with less memory of its own.
        let swapped = vec![Device { description: "NVIDIA GeForce RTX 3090".into(), ..rtx[0].clone() }];
        assert!(measured(&home, "m", "studio", &hardware_tag(machine, &swapped, build), &swapped).is_empty());
        let smaller = vec![Device { total_mib: 12_282, ..rtx[0].clone() }];
        assert!(measured(&home, "m", "studio", &hardware_tag(machine, &smaller, build), &smaller).is_empty());
        // Another llama.cpp build is another engine, and an unknown one is not this one.
        assert!(measured(&home, "m", "studio", &hardware_tag(machine, &rtx, Some("b6001 (def5678)")), &rtx).is_empty());
        assert!(measured(&home, "m", "studio", &hardware_tag(machine, &rtx, None), &rtx).is_empty());
        // Free memory moves with what runs: it is not part of what a profile is valid for.
        let busy = vec![Device { free_mib: 2_000, ..rtx[0].clone() }];
        assert_eq!(hardware_tag(machine, &busy, build), here);
        // A device that is not here cannot be measured here.
        let other = vec![Device { name: "MTL0".into(), description: "M3".into(), total_mib: 24_000, free_mib: 24_000 }];
        assert!(measured(&home, "m", "studio", &here, &other).is_empty());
    }

    #[test]
    fn the_id_cannot_leave_the_tune_dir() {
        let home = Path::new("/home/x/.invincible");
        assert_eq!(set_path(home, "../../etc/passwd"), dir(home).join(".._.._etc_passwd.json"));
    }

    #[tokio::test]
    async fn the_probe_reports_this_machine() {
        let probe = probe(None).await;
        assert!(probe.cores >= 1);
        assert_eq!(probe.os, std::env::consts::OS);
        assert!(probe.devices.is_empty(), "no engine was given, so there are no devices to report");
        assert_eq!(probe.llama_build, None, "nor a build");
        assert!(probe.hardware_tag().starts_with(&machine_now()), "{}", probe.hardware_tag());
        // The report is plain words, not JSON.
        let report = probe.report();
        assert!(report.contains("machine") && report.contains("engines"));
    }
}
