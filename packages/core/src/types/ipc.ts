/** Events emitted by the Rust watcher binary over stdout (newline-delimited JSON). */
export type WatcherEvent =
  | { type: "session_start"; session_id: string; project: string; path: string }
  | { type: "session_update"; session_id: string; timestamp: string }
  | { type: "session_end"; session_id: string };

/** Commands sent from the agent to the watcher binary over stdin (newline-delimited JSON). */
export type WatcherCommand =
  | { type: "watch"; paths: string[] }
  | { type: "shutdown" };
