//! Invincible's policy rules, shared with Autobot through `spec/`.
//!
//! Everything here is pure: no I/O, no clock, no randomness. The conformance vectors in
//! `spec/vectors/` pin the behaviour down, and Autobot runs the same vectors.

mod network;
mod routing;

pub use network::NetworkMode;
pub use routing::{
    Action, DataPolicy, Decision, Egress, Model, NodeSettings, Reason, Request, RouteInput, Tier, decide,
};
