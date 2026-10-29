//! RunPod REST adapter. The API key is a header, never a query parameter, and it is scrubbed from
//! every error this module returns.
//!
//! The catalog and pod calls follow wckd-gpu's adapter (MIT). Copyright (c) 2026 wckdboy.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::provider::{DataCenter, Instance, PodRef, Port, Provider, ProviderError, ProvisionRequest, Query, Quote};
use super::secrets::scrub;

const DEFAULT_ORIGIN: &str = "https://api.runpod.io";

pub struct Client {
    client: reqwest::Client,
    origin: String,
    api_key: String,
    secrets: Vec<String>,
}

impl Client {
    pub fn new(origin: Option<&str>, api_key: String) -> Result<Self, String> {
        Self::build(origin, api_key, Duration::from_secs(10), Duration::from_secs(60))
    }

    fn build(origin: Option<&str>, api_key: String, connect: Duration, timeout: Duration) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(connect)
            .timeout(timeout)
            .build()
            .map_err(|e| format!("runpod client: {e}"))?;
        let origin = origin.map(str::trim).filter(|origin| !origin.is_empty()).unwrap_or(DEFAULT_ORIGIN);
        Ok(Self { client, origin: origin.trim_end_matches('/').to_owned(), secrets: vec![api_key.clone()], api_key })
    }

    fn scrubbed(&self, err: impl std::fmt::Display) -> String {
        scrub(&err.to_string(), &self.secrets)
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, ProviderError> {
        let mut last = ProviderError::Vendor("runpod did not answer".to_owned());
        // Create is not idempotent. A timeout or a 5xx can mean the pod exists and is billing.
        // Retry only GET and DELETE.
        let retry_ok = method == reqwest::Method::GET || method == reqwest::Method::DELETE;
        for attempt in 1..=3 {
            match self.send_once(method.clone(), path, query, body.clone()).await {
                Ok(value) => return Ok(value),
                Err(err) if attempt < 3 && retry_ok && retryable(&err) => {
                    last = err;
                    tokio::time::sleep(std::time::Duration::from_millis(200 * attempt)).await;
                }
                Err(err) => return Err(err),
            }
        }
        Err(last)
    }

    async fn send_once(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, ProviderError> {
        let mut url = format!("{}{path}", self.origin);
        if !query.is_empty() {
            let query = query.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("&");
            url.push('?');
            url.push_str(&query);
        }
        let mut request = self
            .client
            .request(method, &url)
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("accept", "application/json")
            .header("user-agent", "invincible-rent");
        if body.is_some() {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| ProviderError::Vendor(self.scrubbed(e)))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| ProviderError::Vendor(self.scrubbed(e)))?;
        let text = scrub(&String::from_utf8_lossy(&bytes), &self.secrets);
        if !status.is_success() {
            return Err(ProviderError::Vendor(format!("runpod api status {}: {}", status.as_u16(), detail(&text))));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| ProviderError::Vendor(self.scrubbed(format!("decode runpod response: {e}"))))
    }
}

fn retryable(err: &ProviderError) -> bool {
    let ProviderError::Vendor(message) = err;
    message.contains("status 429")
        || message.contains("status 500")
        || message.contains("status 502")
        || message.contains("status 503")
        || message.contains("status 504")
        || !message.contains("status ")
}

