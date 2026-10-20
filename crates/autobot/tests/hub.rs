//! The skills hub against stand-ins for skills.sh, GitHub's API and its raw files: search, the
//! fallback to GitHub, fetching a skill's directory for review, and installing it inert.

use std::sync::{Arc, Mutex};

use autobot::hub::Hub;
use axum::Json;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::json;

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// skills.sh (or, with [down], one that fails), GitHub's API and raw files, all in one.
async fn stand_in(down: bool) -> (Hub, Arc<Mutex<Vec<String>>>) {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let (a, b, c) = (asked.clone(), asked.clone(), asked.clone());
    let app = axum::Router::new()
        .route(
            "/api/search",
            get(move |Query(q): Query<std::collections::HashMap<String, String>>| {
                let asked = a.clone();
                async move {
                    asked.lock().unwrap().push(format!("directory {}", q["q"]));
                    if down {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    Json(json!({ "skills": [
                        { "id": "acme/skills/pdf", "source": "acme/skills", "skillId": "pdf", "name": "pdf", "installs": 900 },
                        { "id": "copy/cat/pdf", "source": "copy/cat", "skillId": "pdf", "name": "pdf", "installs": 3 },
                        { "id": "acme/skills/pdf-forms", "source": "acme/skills", "skillId": "pdf-forms", "name": "pdf-forms", "installs": 50 },
                    ] }))
                    .into_response()
                }
            }),
        )
        .route(
            "/search/repositories",
            get(move |Query(q): Query<std::collections::HashMap<String, String>>| {
                let asked = b.clone();
                async move {
                    asked.lock().unwrap().push(format!("github {}", q["q"]));
                    Json(json!({ "items": [
                        { "full_name": "acme/skills", "name": "skills", "stargazers_count": 42, "description": "Skills for documents" },
                    ] }))
                }
            }),
        )
        .route("/repos/acme/skills/commits/HEAD", get(|| async { Json(json!({ "sha": "abc1234" })) }))
        .route(
            "/repos/acme/skills/git/trees/abc1234",
            get(|| async {
                Json(json!({ "tree": [
                    { "path": "README.md", "type": "blob", "mode": "100644", "size": 10 },
                    { "path": "skills", "type": "tree", "mode": "040000" },
                    { "path": "skills/pdf/SKILL.md", "type": "blob", "mode": "100644", "size": 60 },
                    { "path": "skills/pdf/scripts/fill.py", "type": "blob", "mode": "100755", "size": 20 },
                    { "path": "skills/pdf/.env", "type": "blob", "mode": "100644", "size": 5 },
                    { "path": "skills/pdf-forms/SKILL.md", "type": "blob", "mode": "100644", "size": 30 },
                ] }))
            }),
        )
        .route(
            "/acme/skills/abc1234/{*path}",
            get(move |Path(path): Path<String>| {
                let asked = c.clone();
                async move {
                    asked.lock().unwrap().push(format!("raw {path}"));
                    match path.as_str() {
                        "skills/pdf/SKILL.md" => {
                            "---\nname: pdf\ndescription: Fill and read PDF forms\n---\nRun scripts/fill.py.\n".into_response()
                        }
                        "skills/pdf/scripts/fill.py" => "print('filled')\n".into_response(),
                        _ => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        );
    let url = listen(app).await;
    (Hub::at(reqwest::Client::new(), &url, &url, &url), asked)
}

#[tokio::test]
async fn search_asks_the_directory_and_falls_back_to_github() {
    let (hub, asked) = stand_in(false).await;
    let found = hub.search("pdf forms", 10).await.unwrap();
    assert_eq!(found[0].id, "acme/skills/pdf");
    assert_eq!((found[0].count, found[0].what), (900, "installs"));
    assert_eq!(asked.lock().unwrap()[0], "directory pdf forms");
    let (down, asked) = stand_in(true).await;
    let found = down.search("pdf", 10).await.unwrap();
    assert_eq!(found[0].id, "acme/skills");
    assert_eq!(found[0].what, "stars");
    assert_eq!(asked.lock().unwrap()[1], "github pdf topic:agent-skills");
}

#[tokio::test]
async fn a_skill_is_fetched_for_review_and_installed_without_running_anything() {
    let (hub, asked) = stand_in(false).await;
    let scratch = std::env::temp_dir().join(format!("autobot-hub-it-{}", std::process::id()));
    let home = scratch.join("home");
    std::fs::create_dir_all(&home).unwrap();
    // By name: the most installed skill of exactly that name.
    let fetched = hub.fetch("pdf", &scratch).await.unwrap();
    assert_eq!(fetched.name, "pdf");
    assert_eq!(fetched.url, "https://github.com/acme/skills/tree/abc1234/skills/pdf");
    let files: Vec<(&str, bool)> = fetched.files.iter().map(|(p, _, s)| (p.as_str(), *s)).collect();
    assert_eq!(files, [("SKILL.md", false), ("scripts/fill.py", true)]);
    assert!(fetched.left_out.iter().any(|w| w.starts_with(".env")), "no dot files: {:?}", fetched.left_out);
    let review = autobot::hub::review(&fetched);
    assert!(review.contains("│ Run scripts/fill.py.") && review.contains("script: never run on its own"), "{review}");
    assert!(!asked.lock().unwrap().iter().any(|a| a.contains("pdf-forms")), "only its own directory");
    let (installed, _) = autobot::hub::install(&home, &fetched).unwrap();
    assert_eq!(installed, ["pdf"]);
    let script = home.join("skills/pdf/scripts/fill.py");
    assert_eq!(std::fs::read_to_string(&script).unwrap(), "print('filled')\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&script).unwrap().permissions().mode() & 0o111, 0, "not executable");
    }
    let source = std::fs::read_to_string(home.join("skills/pdf/.source")).unwrap();
    assert!(source.contains("github.com/acme/skills"));
    assert_eq!(autobot::skills::find(&home, "pdf").unwrap().description, "Fill and read PDF forms");
    // The temporary copy goes when it is dropped.
    let dir = fetched.dir.clone();
    drop(fetched);
    assert!(!dir.exists());
    // Again: there is one by that name.
    let again = hub.fetch("acme/skills/pdf", &scratch).await.unwrap();
    let (installed, skipped) = autobot::hub::install(&home, &again).unwrap();
    assert!(installed.is_empty() && skipped[0].contains("already"), "{skipped:?}");
    // A repository of several skills needs one named; an unknown one is said so.
    assert!(hub.fetch("acme/skills", &scratch).await.err().unwrap().contains("acme/skills/pdf-forms"));
    assert!(hub.fetch("acme/skills/nope", &scratch).await.err().unwrap().contains("no skill \"nope\""));
    assert!(hub.fetch("../../etc", &scratch).await.is_err());
    std::fs::remove_dir_all(scratch).unwrap();
}

#[test]
fn install_sources_go_to_the_hub_only_when_they_are_not_paths_or_urls() {
    use autobot::manage::from_hub;
    assert!(from_hub("pdf") && from_hub("acme/skills/pdf"));
    assert!(!from_hub("https://github.com/acme/skills") && !from_hub("git@github.com:acme/skills.git"));
    assert!(!from_hub("./skills/pdf") && !from_hub("~/skills") && !from_hub("/tmp"));
}
