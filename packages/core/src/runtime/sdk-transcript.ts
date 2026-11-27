/**
 * Part of the Copilot SDK adapter (with copilot.ts): turns a session's events into transcript entries for the session
 * view and ARIA's inspector (PLAN.md §5.3). The same mapper runs live and over `getEvents()`, so both give the same
 * entries with the same ids (an entry with a known id replaces the earlier one).
 */
import type { TranscriptEntry } from "@aria/protocol";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";

const MAX_TEXT = 4_000;
/** Bookkeeping tools the session view doesn't need to show as steps. */
const HIDDEN_TOOLS = new Set(["report_intent", "task_complete"]);

/**
 * The runtime words an `ask_user` result "User selected: <choice>" or "User responded: <your words>", with the answer
 * after it exactly as given (spike 15): the answer is what follows the one prefix.
 */
const ANSWER_PREFIXES = ["User selected: ", "User responded: "];

function askUserAnswer(content: string): string {
  const prefix = ANSWER_PREFIXES.find((p) => content.startsWith(p));
  return prefix ? content.slice(prefix.length) : content;
}

/** For short lines (a warning, a permission's reason): cut with a marker in the text. */
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

/** For messages and tool text: cut at `max`, with how much was left out in a field of its own (`…Cut`). */
function cut(value: unknown, max: number): { text: string; cut?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > max ? { text: text.slice(0, max), cut: text.length - max } : { text };
}

/** `{ [field]: text, [field + "Cut"]: n }` for a cut, without the count when nothing was left out. */
function withCut<K extends string>(field: K, value: { text: string; cut?: number }): Record<K, string> & Partial<Record<`${K}Cut`, number>> {
  return { [field]: value.text, ...(value.cut ? { [`${field}Cut`]: value.cut } : {}) } as Record<K, string> & Partial<Record<`${K}Cut`, number>>;
}

/** One line saying what a permission request was for. */
export function describePermission(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return `Run ${request.fullCommandText}`;
    case "write":
      return `Write ${request.fileName}`;
    case "read":
      return `Read ${request.path}`;
    case "mcp":
      return `Use ${request.toolName}`;
    case "url":
      return `Open ${request.url}`;
    case "custom-tool":
      return `Use ${request.toolName}`;
    default:
      return `Use ${request.kind}`;
  }
}

export interface MapperOptions {
  /**
   * Where the messages you typed, the answers and the reasoning are cut (default 4,000 characters). ARIA's session
   * keeps them whole (`Infinity`): the inspector matches your messages with what was sent, and shows the answers as
   * the chat does.
   */
  maxMessageText?: number;
  /** Where a tool's arguments, result and error, and what the runtime adds itself, are cut (default 4,000). */
  maxToolText?: number;
  /**
   * A live mapper only remembers what can still change (a tool call until it completes, a question until it's
   * answered, a permission request until it's decided), so a session that runs for months doesn't pile up entries.
   * It has no history: `all()` is for a mapper that read `getEvents()`.
   */
  live?: boolean;
}

export class TranscriptMapper {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly order: string[] = [];

  constructor(private readonly options: MapperOptions = {}) {}

  private get toolMax(): number {
    return this.options.maxToolText ?? MAX_TEXT;
  }

  private get messageMax(): number {
    return this.options.maxMessageText ?? MAX_TEXT;
  }

