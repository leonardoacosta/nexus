/**
 * Bundle-integrity assertion test (add-fullstack-integration-test-gate 1.5).
 *
 * The heavy `xcodebuild` build lives in `deploy/check-bundle-integrity.sh`
 * (invoked by the pre-push gate). This test asserts the PRODUCED bundle is
 * well-formed without re-running xcodebuild on every `bun test` — it reads
 * the already-built `nexus.app` from the derivedData path and verifies:
 *
 *   1. the product is named `nexus.app`,
 *   2. its Info.plist contains `NSAppTransportSecurity` (nx-p2zs5 class),
 *   3. its Info.plist contains `LSUIElement` (menu-bar agent class).
 *
 * Skips cleanly when the bundle has not been built yet (no derivedData) or
 * off macOS, so the always-run Tier A stays fast in local dev. The pre-push
 * gate runs the script (which builds) THEN this test (which asserts), so the
 * gate path always exercises a fresh bundle.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DERIVED =
  process.env.NX_BUNDLE_DERIVED_DATA ?? "/tmp/nx-cap/itg-build";
const APP_PATH = join(DERIVED, "Build/Products/Release/nexus.app");
const PLIST = join(APP_PATH, "Contents/Info.plist");

// Heavyweight/capability gate. The bare per-push `turbo test` MUST stay fast
// and deterministic — it never sets NEXUS_HEAVY_TESTS, so this whole file
// skips cleanly there regardless of whether a stale derivedData bundle
// happens to linger from a prior pre-push gate run. The gate's
// resource-bearing Tier A path (which has just run the real xcodebuild via
// deploy/check-bundle-integrity.sh) sets NEXUS_HEAVY_TESTS=1 so this
// asserts the freshly-produced bundle.
const heavyEnabled = process.env.NEXUS_HEAVY_TESTS === "1";
const isMac = process.platform === "darwin";
const bundleBuilt = heavyEnabled && isMac && existsSync(PLIST);

/** Read a top-level Info.plist key via PlistBuddy; null if absent. */
async function plistKey(key: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["/usr/libexec/PlistBuddy", "-c", `Print :${key}`, PLIST],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return code === 0 ? out.trim() : null;
}

describe.skipIf(!bundleBuilt)(
  "bundle integrity — produced nexus.app (requires a prior xcodebuild)",
  () => {
    it("the product is named nexus.app", () => {
      expect(existsSync(APP_PATH)).toBe(true);
      expect(APP_PATH.endsWith("/nexus.app")).toBe(true);
    });

    it("Info.plist contains NSAppTransportSecurity (nx-p2zs5 guard)", async () => {
      const ats = await plistKey("NSAppTransportSecurity");
      expect(ats).not.toBeNull();
      // The incident hinged on the cleartext allowance being absent.
      expect(ats).toContain("NSAllowsArbitraryLoads");
    });

    it("Info.plist contains LSUIElement (menu-bar agent guard)", async () => {
      const uiElement = await plistKey("LSUIElement");
      expect(uiElement).not.toBeNull();
      expect(uiElement).toBe("true");
    });
  },
);
