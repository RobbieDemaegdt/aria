/**
 * Plain-code search across session transcripts, tasks, projects, and saved memories (Phase 6A, PLAN.md §5.2, §10 Phase 6A).
 * No model calls, deterministic, and backed by SQLite's `session_transcripts` index (D64).
 */
import { isNoTracker } from "../trackers/none.ts";
import type { TaskTracker } from "../trackers/types.ts";
import type {
  Memory,
  Project,
  SearchMemoryHit,
  SearchProjectHit,
  SearchResults,
  SearchScope,
  SearchTaskHit,
  SearchTranscriptHit,
  Task,
  TaskState,
  TimelineItem,
  TranscriptEntry,
} from "@aria/protocol";

const ACTIVE_STATES: ReadonlySet<TaskState> = new Set([
  "starting",
  "running",
  "waiting_input",
  "waiting_permission",
  "waiting_plan",
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface SearchDeps {
  tracker: () => TaskTracker;
  projects(): Project[];
  tasks(): Task[];
  memories(): Memory[];
  timeline(): TimelineItem[];
  searchTranscriptEntries(
    tokens: readonly string[],
    options?: { ownerIds?: readonly string[]; limit?: number },
  ): { rows: Array<{ ownerId: string; entry: TranscriptEntry }>; total: number };
  hasTranscriptMessage?(ownerId: string, kind: "user" | "assistant", text: string): boolean;
}

export interface SearchQueryOptions {
  query: string;
  scope?: SearchScope;
  repoId?: number;
  limit?: number;
}

export function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function matchesAllTokens(text: string | undefined, tokens: readonly string[]): boolean {
  if (!text || tokens.length === 0) return false;
  const lower = text.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

/** Strips control/invisible characters and collapses runs of whitespace into single spaces. */
function cleanInline(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function buildSnippet(text: string, rawQuery: string, tokens: readonly string[], maxLen = 180): string {
  const flat = cleanInline(text);
  if (!flat) return "";
  if (flat.length <= maxLen) return flat;
  const lower = flat.toLowerCase();
  const phrase = cleanInline(rawQuery).toLowerCase();
  let matchIndex = phrase ? lower.indexOf(phrase) : -1;
  let matchLen = phrase.length;
  if (matchIndex < 0) {
    for (const token of tokens) {
      const idx = lower.indexOf(token);
      if (idx >= 0) {
        matchIndex = idx;
        matchLen = token.length;
        break;
      }
    }
  }
  if (matchIndex < 0) {
    return `${flat.slice(0, maxLen - 1).trimEnd()}…`;
  }
  const half = Math.max(20, Math.floor((maxLen - matchLen) / 2));
  let start = Math.max(0, matchIndex - half);
  const end = Math.min(flat.length, start + maxLen);
  if (end - start < maxLen) {
    start = Math.max(0, end - maxLen);
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return `${prefix}${flat.slice(start, end).trim()}${suffix}`;
}

function newestCardByTask(timeline: readonly TimelineItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind !== "card") continue;
    const payload = item.payload as { taskId?: unknown };
    if (typeof payload.taskId === "string" && !map.has(payload.taskId)) {
      map.set(payload.taskId, item.id);
    }
  }
  return map;
}

function entryDisplaySnippet(entry: TranscriptEntry, rawQuery: string, tokens: readonly string[]): string {
  switch (entry.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return buildSnippet(entry.text, rawQuery, tokens);
    case "tool": {
      const candidates = [
        entry.error ? `${entry.name} → ${entry.error}` : undefined,
        entry.args ? `${entry.name}: ${entry.args}` : undefined,
        entry.result ? `${entry.name} → ${entry.result}` : undefined,
        entry.name,
      ].filter((c): c is string => Boolean(c));
      const best = candidates.find((c) => matchesAllTokens(c, tokens)) ?? candidates.join(" · ");
      return buildSnippet(best, rawQuery, tokens);
    }
    case "question": {
      const text = [entry.question, entry.answer ? `→ ${entry.answer}` : "", ...(entry.choices ?? [])]
        .filter(Boolean)
        .join(" ");
      return buildSnippet(text, rawQuery, tokens);
    }
    case "permission":
      return buildSnippet([entry.detail, entry.reason].filter(Boolean).join(" · "), rawQuery, tokens);
    case "info":
      return buildSnippet([entry.text, entry.detail].filter(Boolean).join(" · "), rawQuery, tokens);
  }
}

export function searchAria(input: SearchQueryOptions, deps: SearchDeps): SearchResults {
  const rawQuery = input.query.trim();
  const tokens = tokenizeQuery(rawQuery);
  const scope: SearchScope = input.scope ?? "all";
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  if (tokens.length === 0) {
    return {
      query: rawQuery,
      projects: [],
      tasks: [],
      transcripts: [],
      memories: [],
      counts: { projects: 0, tasks: 0, transcripts: 0, memories: 0, total: 0 },
    };
  }

  const allProjects = deps.projects().filter((p) => !p.hidden);
  const visibleRepoIds = new Set(allProjects.map((p) => p.id));
  const allTasks = deps.tasks().filter((t) => t.repoId === 0 || visibleRepoIds.has(t.repoId));
  const allMemories = deps.memories().filter((m) => m.scope === "global" || (m.repoId !== undefined && visibleRepoIds.has(m.repoId)));
  const timeline = deps.timeline();
  const taskCardIds = newestCardByTask(timeline);

  // 1. Projects
  const projectMatches: Array<{ hit: SearchProjectHit; rank: number }> = [];
  if (scope === "all" || scope === "projects") {
    const candidates = input.repoId !== undefined ? allProjects.filter((p) => p.id === input.repoId) : allProjects;
    for (const p of candidates) {
      const repoTasks = allTasks.filter((t) => t.repoId === p.id);
      const activeTaskCount = repoTasks.filter((t) => ACTIVE_STATES.has(t.state)).length;
      const latestTask = [...repoTasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const remoteText = [p.owner && p.repo ? `${p.owner}/${p.repo}` : "", p.upstream ?? ""].filter(Boolean).join(" ");
      const repoMemories = allMemories.filter((m) => m.scope === "project" && m.repoId === p.id);
      const combined = [p.name, remoteText, p.path, p.defaultBranch ?? "", ...repoMemories.map((m) => m.text)].join("\n");
      if (!matchesAllTokens(combined, tokens)) continue;

      let matchedField: SearchProjectHit["matchedField"];
      let snippetSource: string;
      let rank: number;
      if (matchesAllTokens(p.name, tokens)) {
        matchedField = "name";
        snippetSource = remoteText ? `${remoteText} · ${p.path}` : p.path;
        rank = p.name.toLowerCase() === rawQuery.toLowerCase() ? 0 : p.name.toLowerCase().startsWith(rawQuery.toLowerCase()) ? 1 : 2;
      } else if (matchesAllTokens(remoteText, tokens)) {
        matchedField = "remote";
        snippetSource = remoteText;
        rank = 2;
      } else if (repoMemories.some((m) => matchesAllTokens(m.text, tokens))) {
        const mem = repoMemories.find((m) => matchesAllTokens(m.text, tokens))!;
        matchedField = "memory";
        snippetSource = mem.text;
        rank = 3;
      } else if (matchesAllTokens(p.defaultBranch, tokens)) {
        matchedField = "branch";
        snippetSource = `Default branch: ${p.defaultBranch}`;
        rank = 3;
      } else if (matchesAllTokens(p.path, tokens)) {
        matchedField = "path";
        snippetSource = p.path;
        rank = 4;
      } else {
        matchedField = "name";
        snippetSource = `${p.name} · ${remoteText || p.path}`;
        rank = 5;
      }

      projectMatches.push({
        rank,
        hit: {
          id: p.id,
          name: p.name,
          path: p.path,
          ...(p.owner ? { owner: p.owner } : {}),
          ...(p.repo ? { repo: p.repo } : {}),
          ...(p.defaultBranch ? { defaultBranch: p.defaultBranch } : {}),
          taskCount: repoTasks.length,
          activeTaskCount,
          ...(latestTask ? { latestTaskId: latestTask.id } : {}),
          matchedField,
          snippet: buildSnippet(snippetSource, rawQuery, tokens),
        },
      });
    }
    projectMatches.sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name));
  }

  // 2. Tasks
  const taskMatches: Array<{ hit: SearchTaskHit; rank: number }> = [];
  if (scope === "all" || scope === "tasks") {
    const candidates = input.repoId !== undefined ? allTasks.filter((t) => t.repoId === input.repoId) : allTasks;
    for (const t of candidates) {
      const qText = t.question ? `${t.question.shortId} ${t.question.question} ${(t.question.choices ?? []).join(" ")}` : "";
      const pText = t.permissions?.length
        ? t.permissions.map((p) => `${p.shortId} ${p.what} ${p.reason} ${p.where ?? ""}`).join(" ")
        : "";
      const planText = t.plan ? `${t.plan.shortId} ${t.plan.summary} ${t.plan.plan ?? ""}` : "";
      const budgetText = t.budgetShortId ? `${t.budgetShortId} paused at budget` : "";
      // With no tracker a task's link to one is nothing to search for.
      const trackerText = t.trackerTaskId && !isNoTracker(deps.tracker()) ? `${deps.tracker().label} #${t.trackerTaskId} ${t.trackerTaskId}` : "";
      const prText = t.pr ? `PR #${t.pr.number} #${t.pr.number} ${t.pr.owner}/${t.pr.repo} ${t.pr.head}` : "";
      const branchText = `${t.branch ?? ""} @${t.slug}`;

      const fieldChecks: Array<{ field: SearchTaskHit["matchedField"]; text: string; rank: number }> = [
        { field: "title", text: t.title, rank: t.title.toLowerCase().includes(rawQuery.toLowerCase()) ? 0 : 1 },
        { field: "question", text: qText, rank: 1 },
        { field: "permission", text: pText, rank: 1 },
        { field: "plan", text: planText, rank: 1 },
        { field: "budget", text: budgetText, rank: 1 },
        { field: "tracker", text: trackerText, rank: 2 },
        { field: "pr", text: prText, rank: 2 },
        { field: "branch", text: branchText, rank: 2 },
        { field: "summary", text: t.summary ?? "", rank: 3 },
        { field: "brief", text: t.brief, rank: 4 },
        { field: "error", text: t.error ?? "", rank: 4 },
      ];

      const direct = fieldChecks.find((c) => matchesAllTokens(c.text, tokens));
      const combined = [
        t.repoName,
        t.profileName,
        t.model,
        ...fieldChecks.map((c) => c.text),
      ].join("\n");
      if (!direct && !matchesAllTokens(combined, tokens)) continue;

      const matchedField = direct?.field ?? "brief";
      const snippetSource =
        direct && direct.field !== "title"
          ? direct.text
          : t.summary || t.brief || t.title;
      const rank = direct?.rank ?? 5;
      const cardId = taskCardIds.get(t.id);

      taskMatches.push({
        rank,
        hit: {
          taskId: t.id,
          title: t.title,
          repoId: t.repoId,
          repoName: t.repoName,
          state: t.state,
          ...(t.branch ? { branch: t.branch } : {}),
          profileName: t.profileName,
          model: t.model,
          ...(t.reasoningEffort ? { reasoningEffort: t.reasoningEffort } : {}),
          ...(t.trackerTaskId && !isNoTracker(deps.tracker()) ? { trackerTaskId: t.trackerTaskId } : {}),
          ...(t.pr ? { prNumber: t.pr.number } : {}),
          updatedAt: t.updatedAt,
          matchedField,
          snippet: buildSnippet(snippetSource, rawQuery, tokens),
          ...(cardId ? { cardId } : {}),
        },
      });
    }
    taskMatches.sort((a, b) => a.rank - b.rank || b.hit.updatedAt - a.hit.updatedAt);
  }

  // 3. Session transcripts (tasks + Conductor)
  const transcriptMatches: SearchTranscriptHit[] = [];
  let totalTranscriptMatches = 0;
  if (scope === "all" || scope === "transcripts") {
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    const taskOwnerIds = (input.repoId !== undefined ? allTasks.filter((t) => t.repoId === input.repoId) : allTasks).map(
      (t) => `task:${t.id}`,
    );
    const ownerIds = input.repoId !== undefined ? taskOwnerIds : [...taskOwnerIds, "conductor"];

    const { rows: rawHits, total: dbTranscriptTotal } = deps.searchTranscriptEntries(tokens, {
      ownerIds,
      limit,
    });
    totalTranscriptMatches = dbTranscriptTotal;

    const chatCardByContent = new Map<string, string>();
    for (const item of timeline) {
      if (item.kind === "chat") {
        chatCardByContent.set(`${item.role}:${item.content.trim()}`, item.id);
      }
    }

    const seenKeys = new Set<string>();
    const seenChatTexts = new Set<string>();

    for (const { ownerId, entry } of rawHits) {
      if (ownerId.startsWith("task:")) {
        const taskId = ownerId.slice("task:".length);
        const task = taskById.get(taskId);
        if (!task) continue;
        if (input.repoId !== undefined && task.repoId !== input.repoId) continue;
        const key = `${ownerId}:${entry.id}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (entry.kind === "user" || entry.kind === "assistant") {
          seenChatTexts.add(`${ownerId}:${entry.kind}:${entry.text.trim().toLowerCase()}`);
        } else if (entry.kind === "question" && entry.answer) {
          seenChatTexts.add(`${ownerId}:user:${entry.answer.trim().toLowerCase()}`);
        }
        const cardId = taskCardIds.get(task.id);
        transcriptMatches.push({
          taskId: task.id,
          sessionTitle: task.title,
          repoId: task.repoId,
          repoName: task.repoName,
          taskState: task.state,
          entryId: entry.id,
          entryKind: entry.kind,
          ...(entry.kind === "tool" ? { toolName: entry.name } : {}),
          at: entry.at,
          snippet: entryDisplaySnippet(entry, rawQuery, tokens),
          ...(cardId ? { cardId } : {}),
        });
      } else if (ownerId === "conductor" && input.repoId === undefined) {
        const key = `conductor:${entry.id}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (entry.kind === "user" || entry.kind === "assistant") {
          seenChatTexts.add(`conductor:${entry.kind}:${entry.text.trim().toLowerCase()}`);
        }
        const cardId =
          entry.kind === "user" || entry.kind === "assistant"
            ? chatCardByContent.get(`${entry.kind}:${entry.text.trim()}`)
            : undefined;
        transcriptMatches.push({
          sessionTitle: "ARIA",
          entryId: entry.id,
          entryKind: entry.kind,
          ...(entry.kind === "tool" ? { toolName: entry.name } : {}),
          at: entry.at,
          snippet: entryDisplaySnippet(entry, rawQuery, tokens),
          ...(cardId ? { cardId } : {}),
        });
      }
    }

    // Also include matching chat timeline items not already in `session_transcripts`.
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (item.kind !== "chat") continue;
      const routedTask = item.routedTo ? taskById.get(item.routedTo.taskId) : undefined;
      if (input.repoId !== undefined && (!routedTask || routedTask.repoId !== input.repoId)) {
        continue;
      }
      const ownerId = routedTask ? `task:${routedTask.id}` : "conductor";
      const sig = `${ownerId}:${item.role}:${item.content.trim().toLowerCase()}`;
      if (seenChatTexts.has(sig)) continue;
      if (!matchesAllTokens(item.content, tokens)) continue;
      if (deps.hasTranscriptMessage?.(ownerId, item.role, item.content)) {
        seenChatTexts.add(sig);
        continue;
      }
      seenChatTexts.add(sig);
      totalTranscriptMatches++;
      if (transcriptMatches.length < limit) {
        transcriptMatches.push({
          ...(routedTask ? { taskId: routedTask.id, repoId: routedTask.repoId, repoName: routedTask.repoName, taskState: routedTask.state } : {}),
          sessionTitle: routedTask ? routedTask.title : "ARIA",
          entryId: item.id,
          entryKind: item.role,
          at: item.createdAt,
          snippet: buildSnippet(item.content, rawQuery, tokens),
          cardId: item.id,
        });
      }
    }

    transcriptMatches.sort((a, b) => b.at - a.at);
  }

  // 4. Memories (global and project-scoped)
  const memoryMatches: SearchMemoryHit[] = [];
  if (scope === "all" || scope === "projects") {
    const candidates =
      input.repoId !== undefined
        ? allMemories.filter((m) => m.scope === "project" && m.repoId === input.repoId)
        : allMemories;
    for (const m of candidates) {
      const text = `${m.repoName ?? "Every project"} ${m.text}`;
      if (!matchesAllTokens(text, tokens)) continue;
      memoryMatches.push({
        id: m.id,
        scope: m.scope,
        ...(m.repoId !== undefined ? { repoId: m.repoId } : {}),
        ...(m.repoName ? { repoName: m.repoName } : {}),
        text: m.text,
        updatedAt: m.updatedAt,
      });
    }
  }

  const projects = projectMatches.slice(0, limit).map((m) => m.hit);
  const tasks = taskMatches.slice(0, limit).map((m) => m.hit);
  const transcripts = transcriptMatches.slice(0, limit);
  const memories = memoryMatches.slice(0, limit);

  return {
    query: rawQuery,
    projects,
    tasks,
    transcripts,
    memories,
    counts: {
      projects: projectMatches.length,
      tasks: taskMatches.length,
      transcripts: totalTranscriptMatches,
      memories: memoryMatches.length,
      total: projectMatches.length + taskMatches.length + totalTranscriptMatches + memoryMatches.length,
    },
  };
}
