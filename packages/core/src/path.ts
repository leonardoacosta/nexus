import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~` or `~/` to the current user's home directory.
 *
 * - `"~"`       -> homedir()
 * - `"~/dev"`   -> join(homedir(), "dev")
 * - `"/abs"`    -> unchanged
 * - `""`        -> unchanged
 * - `"~user"`   -> unchanged (unsupported form)
 */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
