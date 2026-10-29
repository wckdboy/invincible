//! Presets shipped with the node, plus any the operator adds under `$INVINCIBLE_HOME/rent/presets`.
//! The schema is wckd-gpu's (MIT). Copyright (c) 2026 wckdboy.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::provider::Port;

const EMBEDDED: &[(&str, &str)] = &[
    ("comfyui-minimax-h3", include_str!("../../presets/comfyui-minimax-h3.yaml")),
    ("vllm", include_str!("../../presets/vllm.yaml")),
    ("dev-box", include_str!("../../presets/dev-box.yaml")),
];

#[derive(Clone, Debug)]
pub struct Preset {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    pub workload_class: String,
    pub min_vram_gb: u32,
    pub min_ram_gb: u32,
    pub min_disk_gb: u32,
    pub gpu_families: Vec<String>,
    pub reliability: String,
    pub prefer_regions: Vec<String>,
    /// The preset's own hard filter. The node's ceiling is what a request is checked against.
    #[allow(dead_code)]
    pub require_regions: Vec<String>,
    pub image: String,
    pub entrypoint: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub ports: Vec<Port>,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    presets: BTreeMap<String, Preset>,
}

impl Catalog {
    pub fn load(home: &Path) -> Result<Self, String> {
        let mut presets = BTreeMap::new();
        for (id, text) in EMBEDDED {
            let preset = parse(text)?;
            if preset.id != *id {
                return Err(format!("embedded preset {id} declares {}", preset.id));
            }
            presets.insert(preset.id.clone(), preset);
        }
        let dir = home.join("rent/presets");
        if dir.is_dir() {
            for entry in std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
                let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
                if !name.ends_with(".yaml") && !name.ends_with(".yml") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                let preset = parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
                presets.insert(preset.id.clone(), preset);
            }
        }
        Ok(Self { presets })
    }

    pub fn get(&self, id: &str) -> Option<&Preset> {
        self.presets.get(id)
    }
}

fn parse(text: &str) -> Result<Preset, String> {
    let file: File = serde_saphyr::from_str(text).map_err(|e| format!("preset: {e}"))?;
    if file.kind != "Preset" {
        return Err(format!("preset kind {:?} is not Preset", file.kind));
    }
    let constraints = file.spec.constraints.unwrap_or_default();
    let runtime = file.spec.runtime.unwrap_or_default();
    if file.metadata.id.trim().is_empty() {
        return Err("preset metadata.id is empty".to_owned());
    }
    if runtime.image.trim().is_empty() {
        return Err(format!("preset {}: runtime.image is empty", file.metadata.id));
    }
    let mut ports = Vec::new();
    for port in runtime.ports.unwrap_or_default() {
        ports.push(named_port(&port)?);
    }
    Ok(Preset {
        id: file.metadata.id,
        name: file.metadata.name.unwrap_or_default(),
        workload_class: file.spec.workload_class.unwrap_or_else(|| "generic".to_owned()),
        min_vram_gb: constraints.min_vram_gb.unwrap_or(0),
        min_ram_gb: constraints.min_ram_gb.unwrap_or(0),
        min_disk_gb: constraints.min_disk_gb.unwrap_or(50),
        gpu_families: constraints.gpu_families.unwrap_or_default(),
        reliability: constraints.reliability.unwrap_or_else(|| "any".to_owned()),
        prefer_regions: constraints.prefer_regions.unwrap_or_default(),
        require_regions: constraints.require_regions.unwrap_or_default(),
        image: runtime.image,
        entrypoint: runtime.entrypoint.unwrap_or_default(),
        env: runtime.env.unwrap_or_default(),
        ports,
    })
}

fn named_port(port: &PortFile) -> Result<Port, String> {
    let container = port.container.unwrap_or(0);
    if !(1..=65535).contains(&container) {
        return Err(format!("invalid container port {container}"));
    }
    let spec = match port.expose.as_deref().unwrap_or("tunnel").to_ascii_lowercase().as_str() {
        "" | "tunnel" | "http" | "https" => format!("{container}/http"),
        "tcp" => format!("{container}/tcp"),
        other => return Err(format!("unsupported expose {other:?}")),
    };
    let name = port.name.clone().filter(|name| !name.is_empty()).unwrap_or_else(|| format!("port-{container}"));
    Ok(Port { name, container: container as u16, spec })
}

#[derive(Deserialize)]
struct File {
    kind: String,
    metadata: Meta,
    spec: Spec,
}

#[derive(Deserialize)]
struct Meta {
    id: String,
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Spec {
    workload_class: Option<String>,
    constraints: Option<Constraints>,
    runtime: Option<Runtime>,
}

#[derive(Deserialize, Default)]
struct Constraints {
    min_vram_gb: Option<u32>,
    min_ram_gb: Option<u32>,
    min_disk_gb: Option<u32>,
    gpu_families: Option<Vec<String>>,
    reliability: Option<String>,
    prefer_regions: Option<Vec<String>>,
    require_regions: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct Runtime {
    image: String,
    entrypoint: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    ports: Option<Vec<PortFile>>,
}

#[derive(Deserialize)]
struct PortFile {
    name: Option<String>,
    container: Option<u32>,
    expose: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_presets_parse() {
        let catalog = Catalog::load(Path::new("/no/such")).unwrap();
        for id in ["vllm", "comfyui-minimax-h3", "dev-box"] {
            let preset = catalog.get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert!(!preset.image.is_empty());
            assert!(preset.require_regions.iter().any(|region| region == "EU"));
        }
    }
}
