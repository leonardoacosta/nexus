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
