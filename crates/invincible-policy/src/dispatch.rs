//! Dispatch rules (spec/dispatch.md): which owned node should answer this request.
//!
//! Pure: no I/O, no clock. The head passes what it just probed, and gets a decision it can log.

use serde::{Deserialize, Serialize};

/// One candidate: what a node advertised on its last probe, plus how many requests we have in
/// flight to it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Node {
    pub name: String,
    /// The model ids it serves and reports healthy.
    #[serde(default)]
    pub models: Vec<String>,
    /// How many requests it will run at once (0: a shard, spoken for).
    #[serde(default)]
    pub max_inflight: u64,
    /// How many we are running there now.
    #[serde(default)]
    pub inflight: u64,
    /// Measured generation rate for the requested model, tokens/s (spec/cluster.md).
    #[serde(default)]
    pub tg_tps: Option<f64>,
    /// Link round trip, milliseconds.
    #[serde(default)]
    pub rtt_ms: Option<f64>,
    /// Whether the last probe answered.
    #[serde(default)]
    pub up: bool,
}

/// What to do with the request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum Choice {
    /// Send it to this node (its index in the input).
    Run { node: usize, name: String },
    /// Every eligible node is at capacity: wait, do not refuse.
    Queue,
    /// No node serves it: 503 `no_capacity`.
    NoCapacity,
}

impl Node {
    /// Whether this node may take the request at all.
    fn eligible(&self, model: Option<&str>) -> bool {
        self.up && self.max_inflight > 0 && model.is_none_or(|m| self.models.iter().any(|served| served == m))
    }

    /// Predicted rate for the model, link cost included: a fast node behind a slow link is slower.
    /// `None` when nothing has been measured, which sorts it after any measured node.
    fn predicted_tps(&self) -> Option<f64> {
        let tps = self.tg_tps?;
        if !(tps.is_finite() && tps > 0.0) {
            return None;
        }
        let link = self.rtt_ms.filter(|r| r.is_finite() && *r >= 0.0).map(|r| r / 1000.0).unwrap_or(0.0);
        // One token per (1/tps + link) seconds.
        Some(1.0 / (1.0 / tps + link))
    }

    /// Load as a fraction of capacity, compared exactly (`inflight / max`) so two nodes cannot tie
    /// on floating point by accident.
    fn load(&self, other: &Node) -> std::cmp::Ordering {
        (self.inflight * other.max_inflight).cmp(&(other.inflight * self.max_inflight))
    }
}

/// Picks the node for one request (spec/dispatch.md, Choosing a node):
/// least loaded relative to capacity, then the highest predicted rate, then the name.
pub fn choose(nodes: &[Node], model: Option<&str>) -> Choice {
    let eligible: Vec<(usize, &Node)> = nodes.iter().enumerate().filter(|(_, n)| n.eligible(model)).collect();
    if eligible.is_empty() {
        return Choice::NoCapacity;
    }
    if eligible.iter().all(|(_, n)| n.inflight >= n.max_inflight) {
        return Choice::Queue;
    }

    let pick = eligible
        .iter()
        .filter(|(_, n)| n.inflight < n.max_inflight)
        .min_by(|(_, a), (_, b)| {
            a.load(b)
                .then_with(|| {
                    // Higher predicted rate first; unmeasured sorts last, not first.
                    match (a.predicted_tps(), b.predicted_tps()) {
                        (Some(x), Some(y)) => y.total_cmp(&x),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => std::cmp::Ordering::Equal,
                    }
                })
                .then_with(|| a.name.cmp(&b.name))
        })
        .expect("eligible and not all at capacity");

    Choice::Run { node: pick.0, name: pick.1.name.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, max: u64, inflight: u64, tps: Option<f64>, rtt: Option<f64>) -> Node {
        Node {
            name: name.into(),
            models: vec!["qwen3-0.6b".into()],
            max_inflight: max,
            inflight,
            tg_tps: tps,
            rtt_ms: rtt,
            up: true,
        }
    }

    fn picked(choice: Choice) -> String {
        match choice {
            Choice::Run { name, .. } => name,
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn the_fastest_idle_node_wins() {
        let nodes = vec![
            node("slow", 2, 0, Some(12.0), Some(1.0)),
            node("fast", 2, 0, Some(40.0), Some(1.0)),
            node("unmeasured", 2, 0, None, None),
        ];
        assert_eq!(picked(choose(&nodes, Some("qwen3-0.6b"))), "fast");
    }

    #[test]
    fn a_busy_node_yields_even_to_a_slower_one() {
        let nodes = vec![node("fast", 2, 2, Some(40.0), Some(1.0)), node("slow", 2, 0, Some(12.0), None)];
        assert_eq!(picked(choose(&nodes, None)), "slow");
    }

    #[test]
    fn capacity_is_relative_not_absolute() {
        // The big node has two in flight of eight; the small one has one of two. The big node is
        // less loaded, so it takes the next request even though its raw count is higher.
        let nodes = vec![node("big", 8, 2, Some(40.0), None), node("small", 2, 1, Some(40.0), None)];
        assert_eq!(picked(choose(&nodes, None)), "big");
    }

    #[test]
    fn all_at_capacity_waits_rather_than_refusing() {
        let nodes = vec![node("a", 2, 2, Some(40.0), None), node("b", 1, 1, Some(12.0), None)];
        assert_eq!(choose(&nodes, None), Choice::Queue);
    }

    #[test]
    fn a_shard_and_a_dead_node_are_never_eligible() {
        let mut shard = node("shard", 0, 0, Some(50.0), None);
        shard.models = vec!["qwen3-0.6b".into()];
        let mut down = node("down", 4, 0, Some(50.0), None);
        down.up = false;
        assert_eq!(choose(&[shard, down], None), Choice::NoCapacity);
    }

    #[test]
    fn a_slow_link_costs_a_fast_node_the_race() {
        // 40 tok/s behind a 300 ms link is ~3 tokens/s (1/(1/40 + 0.3)); 12 tok/s near is better.
        // At 30 ms the far node still wins at 18 tok/s — the link has to be genuinely bad to lose.
        let nodes = vec![node("far", 2, 0, Some(40.0), Some(300.0)), node("near", 2, 0, Some(12.0), Some(0.2))];
        assert_eq!(picked(choose(&nodes, None)), "near");
    }

    #[test]
    fn the_wrong_model_is_no_capacity() {
        let nodes = vec![node("a", 2, 0, Some(40.0), None)];
        assert_eq!(choose(&nodes, Some("llama-70b")), Choice::NoCapacity);
    }
}
