/**
 * The inspector (PLAN.md §5.3).
 * ARIA's own session, per message of yours: the digest sent with it, the tools it called, its answer. Read from the
 * runtime's session store once when the inspector opens (no model call), held while it's open, kept up to date live.
 */
import type { ConductorTranscript, EngineEvent, TranscriptEntry } from "@aria/protocol";
import { CONDUCTOR_TRANSCRIPT_MAX_TURNS, lastTurns, mergeEntries, startsTurn } from "@aria/protocol";
import { withDigest } from "../attention/digest.ts";
import type { ConductorHandle } from "../runtime/types.ts";
import type { Store } from "../store/store.ts";

/** What the open inspector shows (PLAN.md §5.3): ARIA's session, read once when it opened, plus what came live since. */
interface InspectorHold {
  sessionId: string;
  entries: TranscriptEntry[];
  /** Your messages dropped from the front to keep it bounded (the window says they aren't kept). */
  dropped: number;
  /** Entries that arrived while the history was being read, merged on top of it once it's there. */
  live: TranscriptEntry[] | null;
  ready: Promise<void>;
}

/** Your messages the inspector shows at first and per "Show more". */
const INSPECTOR_TURNS = 30;
/** Your messages looked up to split their digest back out, when the inspector reads the history. */
const DIGEST_LOOKUP = 2000;
/** Prompts sent that the session hasn't shown yet, kept to split live entries. */
const SENT_KEPT = 20;

/** A prompt on its way to ARIA's session. */
export interface SentPrompt {
  prompt: string;
  text: string;
  digest?: string;
}

export interface ConductorInspectorDeps {
  db: () => Store;
  log: (text: string) => void;
  emit: (event: EngineEvent) => void;
  holdTurns: number | undefined;
}

export class ConductorInspector {
  /** Prompts sent to ARIA that its session hasn't shown yet: a live entry of yours is split with the one it matches. */
  private readonly sentPrompts: SentPrompt[] = [];
  /** The runtime recorded a prompt differently from how it was sent (said once per run). */
  private driftLogged = false;
  /** The inspector's view of ARIA's session while it's open. */
  private hold: InspectorHold | undefined;
  /** While ARIA's history is being read: the entries saved live meanwhile, which are newer than what the read gives. */
  private readonly savedWhileReading = new Set<Set<string>>();

  constructor(private readonly deps: ConductorInspectorDeps) {}

  /**
   * The last `turns` of your messages and what followed each. `reload` reads the session again (the inspector opens);
   * otherwise what's held is used ("Show more"). While the conversation reopens (a new prompt), what's held is kept.
   */
  async conductorTranscript(handle: ConductorHandle | undefined, input: { turns?: number | undefined; reload?: boolean | undefined } = {}): Promise<ConductorTranscript> {
    let hold = this.hold;
    if (handle && (input.reload || !hold || hold.sessionId !== handle.sessionId)) hold = this.readConductor(handle);
    else if (!hold) throw new Error("ARIA's conversation isn't open yet. This fills in once ARIA is ready.");
    await hold.ready;
    const { from, before } = lastTurns(hold.entries, input.turns ?? INSPECTOR_TURNS);
    return { sessionId: hold.sessionId, entries: hold.entries.slice(from), omitted: before, notKept: hold.dropped };
  }

  private get holdTurns(): number {
    return Math.min(this.deps.holdTurns ?? CONDUCTOR_TRANSCRIPT_MAX_TURNS, CONDUCTOR_TRANSCRIPT_MAX_TURNS);
  }

  /** The inspector closed: nothing is held anymore. */
  release(): void {
    this.hold = undefined;
  }

  /** What the session reports live. */
  onTranscript(live: TranscriptEntry[], sessionId: string): void {
    // Your messages are matched with what was sent even while nobody looks, so the queue of prompts stays right.
    const entries = this.splitLive(live);
    this.deps.db().queueTranscriptEntries("conductor", entries);
    for (const saved of this.savedWhileReading) for (const entry of entries) saved.add(entry.id);
    // Only while the inspector is open. What came before it opened is in the session's history when it reads it:
    // the runtime sent those events before it got the request to read, so its history has them.
    const hold = this.hold;
    if (!hold) return;
    if (hold.sessionId === sessionId) {
      if (hold.live) hold.live.push(...entries);
      else this.holdEntries(hold, mergeEntries(hold.entries, entries));
    }
    this.deps.emit({ type: "conductor_transcript", sessionId, entries });
  }

