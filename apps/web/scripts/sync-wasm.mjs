/**
 * Copy the committed `ghostty-vt.wasm` from the installed @wterm/ghostty
 * package into `public/` so Next.js serves it at `/ghostty-vt.wasm` (correct
 * `application/wasm` MIME, loadable via `fetch` + `WebAssembly.instantiate`).
 *
 * Runs as `predev` / `prebuild` so the served asset never drifts from the
 * pinned package version. The wasm is also committed to `public/` so the app
 * serves correctly even before an install (e.g. in a fresh checkout preview).
 *
 * No COOP/COEP needed — libghostty's WASM is single-threaded (no
 * SharedArrayBuffer), so plain static serving is sufficient.
 */
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const dest = join(appRoot, "public", "ghostty-vt.wasm");

function resolveWasm() {
  // 1) Standard module resolution from the app root (handles hoisted layouts).
  try {
    const require = createRequire(join(appRoot, "package.json"));
    const pkgJson = require.resolve("@wterm/ghostty/package.json");
    const candidate = join(dirname(pkgJson), "wasm", "ghostty-vt.wasm");
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall through to the pnpm-store probe
  }
  // 2) pnpm strict layout: the real files live under the monorepo store.
  //    node_modules/.pnpm/@wterm+ghostty@<ver>/node_modules/@wterm/ghostty/wasm/…
  const storeRoot = join(appRoot, "..", "..", "node_modules", ".pnpm");
  if (existsSync(storeRoot)) {
    const entries = readdirSync(storeRoot).filter((e) =>
      e.startsWith("@wterm+ghostty@"),
    );
    for (const entry of entries) {
      const candidate = join(
        storeRoot,
        entry,
        "node_modules",
        "@wterm",
        "ghostty",
        "wasm",
        "ghostty-vt.wasm",
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let src;
try {
  src = resolveWasm();
} catch {
  src = null;
}

if (!src) {
  // Not installed yet (or layout changed). If a committed copy already exists
  // we leave it in place; otherwise fail loudly so the build doesn't ship a
  // missing renderer asset.
  if (existsSync(dest)) {
    console.warn(
      "[sync-wasm] @wterm/ghostty not resolved; keeping committed public/ghostty-vt.wasm",
    );
    process.exit(0);
  }
  console.error(
    "[sync-wasm] @wterm/ghostty wasm not found and no committed copy — run `pnpm install`",
  );
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
const size = statSync(dest).size;
console.log(`[sync-wasm] copied ghostty-vt.wasm (${size} bytes) -> public/`);
