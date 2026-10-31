//! Price broker. Offers that fit a preset are ranked by catalog $/hr, then by the labeled fit
//! score. The catalog is cached for a short TTL so a quote and the confirm behind it see one list.
//!
//! The score table is ported from wckd-gpu (MIT). Copyright (c) 2026 wckdboy.

use std::time::{Duration, Instant};

use super::provider::{DataCenter, Offer, Query, Quote};

const PERF_TABLE: &str = "2026-09-29";
const RELIABILITY_SECURE: f64 = 1.0;
const RELIABILITY_COMMUNITY: f64 = 0.85;
const REGION_PREFERRED: f64 = 1.0;
const REGION_OTHER: f64 = 0.90;
pub const FAILOVER: usize = 3;
pub const CACHE_TTL: Duration = Duration::from_secs(30);

pub struct Cache {
    key: String,
    at: Instant,
    offers: Vec<Offer>,
}

impl Cache {
    pub fn new() -> Self {
        Self { key: String::new(), at: Instant::now(), offers: Vec::new() }
    }

    pub fn get(&self, key: &str) -> Option<&[Offer]> {
        (self.key == key && self.at.elapsed() < CACHE_TTL).then_some(self.offers.as_slice())
    }

    pub fn put(&mut self, key: String, offers: Vec<Offer>) {
        self.key = key;
        self.at = Instant::now();
        self.offers = offers;
    }
}

pub fn cache_key(query: &Query) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        query.workload_class,
        query.min_vram_gb,
        query.gpu_families.join(","),
        query.reliability,
        query.require_regions.join(","),
        query.require_secure
    )
}

