//! `invincible tune` against stand-in engines: shell scripts that answer as `llama-server` and
//! `llama-bench` do, placed where the installer puts llama.cpp (`~/.invincible/llama.cpp`), next
//! to the configured `[engine] llama_server` and off PATH. No llama.cpp, model or GPU is needed.

#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde_json::Value;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("invincible-tune-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn program(path: &Path, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // Written beside and renamed: a script rewritten in place while the last one is still being
    // read is how "text file busy" happens.
    let next = path.with_extension("next");
    std::fs::write(&next, text).unwrap();
    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&next, path).unwrap();
}

/// A `llama-server` of llama.cpp build [build] with one CUDA device, [gpu].
fn server(dir: &Path, build: u32, gpu: &str) {
    program(
        &dir.join("llama-server"),
        &format!(
            "#!/bin/sh\n\
             case \"$*\" in\n\
             *--version*) echo \"version: {build} (c0ffee{build})\" >&2; echo \"built with cc for x86_64-linux-gnu\" >&2 ;;\n\
             *--list-devices*) echo \"Available devices:\"; echo \"  CUDA0: {gpu} (24000 MiB, 23000 MiB free)\" ;;\n\
             esac\n"
        ),
    );
}

/// A `llama-bench` of llama.cpp build [build] that measures [tps] tokens/s, and keeps the
/// arguments it was given beside itself.
fn bench(dir: &Path, build: u32, tps: f64) {
    program(
        &dir.join("llama-bench"),
        &format!(
            "#!/bin/sh\n\
             echo \"$@\" > \"$0.args\"\n\
             echo '[{{\"build_commit\":\"c0ffee{build}\",\"build_number\":{build},\"n_prompt\":512,\"n_gen\":0,\"avg_ts\":1000.0}},\
             {{\"build_commit\":\"c0ffee{build}\",\"build_number\":{build},\"n_prompt\":0,\"n_gen\":128,\"avg_ts\":{tps}}}]'\n"
        ),
    );
}

/// A node home whose config names [llama_server] and one model, `m`.
fn home(dir: &Path, llama_server: &Path) -> PathBuf {
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let model = dir.join("m.gguf");
    std::fs::write(&model, b"GGUF").unwrap();
    std::fs::write(
        home.join("config.toml"),
        format!(
            "[engine]\nllama_server = {:?}\n\n[[models]]\nid = \"m\"\npath = {:?}\n",
            llama_server.display().to_string(),
            model.display().to_string()
        ),
    )
    .unwrap();
    home
}

/// `invincible` with [home] and a PATH of [path] alone, so a llama.cpp installed on the machine
/// running the test is never the one found.
fn invincible(home: &Path, path: &Path, args: &[&str]) -> (bool, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(args)
        .env("INVINCIBLE_HOME", home)
        .env("HOME", home)
        .env("PATH", path)
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

fn kept(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(home.join("tune/m.json")).unwrap()).unwrap()
}

