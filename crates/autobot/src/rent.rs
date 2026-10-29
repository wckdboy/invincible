//! `rent_gpu_*`: the node's `/v1/rent/*` (spec/rent.md).
//!
//! `start` shows the node's 409 estimate and sends `invincible-confirmed: 1` only after the owner
//! approves that estimate in this conversation. The model has no argument that confirms a rental.
//! Stop does not ask.

use serde_json::{Value, json};

use crate::approval::{Action, Answer, Approver};
use crate::gateway::Gateway;

/// One `rent_gpu_*` call.
#[derive(Clone, Debug)]
pub enum Op {
    Offers { preset: String, hours: f64, regions: Option<String> },
    Start { project: String, preset: String, hours: f64, offer: Option<String>, regions: Option<Vec<String>> },
    Status { id: Option<String> },
    Stop { id: String, force: bool },
}

impl PartialEq for Op {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Offers { preset, hours, regions },
                Self::Offers { preset: preset_b, hours: hours_b, regions: regions_b },
            ) => preset == preset_b && hours.to_bits() == hours_b.to_bits() && regions == regions_b,
            (
                Self::Start { project, preset, hours, offer, regions },
                Self::Start {
                    project: project_b,
                    preset: preset_b,
                    hours: hours_b,
                    offer: offer_b,
                    regions: regions_b,
                },
            ) => {
                project == project_b
                    && preset == preset_b
                    && hours.to_bits() == hours_b.to_bits()
                    && offer == offer_b
                    && regions == regions_b
            }
            (Self::Status { id }, Self::Status { id: id_b }) => id == id_b,
            (Self::Stop { id, force }, Self::Stop { id: id_b, force: force_b }) => id == id_b && force == force_b,
            _ => false,
        }
    }
}

impl Eq for Op {}

pub async fn run(gateway: &Gateway, op: &Op, approver: &dyn Approver) -> String {
    match op {
        Op::Offers { preset, hours, regions } => offers(gateway, preset, *hours, regions.as_deref()).await,
        Op::Start { project, preset, hours, offer, regions } => {
            start(gateway, project, preset, *hours, offer.as_deref(), regions.as_deref(), approver).await
        }
        Op::Status { id } => status(gateway, id.as_deref()).await,
        Op::Stop { id, force } => stop(gateway, id, *force).await,
    }
}

async fn offers(gateway: &Gateway, preset: &str, hours: f64, regions: Option<&str>) -> String {
    let mut path = format!("/rent/offers?preset={}&hours={hours}", query(preset));
    if let Some(regions) = regions.filter(|r| !r.is_empty()) {
        path.push_str(&format!("&require_regions={}", query(regions)));
    }
    exchange(gateway, reqwest::Method::GET, &path, None, false).await
}

async fn status(gateway: &Gateway, id: Option<&str>) -> String {
    let path = match id {
        Some(id) => format!("/rent/sessions/{}", query(id)),
        None => "/rent/sessions".to_owned(),
    };
    exchange(gateway, reqwest::Method::GET, &path, None, false).await
}

async fn stop(gateway: &Gateway, id: &str, force: bool) -> String {
    let path = format!("/rent/sessions/{}/stop", query(id));
    exchange(gateway, reqwest::Method::POST, &path, Some(&json!({"force": force})), false).await
}

/// Quote, show the estimate, and provision only after [approver] says yes.
/// `confirm` is not a parameter: the header is added here, after approval, and nowhere else.
pub async fn start(
    gateway: &Gateway,
    project: &str,
    preset: &str,
    hours: f64,
    offer: Option<&str>,
    regions: Option<&[String]>,
    approver: &dyn Approver,
) -> String {
    let body = start_body(project, preset, hours, offer, regions);
    let (status, preview) = match gateway.rent(reqwest::Method::POST, "/rent/sessions", Some(&body), false).await {
        Ok(response) => response,
        Err(err) => return format!("error: {err}"),
    };
    if status != 409 || preview["error"]["code"] != "confirmation_required" {
        return render(status, &preview);
    }
    let action = Action::Rent { summary: summary(&preview) };
    match approver.approve(&action).await {
        Answer::Once | Answer::Always => {}
        Answer::Deny => {
            return format!("refused: the owner did not approve this ({})", action.describe());
        }
        Answer::Instead(text) => {
            let text = text.trim();
            return if text.is_empty() {
                format!("refused: the owner did not approve this ({})", action.describe())
            } else {
                format!(
                    "refused: the owner did not approve this ({action}). Do this instead: {text}",
                    action = action.describe()
                )
            };
        }
    }
    let mut confirmed = body.clone();
    if let Some(id) = preview["offer"]["id"].as_str().map(str::trim).filter(|id| !id.is_empty()) {
        confirmed["offer_id"] = json!(id);
    }
    if let Some(usd) = preview["offer"]["usd_per_hr"].as_f64() {
        confirmed["approved_usd_per_hr"] = json!(usd);
    }
    let (status, created) = match gateway.rent(reqwest::Method::POST, "/rent/sessions", Some(&confirmed), true).await {
        Ok(response) => response,
        Err(err) => return format!("error: {err}"),
    };
    render(status, &created)
}

