import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

/**
 * Browser barrel safety test.
 *
 * Asserts that `packages/core/src/index.ts` (the browser-safe barrel) does
 * not pull in any `node:*` built-in modules — either directly or through
 * transitive imports.
 *
 * Approach: bundle the entry point with `target: "browser"` and
 * `external: ["node:*"]`. When a `node:*` module is reachable, Bun leaves it
 * as an ES import statement in the output. Scanning the bundle text for those
 * import/require references is a reliable, zero-dependency static-analysis
 * check.
 *
 * Complementary to the ESLint guard added in task 1.4: the ESLint rule
 * catches obvious direct imports from `./node` inside `index.ts`; this test
 * catches transitive leaks where a newly-added re-export happens to pull in a
 * node-only module deeper in the graph.
 */
describe("browser barrel safety", () => {
  test("does not import node:* builtins (direct or transitive)", async () => {
    const entrypoint = resolve(import.meta.dir, "index.ts");

    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      // Mark every node: builtin as external. If any are reachable from the
      // browser barrel, Bun will preserve them as import/require statements in
      // the bundle output — making them detectable via text search.
      external: ["node:*"],
    });

    expect(result.success).toBe(true);

    const outputs = await Promise.all(result.outputs.map((o) => o.text()));
    const bundleText = outputs.join("\n");

    // Collect any node: references Bun left as external imports
    const fromImports = [...bundleText.matchAll(/from\s+["'](node:[^"']+)["']/g)].map(
      (m) => m[1],
    );
    const requireImports = [...bundleText.matchAll(/require\(["'](node:[^"']+)["']\)/g)].map(
      (m) => m[1],
    );

    const nodeBuiltins = [...new Set([...fromImports, ...requireImports])];

    expect(nodeBuiltins).toEqual(
      // Provide a clear failure message listing which builtins leaked in
      [],
    );
  });
});
