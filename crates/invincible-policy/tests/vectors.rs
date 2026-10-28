//! Runs the conformance vectors in `spec/vectors/` (spec/README.md). Autobot runs the same files.

use std::path::PathBuf;

use invincible_policy::{EgressInput, LinkInput, PlanInput, RouteInput, decide, decide_egress, decide_link, plan};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct VectorFile {
    spec: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    input: Value,
    expect: Value,
}

fn load(name: &str) -> VectorFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let file: VectorFile = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(file.spec, name);
    assert!(!file.cases.is_empty(), "{name}: no cases");
    file
}

#[test]
fn routing() {
    let file = load("routing");
    let failures: Vec<String> = file
        .cases
        .iter()
        .filter_map(|case| {
            let input: RouteInput = serde_json::from_value(case.input.clone()).expect(&case.name);
            let got = serde_json::to_value(decide(&input)).expect(&case.name);
            (got != case.expect).then(|| format!("{}\n  expected {}\n  got      {}", case.name, case.expect, got))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} routing cases failed:\n{}",
        failures.len(),
        file.cases.len(),
        failures.join("\n")
    );
}

#[test]
fn egress() {
    let file = load("egress");
    let failures: Vec<String> = file
        .cases
        .iter()
        .filter_map(|case| {
            let input: EgressInput = serde_json::from_value(case.input.clone()).expect(&case.name);
            let got = serde_json::to_value(decide_egress(&input)).expect(&case.name);
            (got != case.expect).then(|| format!("{}\n  expected {}\n  got      {}", case.name, case.expect, got))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} egress cases failed:\n{}",
        failures.len(),
        file.cases.len(),
        failures.join("\n")
    );
}

#[test]
fn cluster() {
    let file = load("cluster");
    let failures: Vec<String> = file
        .cases
        .iter()
        .filter_map(|case| {
            let got = match case.input["kind"].as_str() {
                Some("link") => {
                    let input: LinkInput = serde_json::from_value(case.input.clone()).expect(&case.name);
                    serde_json::to_value(decide_link(&input)).expect(&case.name)
                }
                Some("plan") => {
                    let input: PlanInput = serde_json::from_value(case.input.clone()).expect(&case.name);
                    serde_json::to_value(plan(&input)).expect(&case.name)
                }
                other => panic!("{}: unknown kind {other:?}", case.name),
            };
            (got != case.expect).then(|| format!("{}\n  expected {}\n  got      {}", case.name, case.expect, got))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} cluster cases failed:\n{}",
        failures.len(),
        file.cases.len(),
        failures.join("\n")
    );
}
