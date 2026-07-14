import { describe, it, expect, beforeEach } from "bun:test";
import net from "node:net";

import { disableHappyEyeballs } from "./net-autoselect-family";

/**
 * Regression guard for nx-veo5g.5 — the agent crashed ~4x/18h on the homelab
 * with an uncaught
 *   TypeError: null is not an object (evaluating 'context')
 *     at internalConnectMultipleTimeout (node:net:...)
 * That frame is Bun's node:net "Happy Eyeballs" (autoSelectFamily) multi-address
 * connection-racing timeout callback (oven-sh/bun#24374). The race path is only
 * scheduled when autoSelectFamily is true, so disabling it process-wide removes
 * the crash path. This test proves disableHappyEyeballs() flips the real global.
 */
type NetWithFamilyDefault = typeof net & {
  getDefaultAutoSelectFamily(): boolean;
  setDefaultAutoSelectFamily(value: boolean): void;
};

const netFamily = net as NetWithFamilyDefault;

describe("disableHappyEyeballs", () => {
  beforeEach(() => {
    // Re-enable so each test starts from the Bun/Node default (true) and we
    // prove the function actually flips it (the module self-invokes on import).
    netFamily.setDefaultAutoSelectFamily(true);
  });

  it("disables autoSelectFamily process-wide", () => {
    expect(netFamily.getDefaultAutoSelectFamily()).toBe(true);

    disableHappyEyeballs();

    expect(netFamily.getDefaultAutoSelectFamily()).toBe(false);
  });

  it("is idempotent (safe to call more than once)", () => {
    disableHappyEyeballs();
    disableHappyEyeballs();

    expect(netFamily.getDefaultAutoSelectFamily()).toBe(false);
  });
});
