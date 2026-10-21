//! Invincible's policy rules, shared with Autobot through `spec/`.
//!
//! Everything here is pure: no I/O, no clock, no randomness. The conformance vectors in
//! `spec/vectors/` pin the behaviour down, and Autobot runs the same vectors.

mod cluster;
mod egress;
mod network;
mod routing;

pub use cluster::{
    LinkAction, LinkDecision, LinkInput, LinkReason, Plan, PlanAction, PlanDevice, PlanInput, PlanReason, Share,
    SplitMode, decide_link, is_lan, plan,
};
pub use egress::{EgressAction, EgressDecision, EgressInput, EgressReason, decide_egress, is_loopback};
pub use network::NetworkMode;
pub use routing::{
    Action, DataPolicy, Decision, Egress, Model, NodeSettings, Reason, Request, RouteInput, Tier, decide,
};