  /** A prompt goes to the session: a live entry of yours is split with it when the session shows it. */
  promptSent(sent: SentPrompt): void {
    this.sentPrompts.push(sent);
    if (this.sentPrompts.length > SENT_KEPT) this.sentPrompts.shift();
  }

  /** It never reached the session, so no entry will match it. */
  promptNotSent(sent: SentPrompt): void {
    const at = this.sentPrompts.indexOf(sent);
    if (at >= 0) this.sentPrompts.splice(at, 1);
  }

  private readConductor(handle: ConductorHandle): InspectorHold {
    const hold: InspectorHold = { sessionId: handle.sessionId, entries: [], dropped: 0, live: [], ready: Promise.resolve() };
    this.hold = hold;
    hold.ready = (async () => {
      try {
        const history = await this.readHistory(handle);
        // What arrived live meanwhile is newer than (or the same as) what was read.
        this.holdEntries(hold, mergeEntries(history, hold.live ?? []));
        hold.live = null;
      } catch (error) {
        if (this.hold === hold) this.hold = undefined;
        throw error;
      }
    })();
    return hold;
  }

  /**
   * ARIA's session's history, split, with only what's new or changed in it saved (for search). Live entries are saved
   * as they come, so opening the inspector again writes nothing; it used to write the whole history each time, in one
   * transaction on the main process. An entry saved live while this is read is newer than the read's copy of it (a tool
   * call that finished meanwhile), so that one is kept.
   */
  async readHistory(handle: ConductorHandle): Promise<TranscriptEntry[]> {
    const savedLive = new Set<string>();
    this.savedWhileReading.add(savedLive);
    let history: TranscriptEntry[];
    try {
      history = this.splitHistory(await handle.getTranscript());
    } finally {
      this.savedWhileReading.delete(savedLive);
    }
    const db = this.deps.db();
    const stored = db.storedTranscriptJson("conductor");
    const changed = history.filter((entry) => !savedLive.has(entry.id) && stored.get(entry.id) !== JSON.stringify(entry));
    if (changed.length) db.upsertTranscriptEntries("conductor", changed);
    db.markTranscriptBackfilled("conductor");
    return history;
  }

  /** Keeps at most the last `holdTurns` of your messages (the most the window can ask for); older ones are counted. */
  private holdEntries(hold: InspectorHold, entries: TranscriptEntry[]): void {
    const { from, before } = lastTurns(entries, this.holdTurns);
    hold.entries = before ? entries.slice(from) : entries;
    hold.dropped += before;
  }

  /**
   * Live entries: a message of yours is split with the prompt it was sent as (digest, then your words). One that matches
   * no prompt on its way means the runtime recorded it differently: said once, then looked up like the history.
   */
  private splitLive(entries: TranscriptEntry[]): TranscriptEntry[] {
    return entries.map((entry) => {
      if (entry.kind !== "user" || !startsTurn(entry)) return entry;
      const index = this.sentPrompts.findIndex((s) => s.prompt === entry.text);
      if (index >= 0) {
        const [sent] = this.sentPrompts.splice(index, 1);
        return sent?.digest ? { ...entry, text: sent.text, digest: sent.digest } : entry;
      }
      const looked = this.splitHistory([entry])[0]!;
      if (looked === entry && this.sentPrompts.length > 0 && !this.driftLogged) {
        this.driftLogged = true;
        // Lengths only: the text is yours.
        this.deps.log(
          `ARIA's inspector: the runtime recorded a message differently from how ARIA sent it (${entry.text.length} characters, sent ${this.sentPrompts[0]!.prompt.length}); its <updates> block may show as part of your words.`,
        );
      }
      return looked;
    });
  }

  /** Messages of yours from the session's history, split with the chat items that stored their digest. */
  splitHistory(entries: TranscriptEntry[]): TranscriptEntry[] {
    if (!entries.some((e) => e.kind === "user" && startsTurn(e))) return entries;
    const sent = new Map<string, { text: string; digest: string }>();
    for (const item of this.deps.db().listSentDigests(DIGEST_LOOKUP)) {
      const prompt = withDigest(item.content, item.digest);
      if (item.digest && !sent.has(prompt)) sent.set(prompt, { text: item.content, digest: item.digest });
    }
    return entries.map((entry) => {
      if (entry.kind !== "user" || !startsTurn(entry)) return entry;
      const hit = sent.get(entry.text);
      return hit ? { ...entry, text: hit.text, digest: hit.digest } : entry;
    });
  }
}
