// ---------------------------------------------------------------------------
// Confirm kind for two-step destructive actions
// ---------------------------------------------------------------------------

/// Pending confirmation for destructive actions (approve/reject spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmKind {
    ApproveSpec,
    RejectSpec,
}
