import { watch, type FSWatcher } from "node:fs";
import { parseConfig, type NexusConfig } from "@nexus/core/node";

/**
 * Watch a nexus config file for changes and invoke a callback with the
 * newly-parsed config on each successful reload.
 *
 * Uses a 500ms debounce to prevent duplicate reloads from rapid saves
 * (e.g. editors that write + rename).
 *
 * Returns a cleanup function that stops watching.
 */
export function watchConfig(
  path: string,
  onChange: (config: NexusConfig) => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = () => {
    const result = parseConfig(path);
    if (result.ok) {
      onChange(result.config);
    }
    // Silently skip if the file is temporarily unreadable or invalid —
    // the previous config stays in effect.
  };

  const watcher: FSWatcher = watch(path, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, 500);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
