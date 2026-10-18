//! Where one request runs (spec/routing.md, v0).

use serde::{Deserialize, Deserializer, Serialize};

use crate::NetworkMode;

/// One routing question: the request, the node's settings and the models it can use.
#[derive(Clone, Debug, Deserialize)]
pub struct RouteInput {
    pub request: Request,
    pub node: NodeSettings,
    /// In order of preference: the first match wins.
    #[serde(default)]
    pub models: Vec<Model>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    /// `"auto"`, or the id of one model.
    #[serde(default = "auto")]
    pub model: String,
    /// Must never leave hardware the user owns.
    #[serde(default)]
    pub private: bool,
    /// Risk codes (Autobot's `CascadeRisk`); any code, known or not, counts as risk.
    #[serde(default)]
    pub risk: Vec<String>,
    #[serde(default)]
    pub prompt_tokens: u64,
    /// The user already approved a cloud run for this request.
    #[serde(default)]
    pub confirmed: bool,
}

fn auto() -> String {
    AUTO.to_owned()
}

const AUTO: &str = "auto";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct NodeSettings {
    #[serde(default)]
    pub network: NetworkMode,
    #[serde(default)]
    pub egress: Egress,
}

/// Whether requests may leave for the cloud (Autobot's `CascadePolicy`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Egress {
    /// Nothing leaves. The default, and the reading of anything unknown.
    #[default]
    Never,
    /// Every cloud run needs confirmation.
    Ask,
    /// Cloud runs go ahead, except an automatic choice with risk.
    Auto,
}

impl Egress {
    pub fn parse(value: &str) -> Self {
        match value {
            "ask" => Self::Ask,
            "auto" => Self::Auto,
            _ => Self::Never,
        }
    }
}

impl<'de> Deserialize<'de> for Egress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::parse(&String::deserialize(deserializer)?))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub tier: Tier,
    #[serde(default)]
    pub healthy: bool,
    /// Context window in tokens; `None` is unknown and never too small.
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default)]
    pub data_policy: DataPolicy,
}

/// Where a model runs. Anything that is not `node`, including the reserved `region`, is `cloud`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Hardware the user owns.
    Node,
    #[default]
    Cloud,
}

impl<'de> Deserialize<'de> for Tier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "node" => Self::Node,
            _ => Self::Cloud,
        })
    }
}

/// What the operator does with prompts (Autobot's `ModelDataPolicy`, plus [DataPolicy::Owned]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DataPolicy {
    /// Runs on hardware the user owns.
    Owned,
    NoRetention,
    Retention {
        days: u32,
    },
    Trains,
    #[default]
    Unknown,
}

impl DataPolicy {
    pub fn parse(value: &str) -> Self {
        match value {
            "owned" => Self::Owned,
            "no-retention" => Self::NoRetention,
            "trains" => Self::Trains,
            _ => value
                .strip_prefix("retention:")
                .and_then(|days| days.parse().ok())
                .map_or(Self::Unknown, |days| Self::Retention { days }),
        }
    }
}

impl<'de> Deserialize<'de> for DataPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::parse(&String::deserialize(deserializer)?))
    }
}

/// The router's answer. Serialises exactly as spec/routing.md's decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Decision {
    pub action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    pub reason: Reason,
    /// A node model runs instead of the cloud model that was asked for.
    #[serde(skip_serializing_if = "is_false")]
    pub fallback: bool,
    /// Redaction must run before the request leaves.
    #[serde(skip_serializing_if = "is_false")]
    pub redact: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Run,
    /// Ask the user, then send the request again with `confirmed: true`.
    Ask,
    Block,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    LocalFirst,
    Requested,
    ModelUnavailable,
    Private,
    Offline,
    EgressNever,
    CloudDown,
    Trains,
    EgressAsk,
    Sensitive,
    TooLong,
    NoLocalModel,
    UnknownModel,
    NoModel,
}

impl Decision {
    fn run(model: &Model, reason: Reason) -> Self {
        let cloud = model.tier == Tier::Cloud;
        Self {
            action: Action::Run,
            model: Some(model.id.clone()),
            tier: Some(model.tier),
            reason,
            fallback: false,
            redact: cloud,
        }
    }

    fn fallback(model: &Model, reason: Reason) -> Self {
        Self { fallback: true, ..Self::run(model, reason) }
    }

    fn ask(model: &Model, reason: Reason) -> Self {
        Self { action: Action::Ask, redact: false, ..Self::run(model, reason) }
    }

    fn block(reason: Reason) -> Self {
        Self { action: Action::Block, model: None, tier: None, reason, fallback: false, redact: false }
    }
}

/// Decides where one request runs (spec/routing.md, "Rules").
pub fn decide(input: &RouteInput) -> Decision {
    let request = &input.request;
    let node = &input.node;
    let fits = |m: &Model| m.healthy && m.context.is_none_or(|c| request.prompt_tokens <= c);
    let local_pick = input.models.iter().find(|m| m.tier == Tier::Node && fits(m));

    // The first reason a cloud model cannot be used, in the spec's order.
    let cloud_block = |m: &Model| {
        if request.private {
            Some(Reason::Private)
        } else if node.network.is_offline() {
            Some(Reason::Offline)
        } else if node.egress == Egress::Never {
            Some(Reason::EgressNever)
        } else if !m.healthy {
            Some(Reason::CloudDown)
        } else {
            None
        }
    };

    if request.model != AUTO {
        let Some(named) = input.models.iter().find(|m| m.id == request.model) else {
            return Decision::block(Reason::UnknownModel);
        };
        if named.tier == Tier::Node {
            return if fits(named) {
                Decision::run(named, Reason::Requested)
            } else {
                local_pick
                    .map_or(Decision::block(Reason::ModelUnavailable), |m| Decision::run(m, Reason::ModelUnavailable))
            };
        }
        if let Some(reason) = cloud_block(named) {
            return local_pick.map_or(Decision::block(reason), |m| Decision::fallback(m, reason));
        }
        if !request.confirmed {
            if named.data_policy == DataPolicy::Trains {
                return Decision::ask(named, Reason::Trains);
            }
            if node.egress == Egress::Ask {
                return Decision::ask(named, Reason::EgressAsk);
            }
        }
        return Decision::run(named, Reason::Requested);
    }

    if let Some(local) = local_pick {
        return Decision::run(local, Reason::LocalFirst);
    }
    let Some(cloud) =
        input.models.iter().find(|m| m.tier == Tier::Cloud && m.healthy && m.data_policy != DataPolicy::Trains)
    else {
        return Decision::block(Reason::NoModel);
    };
    if let Some(reason) = cloud_block(cloud) {
        return Decision::block(reason);
    }
    if !request.confirmed {
        if node.egress == Egress::Ask {
            return Decision::ask(cloud, Reason::EgressAsk);
        }
        if !request.risk.is_empty() {
            return Decision::ask(cloud, Reason::Sensitive);
        }
    }
    let local_exists = input.models.iter().any(|m| m.tier == Tier::Node && m.healthy);
    Decision::run(cloud, if local_exists { Reason::TooLong } else { Reason::NoLocalModel })
}
