/** Events emitted by the Rust watcher binary over stdout (newline-delimited JSON). */
export type WatcherEvent =
  | {
      type: "session_start";
      session_id: string;
      project: string;
      path: string;
      /**
       * CC's raw hook session id (universe 2), threaded through from the
       * socket event so it lands in the SAME insert that creates the row
       * (fix-ccsessionid-bridge race fix, nx-22xz8) — see
       * `session-manager.ts`'s `session_start` case.
       */
      cc_session_id?: string;
    }
  | { type: "session_update"; session_id: string; timestamp: string }
  | { type: "session_end"; session_id: string };

/** Commands sent from the agent to the watcher binary over stdin (newline-delimited JSON). */
export type WatcherCommand =
  | { type: "watch"; paths: string[] }
  | { type: "shutdown" };
