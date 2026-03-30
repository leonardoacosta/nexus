use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandTier {
    /// Fast, read-only status queries (e.g., /next, /workflow:check)
    Status,
    /// Longer-running analysis, still read-only (e.g., /audit:code, /monitor:sentry)
    Analysis,
    /// Mutates state — needs explicit confirmation (e.g., /apply, /commit)
    Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostCategory {
    /// No CC session needed (e.g., native endpoints)
    Minimal,
    /// Single agent, lightweight (e.g., /next)
    Low,
    /// 2-5 agents (e.g., /audit:services)
    Medium,
    /// 5+ agents, expensive (e.g., /audit:code, /apply)
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandInfo {
    /// Short name (e.g., "code", "check", "apply")
    pub name: String,
    /// Namespace (e.g., "audit", "workflow", "" for top-level)
    pub namespace: String,
    /// Full invocation name (e.g., "audit:code", "apply")
    pub full_name: String,
    /// Human-readable description
    pub description: String,
    /// Execution tier
    pub tier: CommandTier,
    /// Estimated cost category
    pub cost: CostCategory,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_tier_serde_round_trip() {
        for (tier, expected_json) in [
            (CommandTier::Status, "\"status\""),
            (CommandTier::Analysis, "\"analysis\""),
            (CommandTier::Action, "\"action\""),
        ] {
            let serialized = serde_json::to_string(&tier).unwrap();
            assert_eq!(serialized, expected_json);
            let deserialized: CommandTier = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, tier);
        }
    }

    #[test]
    fn cost_category_serde_round_trip() {
        for (cost, expected_json) in [
            (CostCategory::Minimal, "\"minimal\""),
            (CostCategory::Low, "\"low\""),
            (CostCategory::Medium, "\"medium\""),
            (CostCategory::High, "\"high\""),
        ] {
            let serialized = serde_json::to_string(&cost).unwrap();
            assert_eq!(serialized, expected_json);
            let deserialized: CostCategory = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, cost);
        }
    }

    #[test]
    fn command_info_construction_and_serde() {
        let info = CommandInfo {
            name: "code".to_owned(),
            namespace: "audit".to_owned(),
            full_name: "audit:code".to_owned(),
            description: "Audit Code".to_owned(),
            tier: CommandTier::Analysis,
            cost: CostCategory::High,
        };

        assert_eq!(info.name, "code");
        assert_eq!(info.namespace, "audit");
        assert_eq!(info.full_name, "audit:code");

        // Serde round-trip
        let json = serde_json::to_string(&info).unwrap();
        let restored: CommandInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, info);
    }

    #[test]
    fn command_info_top_level_empty_namespace() {
        let info = CommandInfo {
            name: "apply".to_owned(),
            namespace: String::new(),
            full_name: "apply".to_owned(),
            description: "Apply Changes".to_owned(),
            tier: CommandTier::Action,
            cost: CostCategory::High,
        };

        assert_eq!(info.namespace, "");
        assert_eq!(info.full_name, "apply");

        let json = serde_json::to_string(&info).unwrap();
        let restored: CommandInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, info);
    }
}