fn detail(body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let text = value
        .get("detail")
        .or_else(|| value.get("error"))
        .or_else(|| value.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or(body.trim());
    let mut clipped: String = text.chars().take(300).collect();
    if clipped.is_empty() {
        clipped = "empty body".to_owned();
    }
    clipped
}

impl Provider for Client {
    fn list_quotes<'a>(&'a self, query: &'a Query) -> super::provider::ProviderFut<'a, Vec<Quote>> {
        Box::pin(async move {
            let mut quotes = Vec::new();
            for cloud in clouds_for(query) {
                let body = self
                    .send(
                        reqwest::Method::GET,
                        "/v2/catalog/gpus",
                        &[("include", "AVAILABILITY"), ("product", "POD"), ("count", "1"), ("cloud", cloud)],
                        None,
                    )
                    .await?;
                let gpus: Vec<Gpu> = serde_json::from_value(body.get("gpus").cloned().unwrap_or(Value::Null))
                    .map_err(|e| ProviderError::Vendor(self.scrubbed(format!("decode gpus: {e}"))))?;
                quotes.extend(quotes_from(&gpus, cloud));
            }
            Ok(quotes)
        })
    }

    fn provision<'a>(&'a self, request: &'a ProvisionRequest) -> super::provider::ProviderFut<'a, Instance> {
        Box::pin(async move {
            let mut gpu = json!({ "id": request.gpu_id, "count": 1 });
            if request.min_ram_gb > 0 {
                gpu["minRamPerGpu"] = json!(request.min_ram_gb);
            }
            let mut body = json!({
                "name": request.name,
                "image": request.image,
                "cloud": request.cloud.to_ascii_uppercase(),
                "gpu": gpu,
                "disk": request.disk_gb,
                "ports": request.ports.iter().map(|port| &port.spec).collect::<Vec<_>>(),
                "env": request.env,
                "dataCenterIds": request.data_center_ids,
            });
            // `registry` is the container-registry credential id (OpenAPI ContainerConfig,
            // "Container registry credential ID (for private images)", fetched 2026-10-29).
            if let Some(registry) = request.registry.as_deref().filter(|id| !id.is_empty()) {
                body["registry"] = json!(registry);
            }
            // Do not send `entrypoint` or `dockerStartCmd`. RunPod REST API v2
            // `BaseContainerConfig.entrypoint` is "Container ENTRYPOINT in exec form, overriding
            // the image's own" (https://api.runpod.io/v2/openapi.json, fetched 2026-10-29).
            // The sidecar image's ENTRYPOINT is the bootstrap; the workload is INVINCIBLE_WORKLOAD.
            let _ = &request.entrypoint;
            let value = self.send(reqwest::Method::POST, "/v2/pods", &[], Some(body)).await?;
            let pod: Pod = serde_json::from_value(value)
                .map_err(|e| ProviderError::Vendor(self.scrubbed(format!("decode pod: {e}"))))?;
            if pod.id.is_empty() {
                return Err(ProviderError::Vendor("runpod create pod returned an empty id".to_owned()));
            }
            Ok(pod.instance(&request.ports))
        })
    }

    fn status<'a>(&'a self, id: &'a str) -> super::provider::ProviderFut<'a, Instance> {
        Box::pin(async move {
            let path = format!("/v2/pods/{}", urlencoding_path(id));
            let value = self.send(reqwest::Method::GET, &path, &[], None).await?;
            let pod: Pod = serde_json::from_value(value).map_err(|e| ProviderError::Vendor(self.scrubbed(e)))?;
            Ok(pod.instance(&[]))
        })
    }

    fn terminate<'a>(&'a self, id: &'a str) -> super::provider::ProviderFut<'a, ()> {
        Box::pin(async move {
            let path = format!("/v2/pods/{}", urlencoding_path(id));
            let deleted = self.send(reqwest::Method::DELETE, &path, &[], None).await;
            let missing = match &deleted {
                Err(ProviderError::Vendor(message)) if message.contains("status 404") => true,
                Ok(_) => false,
                Err(err) => return Err(ProviderError::Vendor(err.to_string())),
            };
            match self.send(reqwest::Method::GET, &path, &[], None).await {
                Err(ProviderError::Vendor(message)) if message.contains("status 404") => Ok(()),
                Ok(_) => Err(ProviderError::Vendor(format!(
                    "runpod pod {id} is still present after delete{}",
                    if missing { " (delete was 404)" } else { "" }
                ))),
                Err(err) => Err(err),
            }
        })
    }

    fn list_pods<'a>(&'a self) -> super::provider::ProviderFut<'a, Vec<PodRef>> {
        Box::pin(async move {
            let mut pods = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let mut query = vec![("limit", "100".to_owned())];
                if let Some(cursor) = &cursor {
                    query.push(("cursor", cursor.clone()));
                }
                let query_ref: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
                let body = self.send(reqwest::Method::GET, "/v2/pods", &query_ref, None).await?;
                let page: Vec<Listed> = serde_json::from_value(body.get("pods").cloned().unwrap_or(Value::Null))
                    .map_err(|e| ProviderError::Vendor(self.scrubbed(format!("decode pods: {e}"))))?;
                for pod in page {
                    if !pod.id.is_empty() {
                        pods.push(PodRef { id: pod.id, name: pod.name });
                    }
                }
                let next = body["pagination"]["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
                let more = body["pagination"]["hasNextPage"].as_bool().unwrap_or(false);
                if !more || next.is_none() {
                    break;
                }
                cursor = next;
            }
            Ok(pods)
        })
    }
}