/// Cheapest fit first. At the same price, the higher labeled score wins.
pub fn rank(quotes: &[Quote], query: &Query) -> Vec<Offer> {
    let mut out: Vec<Offer> = quotes.iter().filter_map(|quote| score_quote(quote, query)).collect();
    out.sort_by(|a, b| {
        a.usd_per_hr
            .partial_cmp(&b.usd_per_hr)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// The offers a start would try. A locked id is that row only.
pub fn select(offers: &[Offer], offer_id: Option<&str>) -> Result<Vec<Offer>, String> {
    if offers.is_empty() {
        return Err("no offers matched the preset".to_owned());
    }
    if let Some(id) = offer_id.map(str::trim).filter(|id| !id.is_empty()) {
        return offers
            .iter()
            .find(|offer| offer.id == id)
            .cloned()
            .map(|offer| vec![offer])
            .ok_or_else(|| format!("offer {id} is not in the ranked list for this preset"));
    }
    Ok(offers.iter().take(FAILOVER).cloned().collect())
}

pub fn format_id(cloud: &str, gpu_id: &str) -> String {
    format!("runpod:{}:{gpu_id}", cloud.to_ascii_lowercase())
}

fn score_quote(quote: &Quote, query: &Query) -> Option<Offer> {
    if quote.usd_per_hour <= 0.0 || quote.vram_gb == 0 {
        return None;
    }
    if query.min_vram_gb > 0 && quote.vram_gb < query.min_vram_gb {
        return None;
    }
    if quote.availability.eq_ignore_ascii_case("NONE") {
        return None;
    }
    let cloud = quote.cloud.to_ascii_lowercase();
    if cloud != "community" && cloud != "secure" {
        return None;
    }
    match query.reliability.trim().to_ascii_lowercase().as_str() {
        "" | "any" => {}
        "community" if cloud != "community" => return None,
        "secure" if cloud != "secure" => return None,
        "community" | "secure" => {}
        _ => return None,
    }
    if query.require_secure && cloud != "secure" {
        return None;
    }
    let (family, matched) = match_family(&format!("{} {}", quote.gpu_id, quote.name), &query.gpu_families);
    if !query.gpu_families.is_empty() && !matched {
        return None;
    }
    let mut centers = usable(&quote.data_centers);
    if !query.require_regions.is_empty() {
        centers.retain(|center| region_match(center, &query.require_regions));
        if centers.is_empty() {
            return None;
        }
    }
    let (region, region_factor, mut ids) = place(&centers, &query.prefer_regions);
    if !query.require_regions.is_empty() && ids.is_empty() {
        ids = centers.iter().map(|center| center.id.clone()).filter(|id| !id.is_empty()).collect();
    }
    let (perf, table) = perf_index(&query.workload_class, &family, quote.vram_gb);
    let reliability = if cloud == "secure" { RELIABILITY_SECURE } else { RELIABILITY_COMMUNITY };
    Some(Offer {
        id: format_id(&cloud, &quote.gpu_id),
        vendor: "runpod".to_owned(),
        sku: quote.gpu_id.clone(),
        name: quote.name.clone(),
        family,
        vram_gb: quote.vram_gb,
        usd_per_hr: quote.usd_per_hour,
        cloud,
        region,
        data_center_ids: ids,
        availability: quote.availability.clone(),
        perf_index: perf,
        perf_table: table,
        reliability_factor: reliability,
        region_factor,
        score: score(perf, quote.usd_per_hour, reliability, region_factor),
    })
}

fn score(perf: f64, usd: f64, reliability: f64, region: f64) -> f64 {
    if usd <= 0.0 || perf <= 0.0 || reliability <= 0.0 || region <= 0.0 {
        0.0
    } else {
        (perf / usd) * reliability * region
    }
}

fn place(centers: &[DataCenter], prefer: &[String]) -> (String, f64, Vec<String>) {
    if prefer.is_empty() {
        let ids = centers.iter().map(|center| center.id.clone()).collect();
        return (centers.first().map(|center| center.id.clone()).unwrap_or_default(), REGION_PREFERRED, ids);
    }
    let preferred: Vec<&DataCenter> = centers.iter().filter(|center| region_match(center, prefer)).collect();
    if !preferred.is_empty() {
        let ids = preferred.iter().map(|center| center.id.clone()).collect();
        return (preferred[0].id.clone(), REGION_PREFERRED, ids);
    }
    (centers.first().map(|center| center.id.clone()).unwrap_or_default(), REGION_OTHER, Vec::new())
}

fn usable(centers: &[DataCenter]) -> Vec<DataCenter> {
    centers
        .iter()
        .filter(|center| !center.id.is_empty() && !center.availability.eq_ignore_ascii_case("NONE"))
        .cloned()
        .collect()
}

/// `EU` matches `EU-RO-1` and `EU Romania`, and does not match `EUR-IS-1`.
pub fn matches_region(id: &str, name: &str, regions: &[String]) -> bool {
    region_match(&DataCenter { id: id.to_owned(), name: name.to_owned(), availability: String::new() }, regions)
}

fn region_match(center: &DataCenter, regions: &[String]) -> bool {
    if regions.is_empty() {
        return true;
    }
    regions.iter().any(|token| {
        let token = token.trim().to_ascii_uppercase();
        !token.is_empty() && (token_at_boundary(&center.id, &token) || token_at_boundary(&center.name, &token))
    })
}

fn token_at_boundary(hay: &str, token: &str) -> bool {
    let hay = hay.to_ascii_uppercase();
    let bytes = hay.as_bytes();
    let needle = token.as_bytes();
    if needle.is_empty() || bytes.is_empty() || needle.len() > bytes.len() {
        return false;
    }
    let mut index = 0;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] == needle {
            let before = index == 0 || !is_alnum(bytes[index - 1]);
            let end = index + needle.len();
            let after = end == bytes.len() || !is_alnum(bytes[end]);
            if before && after {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn is_alnum(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

fn match_family(gpu: &str, allow: &[String]) -> (String, bool) {
    let candidates: Vec<&str> =
        if allow.is_empty() { KNOWN.to_vec() } else { allow.iter().map(String::as_str).collect() };
    let norm = normalize(gpu);
    let mut best = "";
    for family in candidates {
        let token = normalize(family);
        if !token.is_empty() && norm.contains(&token) && token.len() > normalize(best).len() {
            best = family;
        }
    }
    if best.is_empty() { (String::new(), false) } else { (best.to_owned(), true) }
}

fn normalize(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(|c| c.to_uppercase()).collect()
}

fn perf_index(class: &str, family: &str, vram_gb: u32) -> (f64, String) {
    let table_name = format!("{PERF_TABLE}/{}", workload_or_generic(class));
    let table = perf_table(class);
    if !family.is_empty()
        && let Some(value) =
            table.iter().find(|(name, _)| normalize(name) == normalize(family)).map(|(_, value)| *value)
    {
        return (value, table_name);
    }
    if vram_gb == 0 {
        return (0.0, format!("{table_name}-none"));
    }
    (f64::from(vram_gb), format!("{table_name}-vram-fallback"))
}

fn workload_or_generic(class: &str) -> &'static str {
    match class {
        "video_dit" | "llm" | "generic" => match class {
            "video_dit" => "video_dit",
            "llm" => "llm",
            _ => "generic",
        },
        _ => "generic",
    }
}

fn perf_table(class: &str) -> &'static [(&'static str, f64)] {
    match class {
        "video_dit" => VIDEO,
        "llm" => LLM,
        _ => GENERIC,
    }
}

const KNOWN: &[&str] = &["PRO6000", "H200", "H100", "A100", "L40S", "A6000", "5090", "4090", "3090", "A40", "L4"];

const VIDEO: &[(&str, f64)] = &[
    ("H200", 130.0),
    ("H100", 100.0),
    ("PRO6000", 90.0),
    ("5090", 70.0),
    ("A100", 55.0),
    ("4090", 45.0),
    ("L40S", 40.0),
    ("3090", 28.0),
];

const LLM: &[(&str, f64)] = &[
    ("H200", 140.0),
    ("H100", 100.0),
    ("PRO6000", 70.0),
    ("5090", 55.0),
    ("A100", 60.0),
    ("L40S", 40.0),
    ("4090", 35.0),
    ("3090", 22.0),
];

const GENERIC: &[(&str, f64)] = &[
    ("H200", 120.0),
    ("H100", 100.0),
    ("PRO6000", 80.0),
    ("5090", 64.0),
    ("A100", 70.0),
    ("4090", 48.0),
    ("L40S", 42.0),
    ("3090", 30.0),
];

/// Hard region filter. `EU-secure` keeps the `EU` prefix and requires Secure cloud.
/// `any` or `*` alone clears the filter.
pub fn parse_require(tokens: &[String]) -> Result<(Vec<String>, bool), String> {
    let mut regions = Vec::new();
    let mut secure = false;
    let mut opt_out = false;
    for raw in tokens {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if lower == "any" || lower == "*" {
            opt_out = true;
            continue;
        }
        let (region, is_secure) = split_secure(token);
        if region.trim().is_empty() {
            return Err(format!("require_regions token {raw:?} is empty"));
        }
        secure |= is_secure;
        if !regions.iter().any(|have: &String| have.eq_ignore_ascii_case(region)) {
            regions.push(region.to_owned());
        }
    }
    if opt_out {
        if !regions.is_empty() || secure {
            return Err("require_regions any cannot be combined with other tokens".to_owned());
        }
        return Ok((Vec::new(), false));
    }
    Ok((regions, secure))
}

fn split_secure(token: &str) -> (&str, bool) {
    match token.strip_suffix("-secure").or_else(|| token.strip_suffix("-SECURE")) {
        Some(region) if !region.is_empty() => (region, true),
        _ => (token, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(id: &str, cloud: &str, usd: f64, centers: &[(&str, &str)]) -> Quote {
        Quote {
            gpu_id: id.to_owned(),
            name: id.to_owned(),
            vram_gb: 24,
            cloud: cloud.to_owned(),
            usd_per_hour: usd,
            availability: "HIGH".into(),
            data_centers: centers
                .iter()
                .map(|(id, name)| DataCenter {
                    id: (*id).to_owned(),
                    name: (*name).to_owned(),
                    availability: "HIGH".into(),
                })
                .collect(),
        }
    }

    fn query(regions: &[&str], secure: bool) -> Query {
        Query {
            min_vram_gb: 24,
            gpu_families: vec!["4090".into()],
            reliability: "any".into(),
            prefer_regions: vec!["EU".into()],
            require_regions: regions.iter().map(|r| (*r).to_owned()).collect(),
            require_secure: secure,
            workload_class: "llm".into(),
        }
    }

    #[test]
    fn cheapest_fit_wins_and_eu_drops_a_us_only_card() {
        let quotes = vec![
            quote("NVIDIA GeForce RTX 4090", "community", 0.90, &[("US-OR-1", "US Oregon")]),
            quote("NVIDIA GeForce RTX 4090", "community", 0.50, &[("EU-RO-1", "EU Romania"), ("US-OR-1", "US Oregon")]),
            quote("NVIDIA GeForce RTX 4090", "secure", 0.40, &[("EU-SE-1", "EU Sweden")]),
        ];
        let ranked = rank(&quotes, &query(&["EU"], false));
        assert_eq!(ranked[0].usd_per_hr, 0.40);
        assert_eq!(ranked[0].cloud, "secure");
        assert!(ranked.iter().all(|offer| offer.data_center_ids.iter().all(|id| id.starts_with("EU"))));
        assert!(ranked.iter().all(|offer| !offer.data_center_ids.iter().any(|id| id.starts_with("US"))));
        let secure = rank(&quotes, &query(&["EU"], true));
        assert!(secure.iter().all(|offer| offer.cloud == "secure"));
    }

    #[test]
    fn eu_does_not_match_a_token_that_only_shares_a_prefix() {
        assert!(matches_region("EU-RO-1", "EU Romania", &["EU".into()]));
        assert!(!matches_region("EUR-IS-1", "Europe Iceland", &["EU".into()]));
    }
}
