//! Running in the background: the services live in [invincible::service], shared with
//! `invincible update` (which restarts them) and `invincible update --auto` (the daily job).

pub use invincible::service::*;
