export type SortColumn =
  | "account"
  | "plan"
  | "tier"
  | "usage"
  | "firstSeen"
  | "tokenExpiry"
  | "mcps";

export type SortDirection = "asc" | "desc";

export interface SortState {
  column: SortColumn | null;
  direction: SortDirection | null;
}

/** Columns available inside the expanded snapshot sub-table. */
export type SnapshotSortColumn =
  | "name"
  | "primary"
  | "tokenExpiry"
  | "firstSeen";

export interface SnapshotSortState {
  column: SnapshotSortColumn | null;
  direction: SortDirection | null;
}
