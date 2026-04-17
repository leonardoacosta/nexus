export type SortColumn =
  | "account"
  | "plan"
  | "tier"
  | "firstSeen"
  | "tokenExpiry"
  | "mcps";

export type SortDirection = "asc" | "desc";

export interface SortState {
  column: SortColumn | null;
  direction: SortDirection | null;
}