  /** Applies one event; returns the entries it added or changed. Sub-agent internals stay out of the transcript. */
  apply(event: SessionEvent): TranscriptEntry[] {
    if (event.agentId) return [];
    const at = Date.parse(event.timestamp) || Date.now();
    switch (event.type) {
      case "user.message": {
        // Autopilot's own "continue" nudges aren't something anyone wrote.
        if (event.data.isAutopilotContinuation) return [];
        const source = event.data.source?.trim();
        // What the runtime adds itself can be long (a skill's text): it's cut like a tool's result.
        const text = cut(event.data.content, source ? this.toolMax : this.messageMax)!;
        return this.put({ kind: "user", id: event.id, at, ...withCut("text", text), ...(source ? { source } : {}) });
      }
      case "assistant.message":
        return event.data.content.trim() ? this.put({ kind: "assistant", id: event.data.messageId, at, ...withCut("text", cut(event.data.content, this.messageMax)!) }) : [];
      case "assistant.reasoning":
        return event.data.content.trim() ? this.put({ kind: "reasoning", id: `reasoning-${event.data.reasoningId}`, at, ...withCut("text", cut(event.data.content, this.messageMax)!) }) : [];
      case "tool.execution_start": {
        const name = event.data.toolName;
        if (HIDDEN_TOOLS.has(name)) return [];
        if (name === "ask_user") {
          const args = (event.data.arguments ?? {}) as { question?: unknown; choices?: unknown };
          const choices = Array.isArray(args.choices) ? args.choices.map(String) : undefined;
          return this.put({ kind: "question", id: event.data.toolCallId, at, question: String(args.question ?? ""), ...(choices?.length ? { choices } : {}) }, true);
        }
        const args = cut(event.data.arguments, this.toolMax);
        return this.put(
          {
            kind: "tool",
            id: event.data.toolCallId,
            at,
            name: event.data.mcpServerName ? `${event.data.mcpServerName}/${event.data.mcpToolName ?? name}` : name,
            ...(args ? withCut("args", args) : {}),
          },
          true,
        );
      }
      case "tool.execution_complete": {
        const previous = this.entries.get(event.data.toolCallId);
        if (!previous) return [];
        const output = event.data.result?.content ?? "";
        if (previous.kind === "question") return this.put({ ...previous, answer: clip((output && askUserAnswer(output)) || event.data.error?.message || "") });
        if (previous.kind !== "tool") return [];
        const done = { ...previous, success: event.data.success, ms: Math.max(0, at - previous.at) };
        if (!event.data.success) return this.put({ ...done, ...withCut("error", cut(event.data.error?.message || output || "Failed", this.toolMax)!) });
        const result = cut(output, this.toolMax);
        return this.put(result?.text ? { ...done, ...withCut("result", result) } : done);
      }
      case "permission.requested": {
        const request = event.data.permissionRequest;
        const toolCallId = "toolCallId" in request && typeof request.toolCallId === "string" ? request.toolCallId : undefined;
        return this.put({ kind: "permission", id: event.data.requestId, at, detail: clip(describePermission(request)), ...(toolCallId ? { toolCallId } : {}) }, true);
      }
      case "permission.completed": {
        const previous = this.entries.get(event.data.requestId);
        if (!previous || previous.kind !== "permission") return [];
        const result = event.data.result as { kind: string; feedback?: string; message?: string };
        const reason = result.feedback ?? result.message;
        const toolCallId = previous.toolCallId ?? event.data.toolCallId;
        return this.put({ ...previous, approved: result.kind.startsWith("approved"), ...(reason ? { reason: clip(reason) } : {}), ...(toolCallId ? { toolCallId } : {}) });
      }
      case "session.task_complete":
        return this.put({ kind: "info", id: event.id, at, level: "info", text: clip(`Finished${event.data.summary ? `: ${event.data.summary}` : ""}`) });
      case "session.model_change":
        return this.put({
          kind: "info",
          id: event.id,
          at,
          level: event.data.cause ? "warning" : "info",
          text: `Model: ${event.data.previousModel ? `${event.data.previousModel} → ` : ""}${event.data.newModel}${event.data.reasoningEffort ? ` · ${event.data.reasoningEffort}` : ""}${event.data.cause ? ` (${event.data.cause.replace(/_/g, " ")})` : ""}`,
        });
      case "session.compaction_complete": {
        // An infinite session summarizes its older messages on its own: that's why it no longer knows a detail.
        const data = event.data;
        if (!data.success) {
          return this.put({ kind: "info", id: event.id, at, level: "warning", text: clip(`The session tried to summarize its older messages to make room, and that failed${data.error ? `: ${data.error}` : "."}`) });
        }
        const removed = data.messagesRemoved ? ` (${data.messagesRemoved} earlier messages: yours, the answers and the tool calls)` : "";
        const summary = data.summaryContent?.trim() ? cut(data.summaryContent.trim(), this.toolMax) : undefined;
        return this.put({
          kind: "info",
          id: event.id,
          at,
          level: "info",
          text: `The session summarized its older messages to make room${removed}. From here on the model works from the summary, not the details.`,
          ...(summary ? withCut("detail", summary) : {}),
        });
      }
      case "session.warning":
        return this.put({ kind: "info", id: event.id, at, level: "warning", text: clip(event.data.message) });
      case "session.error":
        return this.put({ kind: "info", id: event.id, at, level: "error", text: clip(event.data.message) });
      default:
        return [];
    }
  }

  all(): TranscriptEntry[] {
    if (this.options.live) throw new Error("A live transcript mapper keeps no history");
    return this.order.map((id) => this.entries.get(id)!);
  }

  /** What a live mapper still remembers (entries that can change), or everything a history mapper read. */
  get tracked(): number {
    return this.entries.size;
  }

  /** `open`: the entry can still change (a later event completes it). */
  private put(entry: TranscriptEntry, open = false): TranscriptEntry[] {
    if (this.options.live) {
      if (open) this.entries.set(entry.id, entry);
      else this.entries.delete(entry.id);
      return [entry];
    }
    if (!this.entries.has(entry.id)) this.order.push(entry.id);
    this.entries.set(entry.id, entry);
    return [entry];
  }
}