fn clouds_for(query: &Query) -> Vec<&'static str> {
    let reliability = query.reliability.trim().to_ascii_lowercase();
    if query.require_secure {
        if reliability == "community" {
            return Vec::new();
        }
        return vec!["SECURE"];
    }
    match reliability.as_str() {
        "community" => vec!["COMMUNITY"],
        "secure" => vec!["SECURE"],
        _ => vec!["COMMUNITY", "SECURE"],
    }
}

fn quotes_from(gpus: &[Gpu], cloud: &str) -> Vec<Quote> {
    let community = cloud.eq_ignore_ascii_case("COMMUNITY");
    let mut out = Vec::new();
    for gpu in gpus {
        let (price, enabled, name_cloud) = if community {
            (gpu.price.community, gpu.community, "community")
        } else {
            (gpu.price.secure, gpu.secure, "secure")
        };
        if !enabled {
            continue;
        }
        let mut quote = Quote {
            gpu_id: gpu.id.clone(),
            name: if gpu.name.is_empty() { gpu.id.clone() } else { gpu.name.clone() },
            vram_gb: gpu.memory,
            cloud: name_cloud.to_owned(),
            usd_per_hour: price,
            availability: gpu.availability.clone(),
            data_centers: Vec::new(),
        };
        for center in &gpu.data_centers {
            quote.data_centers.push(DataCenter {
                id: center.id.clone(),
                name: center.name.clone(),
                availability: center.availability.clone(),
            });
        }
        out.push(quote);
    }
    out
}

fn urlencoding_path(id: &str) -> String {
    let mut out = String::new();
    for byte in id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
struct Gpu {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    memory: u32,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    community: bool,
    #[serde(default)]
    availability: String,
    #[serde(default)]
    price: Price,
    #[serde(default, rename = "dataCenters")]
    data_centers: Vec<Center>,
}

#[derive(Deserialize, Default)]
struct Price {
    #[serde(default)]
    secure: f64,
    #[serde(default)]
    community: f64,
}

#[derive(Deserialize)]
struct Center {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    availability: String,
}

#[derive(Deserialize)]
struct Listed {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct Pod {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    cost: f64,
    #[serde(default, rename = "dataCenterId")]
    data_center_id: String,
}

impl Pod {
    fn instance(&self, ports: &[Port]) -> Instance {
        let mut endpoints = Vec::new();
        for port in ports {
            endpoints.push(super::provider::Endpoint {
                name: port.name.clone(),
                url: format!("https://{}-{}.proxy.runpod.net", self.id, port.container),
            });
        }
        Instance {
            id: self.id.clone(),
            status: self.status.clone(),
            cost_per_hour: self.cost,
            data_center: self.data_center_id.clone(),
            endpoints,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::rent::provider::{Provider, ProvisionRequest};

    fn request() -> ProvisionRequest {
        ProvisionRequest {
            name: "invincible-node-sess".into(),
            image: "image".into(),
            cloud: "secure".into(),
            gpu_id: "gpu".into(),
            min_ram_gb: 0,
            disk_gb: 10,
            ports: Vec::new(),
            env: std::collections::BTreeMap::new(),
            data_center_ids: Vec::new(),
            entrypoint: Vec::new(),
            registry: None,
        }
    }

    async fn posts(status: u16, delay: Duration) -> (Client, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&hits);
        let app = axum::Router::new().route(
            "/v2/pods",
            axum::routing::post(move || {
                let seen = Arc::clone(&seen);
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    (axum::http::StatusCode::from_u16(status).unwrap(), axum::Json(json!({"error": "no"})))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            Client::build(Some(&origin), "key".into(), Duration::from_millis(200), Duration::from_millis(200)).unwrap();
        (client, hits)
    }

    #[tokio::test]
    async fn a_create_that_returns_500_is_posted_once() {
        let (client, hits) = posts(500, Duration::from_millis(0)).await;
        let err = client.provision(&request()).await.unwrap_err();
        assert!(err.to_string().contains("status 500"), "{err}");
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_create_that_times_out_is_posted_once() {
        let (client, hits) = posts(200, Duration::from_secs(5)).await;
        let err = client.provision(&request()).await.unwrap_err();
        assert!(!err.to_string().contains("status "), "{err}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