fn start_body(project: &str, preset: &str, hours: f64, offer: Option<&str>, regions: Option<&[String]>) -> Value {
    let mut body = json!({"project_id": project, "preset_id": preset, "hours": hours});
    if let Some(offer) = offer.filter(|id| !id.trim().is_empty()) {
        body["offer_id"] = json!(offer);
    }
    if let Some(regions) = regions.filter(|regions| !regions.is_empty()) {
        body["require_regions"] = json!(regions);
    }
    body
}

fn summary(preview: &Value) -> String {
    let offer = preview["offer"]["id"].as_str().unwrap_or("the ranked offer");
    let usd = preview["offer"]["usd_per_hr"].as_f64();
    let hours = preview["hours"].as_f64();
    let total = preview["cost_estimate_usd"].as_f64();
    let regions = preview["require_regions"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "the node's regions".to_owned());
    match (usd, hours, total) {
        (Some(usd), Some(hours), Some(total)) => {
            format!("rent {offer} in {regions} for {hours} h at ${usd}/h (${total} catalog estimate)")
        }
        _ => format!("rent {offer} in {regions}"),
    }
}

async fn exchange(
    gateway: &Gateway,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    confirm: bool,
) -> String {
    match gateway.rent(method, path, body, confirm).await {
        Ok((status, value)) => render(status, &value),
        Err(err) => format!("error: {err}"),
    }
}

fn render(status: u16, body: &Value) -> String {
    if (200..300).contains(&status) { body.to_string() } else { format!("error ({status}): {body}") }
}

fn query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::approval::{Answer, Approver};
    use crate::config::ApprovalMode;

    struct Record {
        answer: Answer,
        asked: Mutex<Vec<String>>,
        confirmed: Mutex<u32>,
        plain: Mutex<u32>,
    }

    impl Approver for Record {
        fn approve<'a>(
            &'a self,
            action: &'a Action,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Answer> + Send + 'a>> {
            let line = action.describe();
            self.asked.lock().unwrap().push(line);
            let answer = self.answer.clone();
            Box::pin(async move { answer })
        }
    }

    async fn serve(state: Arc<Record>) -> String {
        let app = axum::Router::new()
            .route(
                "/v1/rent/sessions",
                axum::routing::post({
                    let state = Arc::clone(&state);
                    move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                        let state = Arc::clone(&state);
                        async move {
                            let confirmed = headers.get("invincible-confirmed").and_then(|v| v.to_str().ok()) == Some("1");
                            let text = String::from_utf8_lossy(&body);
                            assert!(!text.contains("\"confirm\""), "the tool must not forward a confirm field: {text}");
                            if confirmed {
                                let value: Value = serde_json::from_str(&text).unwrap_or(json!({}));
                                assert_eq!(value["offer_id"], "runpod:community:4090", "the approved offer is pinned: {text}");
                                assert_eq!(value["approved_usd_per_hr"], 0.5, "{text}");
                                *state.confirmed.lock().unwrap() += 1;
                                (axum::http::StatusCode::CREATED, r#"{"id":"sess_1","phase":"ready"}"#.to_owned())
                            } else {
                                *state.plain.lock().unwrap() += 1;
                                (
                                    axum::http::StatusCode::CONFLICT,
                                    r#"{"error":{"code":"confirmation_required","message":"needs confirmation"},"offer":{"id":"runpod:community:4090","usd_per_hr":0.5},"hours":1,"cost_estimate_usd":0.5,"require_regions":["EU"]}"#.to_owned(),
                                )
                            }
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://127.0.0.1:{port}/v1")
    }

    #[tokio::test]
    async fn the_model_cannot_confirm_a_rental_itself() {
        let state = Arc::new(Record {
            answer: Answer::Deny,
            asked: Mutex::new(Vec::new()),
            confirmed: Mutex::new(0),
            plain: Mutex::new(0),
        });
        let url = serve(Arc::clone(&state)).await;
        let gateway = Gateway::new(&url, "token", "auto", true).unwrap();
        let text = start(&gateway, "hailuo", "vllm", 1.0, None, None, state.as_ref()).await;
        assert!(text.starts_with("refused:"), "{text}");
        assert_eq!(*state.plain.lock().unwrap(), 1);
        assert_eq!(*state.confirmed.lock().unwrap(), 0, "a denial must not send invincible-confirmed");
        assert!(state.asked.lock().unwrap()[0].contains("0.5"), "the owner sees the estimate");

        let state = Arc::new(Record {
            answer: Answer::Once,
            asked: Mutex::new(Vec::new()),
            confirmed: Mutex::new(0),
            plain: Mutex::new(0),
        });
        let url = serve(Arc::clone(&state)).await;
        let gateway = Gateway::new(&url, "token", "auto", true).unwrap();
        let text = start(&gateway, "hailuo", "vllm", 1.0, None, None, state.as_ref()).await;
        assert!(text.contains("sess_1"), "{text}");
        assert_eq!(*state.plain.lock().unwrap(), 1);
        assert_eq!(*state.confirmed.lock().unwrap(), 1);

        let trust = crate::approval::check(
            &crate::config::ApprovalConfig { mode: ApprovalMode::Trust, allow: Vec::new() },
            &Action::Rent { summary: "rent something".into() },
        );
        assert!(matches!(trust, crate::approval::Verdict::Ask), "trust mode does not self-confirm a rental");
    }
}
