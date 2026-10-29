//! A GPU vendor. RunPod is the first adapter. Another vendor implements the same trait.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a preset asks of a catalog.
#[derive(Clone, Debug)]
pub struct Query {
    pub min_vram_gb: u32,
    pub gpu_families: Vec<String>,
    pub reliability: String,
    pub prefer_regions: Vec<String>,
    pub require_regions: Vec<String>,
    pub require_secure: bool,
    pub workload_class: String,
}

/// One data center a quote can land in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataCenter {
    pub id: String,
    pub name: String,
    pub availability: String,
}

/// A vendor price, before the broker scores it.
#[derive(Clone, Debug)]
pub struct Quote {
    pub gpu_id: String,
    pub name: String,
    pub vram_gb: u32,
    pub cloud: String,
    pub usd_per_hour: f64,
    pub data_centers: Vec<DataCenter>,
    pub availability: String,
}

/// A ranked offer. The id is stable: `runpod:<cloud>:<gpu id>`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Offer {
    pub id: String,
    pub vendor: String,
    pub sku: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub family: String,
    pub vram_gb: u32,
    pub usd_per_hr: f64,
    pub cloud: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub region: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_center_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub availability: String,
    pub perf_index: f64,
    pub perf_table: String,
    pub reliability_factor: f64,
    pub region_factor: f64,
    pub score: f64,
}

/// What the vendor created.
#[derive(Clone, Debug, Default)]
pub struct Instance {
    pub id: String,
    pub status: String,
    pub cost_per_hour: f64,
    pub data_center: String,
    pub endpoints: Vec<Endpoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Endpoint {
    pub name: String,
    pub url: String,
}

/// A pod to create. `env` may hold object-store credentials for the workload. Callers scrub
/// those values out of anything they log or return.
#[derive(Clone)]
pub struct ProvisionRequest {
    pub name: String,
    pub image: String,
    pub cloud: String,
    pub gpu_id: String,
    pub min_ram_gb: u32,
    pub disk_gb: u32,
    pub ports: Vec<Port>,
    pub env: BTreeMap<String, String>,
    pub data_center_ids: Vec<String>,
    pub entrypoint: Vec<String>,
}

impl std::fmt::Debug for ProvisionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut env: BTreeMap<&str, &str> = BTreeMap::new();
        for (key, value) in &self.env {
            let secret = key.contains("SECRET")
                || key.contains("ACCESS_KEY")
                || key.contains("TOKEN")
                || key.contains("PASSWORD");
            env.insert(key.as_str(), if secret { "[redacted]" } else { value.as_str() });
        }
        f.debug_struct("ProvisionRequest")
            .field("name", &self.name)
            .field("image", &self.image)
            .field("cloud", &self.cloud)
            .field("gpu_id", &self.gpu_id)
            .field("env", &env)
            .field("data_center_ids", &self.data_center_ids)
            .finish_non_exhaustive()
    }
}

/// A pod the vendor still has, for reconciliation.
#[derive(Clone, Debug)]
pub struct PodRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Port {
    pub name: String,
    pub container: u16,
    pub spec: String,
}

#[derive(Debug)]
pub enum ProviderError {
    /// The vendor refused or failed. Already scrubbed.
    Vendor(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Vendor(message) => f.write_str(message),
        }
    }
}

pub trait Provider: Send + Sync {
    fn list_quotes<'a>(&'a self, query: &'a Query) -> ProviderFut<'a, Vec<Quote>>;
    fn provision<'a>(&'a self, request: &'a ProvisionRequest) -> ProviderFut<'a, Instance>;
    fn status<'a>(&'a self, id: &'a str) -> ProviderFut<'a, Instance>;
    fn terminate<'a>(&'a self, id: &'a str) -> ProviderFut<'a, ()>;
    fn list_pods<'a>(&'a self) -> ProviderFut<'a, Vec<PodRef>>;
}

pub type ProviderFut<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, ProviderError>> + Send + 'a>>;
