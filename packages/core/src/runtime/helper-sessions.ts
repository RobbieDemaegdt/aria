import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.ts";
import type { AgentRuntime } from "./types.ts";

/** The short-lived sessions ARIA makes to check your setup and to sign in, by id, so a crash can't leave them behind. */
const HELPERS_KEY = "integrations.helpers";
const HELPER_PREFIX = "aria-integrations-";

export class HelperSessions {
  constructor(private readonly deps: { db: () => Store; isOpen: () => boolean; runtime: AgentRuntime; stopped: () => boolean }) {}

  private helpers(): string[] {
    const stored = this.deps.db().getSetting<unknown>(HELPERS_KEY);
    // The newest 50: a new one is always swept, even when old ones keep failing to delete.
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string" && id.startsWith(HELPER_PREFIX)).slice(-50) : [];
  }

  /**
   * A helper session's id, noted before it exists, so one a crash left behind is deleted at the next start. 44
   * characters: the runtime sends a sign-in session's id to Microsoft's sign-in page as `client_session`, which takes
   * 20 to 50 letters, digits and `-._~` (a 56-character id was refused, AADSTS901001; spike 16).
   */
  helperId(): string {
    const id = `${HELPER_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.deps.db().setSetting(HELPERS_KEY, [...this.helpers(), id]);
    return id;
  }

  helperDone(id: string): void {
    if (this.deps.isOpen()) this.deps.db().setSetting(HELPERS_KEY, this.helpers().filter((other) => other !== id));
  }

  /** Deletes the helper sessions a crash left behind. One that fails to delete stays noted (unless it doesn't exist) for the next start. */
  async sweepHelpers(): Promise<void> {
    for (const id of this.helpers()) {
      if (this.deps.stopped()) return;
      const gone = await this.deps.runtime.deleteSession(id).then(
        () => true,
        // Never created (a crash before it opened): nothing to delete. Can't tell: try again next time.
        () => this.deps.runtime.sessionExists(id).then((exists) => !exists, () => false),
      );
      if (gone) this.helperDone(id);
    }
  }
}
