/** Credential pool states. */
export type CredentialStatus = "available" | "leased" | "cooldown";

/** A credential managed by the agent's credential pool. */
export interface Credential {
  id: string;
  name: string;
  type: string;
  status: CredentialStatus;
  leased_by?: string;
  leased_at?: string;
  cooldown_until?: string;
}
