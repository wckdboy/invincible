//! Subscription records: what the owner pays for, when it renews, and what it costs.
//!
//! This is a ledger, not a billing system. It lives in `$AUTOBOT_HOME/subscriptions.json` and is
//! shown in the panel; providers never receive these values.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_NOTES: usize = 500;
const UPCOMING_DAYS: i64 = 30;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Subscription {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default = "active")]
    pub status: String,
    #[serde(default)]
    pub monthly_cost: f64,
    #[serde(default = "usd")]
    pub currency: String,
    #[serde(default)]
    pub renews_on: Option<String>,
    #[serde(default = "seat")]
    pub seats: u32,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub updated_at: u64,
}

fn active() -> String {
    "active".to_owned()
}

fn usd() -> String {
    "USD".to_owned()
}

fn seat() -> u32 {
    1
}

impl Subscription {
    pub fn view(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "provider": self.provider,
            "plan": self.plan,
            "status": self.status,
            "monthly_cost": self.monthly_cost,
            "currency": self.currency,
            "renews_on": self.renews_on,
            "seats": self.seats,
            "url": self.url,
            "notes": self.notes,
            "updated_at": self.updated_at,
        })
    }
}

pub struct Subscriptions {
    home: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    subscriptions: Vec<Subscription>,
}