#[test]
fn the_engines_next_to_the_configured_server_are_found_off_path() {
    let dir = temp("beside");
    let (engines, path) = (dir.join("llama.cpp"), dir.join("bin"));
    std::fs::create_dir_all(&path).unwrap();
    server(&engines, 6000, "NVIDIA GeForce RTX 4090");
    bench(&engines, 6000, 50.0);
    let home = home(&dir, &engines.join("llama-server"));
    let (server_path, bench_path) =
        (engines.join("llama-server").display().to_string(), engines.join("llama-bench").display().to_string());

    let (ok, out) = invincible(&home, &path, &["tune", "probe"]);
    assert!(ok, "{out}");
    assert!(out.contains(&format!("llama-server {server_path}")), "the configured engine, found: {out}");
    assert!(out.contains(&format!("llama-bench {bench_path}")), "the bench beside it, found: {out}");
    assert!(out.contains("llama.cpp b6000 (c0ffee6000)"), "the build is reported: {out}");

    let (ok, out) = invincible(&home, &path, &["tune", "bench", "m"]);
    assert!(ok, "{out}");
    assert!(out.contains(&bench_path), "it says which llama-bench it ran: {out}");
    assert!(out.contains("m on CUDA0: 50.0 tok/s, prompt 1000.0 tok/s"), "{out}");
    let args = std::fs::read_to_string(engines.join("llama-bench.args")).unwrap();
    assert!(args.contains("-dev CUDA0") && args.contains("m.gguf"), "{args}");

    // The profile is valid for this machine, its GPU and this llama.cpp build, and says so.
    let set = kept(&home);
    let hardware = set["hardware"].as_str().unwrap();
    assert!(hardware.contains("CUDA0 NVIDIA GeForce RTX 4090 24000 MiB"), "{hardware}");
    assert!(hardware.contains("llama.cpp b6000 (c0ffee6000)"), "{hardware}");
    assert!(!hardware.contains("23000"), "free memory moves with what runs; it is not the machine: {hardware}");
    assert_eq!(set["profiles"][0]["engine"], "llama-bench b6000 (c0ffee6000)");
    let (ok, out) = invincible(&home, &path, &["tune", "show"]);
    assert!(ok && out.contains("this machine"), "{out}");

    // A llama.cpp upgrade is another engine, and another GPU is another machine: neither trusts
    // the old numbers.
    server(&engines, 6001, "NVIDIA GeForce RTX 4090");
    let (ok, out) = invincible(&home, &path, &["tune", "show"]);
    assert!(ok && out.contains("other hardware, ignored"), "{out}");
    server(&engines, 6000, "NVIDIA GeForce RTX 3090");
    let (ok, out) = invincible(&home, &path, &["tune", "show"]);
    assert!(ok && out.contains("other hardware, ignored"), "{out}");
    server(&engines, 6000, "NVIDIA GeForce RTX 4090");
    let (ok, out) = invincible(&home, &path, &["tune", "show"]);
    assert!(ok && out.contains("this machine"), "the same machine and build again: {out}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_llama_bench_on_path_is_used_only_when_it_is_the_engines_build() {
    let dir = temp("path");
    let (engines, path) = (dir.join("llama.cpp"), dir.join("bin"));
    server(&engines, 6000, "NVIDIA GeForce RTX 4090");
    bench(&path, 5999, 50.0);
    let home = home(&dir, &engines.join("llama-server"));

    // Nothing beside the engine, so PATH is asked; that one is another build, and its numbers
    // would be kept as this engine's.
    let (ok, out) = invincible(&home, &path, &["tune", "bench", "m"]);
    assert!(!ok, "{out}");
    assert!(out.contains("b5999") && out.contains("b6000"), "both builds are named: {out}");
    assert!(!home.join("tune/m.json").exists(), "nothing is kept");

    bench(&path, 6000, 42.0);
    let (ok, out) = invincible(&home, &path, &["tune", "bench", "m"]);
    assert!(ok, "{out}");
    assert!(out.contains(&path.join("llama-bench").display().to_string()), "{out}");
    assert_eq!(kept(&home)["profiles"][0]["tg_tps"], 42.0);

    // One beside the engine wins over the one on PATH.
    bench(&engines, 6000, 50.0);
    let (ok, out) = invincible(&home, &path, &["tune", "bench", "m"]);
    assert!(ok && out.contains(&engines.join("llama-bench").display().to_string()), "{out}");
    assert_eq!(kept(&home)["profiles"][0]["tg_tps"], 50.0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_engine_that_is_not_there_is_named_and_nothing_is_measured() {
    let dir = temp("missing");
    let path = dir.join("bin");
    bench(&path, 6000, 50.0);
    let missing = dir.join("llama.cpp/llama-server");
    let home = home(&dir, &missing);

    let (ok, out) = invincible(&home, &path, &["tune", "probe"]);
    assert!(ok, "a probe is about the machine: {out}");
    assert!(out.contains("llama-server not found"), "{out}");

    let (ok, out) = invincible(&home, &path, &["tune", "bench", "m"]);
    assert!(!ok, "{out}");
    assert!(out.contains(&missing.display().to_string()), "the configured engine is named: {out}");
    assert!(!home.join("tune/m.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
