/**
 * Thrown when `CredentialPool.deleteById()` is called against a primary row
 * whose duplicate group has more than one member, but the caller did not
 * supply a `promoteId`. HTTP handlers translate this to 409 Conflict so the
 * caller can retry with `?promote=<sibling_id>`.
 */
export class CredentialDeleteError extends Error {
  readonly code = "REQUIRES_PROMOTE" as const;
  /** Sibling ids the caller can use as the promotion target. */
  readonly siblings: readonly string[];

  constructor(message: string, siblings: readonly string[]) {
    super(message);
    this.name = "CredentialDeleteError";
    this.siblings = siblings;
  }
}