impl Subscriptions {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), lock: Mutex::new(()) }
    }

    fn file(&self) -> PathBuf {
        self.home.join("subscriptions.json")
    }

    fn load(&self) -> Result<Vec<Subscription>, String> {
        let Some(text) = invincible::fsutil::read_optional(&self.file())? else {
            return Ok(Vec::new());
        };
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let registry: Registry = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file().display()))?;
        Ok(registry.subscriptions)
    }

    fn save(&self, subscriptions: &[Subscription]) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&Registry { subscriptions: subscriptions.to_vec() })
            .map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&self.file(), &format!("{text}\n"))
    }

    pub fn list(&self) -> Result<Vec<Subscription>, String> {
        let _guard = self.lock.lock().map_err(|_| "the subscriptions lock is poisoned".to_owned())?;
        let mut list = self.load()?;
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        Ok(list)
    }

    pub fn upsert(&self, mut subscription: Subscription) -> Result<Subscription, String> {
        subscription.id = subscription.id.trim().to_owned();
        subscription.name = subscription.name.trim().to_owned();
        subscription.provider = subscription.provider.trim().to_owned();
        subscription.plan = subscription.plan.trim().to_owned();
        subscription.status = subscription.status.trim().to_lowercase();
        subscription.currency = subscription.currency.trim().to_uppercase();
        subscription.renews_on = subscription.renews_on.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
        subscription.url = subscription.url.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty());
        subscription.notes = subscription.notes.trim().to_owned();
        if subscription.name.is_empty() || subscription.name.chars().count() > 100 {
            return Err("a subscription name is 1–100 characters".to_owned());
        }
        if !subscription.id.is_empty()
            && !subscription.id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err("a subscription id uses letters, digits, - and _ only".to_owned());
        }
        if !matches!(subscription.status.as_str(), "active" | "paused" | "cancelled") {
            return Err("status is active, paused or cancelled".to_owned());
        }
        if !subscription.monthly_cost.is_finite() || subscription.monthly_cost < 0.0 {
            return Err("the monthly cost is a non-negative number".to_owned());
        }
        if subscription.monthly_cost > 1_000_000.0 {
            return Err("the monthly cost is too large".to_owned());
        }
        if subscription.currency.len() != 3 || !subscription.currency.chars().all(|c| c.is_ascii_uppercase()) {
            return Err("the currency is a three-letter code, like USD".to_owned());
        }
        if let Some(date) = &subscription.renews_on
            && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
        {
            return Err("renews_on is YYYY-MM-DD".to_owned());
        }
        if let Some(url) = &subscription.url
            && !(url.starts_with("https://") || url.starts_with("http://"))
        {
            return Err("url must start with http:// or https://".to_owned());
        }
        if subscription.notes.chars().count() > MAX_NOTES {
            return Err(format!("notes are at most {MAX_NOTES} characters"));
        }
        if subscription.seats == 0 {
            subscription.seats = 1;
        }
        let _guard = self.lock.lock().map_err(|_| "the subscriptions lock is poisoned".to_owned())?;
        let mut list = self.load()?;
        if subscription.id.is_empty() {
            subscription.id = format!("s-{}", invincible::token::hex(&invincible::token::random::<6>()?));
        }
        subscription.updated_at = now();
        match list.iter_mut().find(|s| s.id == subscription.id) {
            Some(old) => *old = subscription.clone(),
            None => list.push(subscription.clone()),
        }
        self.save(&list)?;
        Ok(subscription)
    }

    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().map_err(|_| "the subscriptions lock is poisoned".to_owned())?;
        let mut list = self.load()?;
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Ok(false);
        }
        self.save(&list)?;
        Ok(true)
    }

    /// The list plus the totals per currency and renewals in the next 30 days.
    pub fn summary(&self) -> Result<Value, String> {
        let list = self.list()?;
        let mut totals: BTreeMap<String, f64> = BTreeMap::new();
        for subscription in list.iter().filter(|s| s.status == "active") {
            *totals.entry(subscription.currency.clone()).or_default() += subscription.monthly_cost;
        }
        let totals: Vec<Value> = totals
            .into_iter()
            .map(|(currency, monthly)| json!({ "currency": currency, "monthly": (monthly * 100.0).round() / 100.0 }))
            .collect();
        let today = chrono::Local::now().date_naive();
        let mut upcoming: Vec<Value> = list
            .iter()
            .filter(|s| s.status == "active")
            .filter_map(|s| {
                let date =
                    s.renews_on.as_deref().and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())?;
                let days = (date - today).num_days();
                (0..=UPCOMING_DAYS).contains(&days).then(|| {
                    json!({
                        "id": s.id,
                        "name": s.name,
                        "provider": s.provider,
                        "renews_on": s.renews_on,
                        "days": days,
                    })
                })
            })
            .collect();
        upcoming.sort_by_key(|item| item["days"].as_i64().unwrap_or(i64::MAX));
        Ok(json!({
            "subscriptions": list.iter().map(Subscription::view).collect::<Vec<_>>(),
            "totals": totals,
            "upcoming": upcoming,
            "active": list.iter().filter(|s| s.status == "active").count(),
            "all": list.len(),
        }))
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("autobot-subs-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sub(name: &str, cost: f64, currency: &str) -> Subscription {
        Subscription {
            id: String::new(),
            name: name.into(),
            provider: "Anthropic".into(),
            plan: "Max".into(),
            status: "active".into(),
            monthly_cost: cost,
            currency: currency.into(),
            renews_on: None,
            seats: 1,
            url: None,
            notes: String::new(),
            updated_at: 0,
        }
    }

    #[test]
    fn subscriptions_round_trip_and_total() {
        let dir = dir();
        let subs = Subscriptions::new(&dir);
        subs.upsert(sub("Claude Max", 100.0, "USD")).unwrap();
        subs.upsert(sub("ChatGPT Plus", 20.0, "USD")).unwrap();
        subs.upsert(sub("Mistral", 10.0, "EUR")).unwrap();
        let summary = subs.summary().unwrap();
        assert_eq!(summary["active"], 3);
        let totals = summary["totals"].as_array().unwrap();
        assert!(totals.iter().any(|t| t["currency"] == "USD" && t["monthly"] == 120.0));
        assert!(totals.iter().any(|t| t["currency"] == "EUR" && t["monthly"] == 10.0));
        let id = summary["subscriptions"][0]["id"].as_str().unwrap().to_owned();
        assert!(subs.remove(&id).unwrap());
        assert!(!subs.remove(&id).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_subscription_is_validated() {
        let dir = dir();
        let subs = Subscriptions::new(&dir);
        let mut bad = sub("", 1.0, "USD");
        assert!(subs.upsert(bad.clone()).is_err());
        bad.name = "ok".into();
        bad.currency = "US".into();
        assert!(subs.upsert(bad.clone()).is_err());
        bad.currency = "usd".into();
        assert!(subs.upsert(bad.clone()).is_ok(), "a lowercase currency is normalized");
        bad.currency = "USD".into();
        bad.status = "later".into();
        assert!(subs.upsert(bad.clone()).is_err());
        bad.status = "active".into();
        bad.renews_on = Some("tomorrow".into());
        assert!(subs.upsert(bad.clone()).is_err());
        bad.renews_on = Some("2026-12-01".into());
        assert!(subs.upsert(bad).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
