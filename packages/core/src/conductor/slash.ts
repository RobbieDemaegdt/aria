/**
 * Deterministic slash commands in the chat and Quick prompt bar (Phase 6C, PLAN.md §5.5, §10 Phase 6C):
 * `/status`, `/tasks`, `/watch`, `/focus`, `/pause-all`, `/budget`.
 * Runs in plain code with zero model calls (except `/watch <new target>`, which rewrites to a Conductor watch prompt).
 */
import type {
  AttentionSettings,
  ConductorStatus,
  DailyBudgetState,
  DiscoveredAgentItem,
  DiscoveredSkillItem,
  DoctorReport,
  GitHubState,
  ReleaseNoteEntry,
  Reminder,
  Task,
  TodayTimeSummary,
  Watch,
} from "@aria/protocol";
import { formatDoctorMarkdown } from "../doctor/doctor.ts";
import { RELEASES } from "../releases/releases.ts";
import type { PendingItem } from "../tasks/manager.ts";
import { isNoTracker } from "../trackers/none.ts";
import type { TaskTracker } from "../trackers/types.ts";

export type SlashCommandName =
  | "/status"
  | "/tasks"
  | "/watch"
  | "/focus"
  | "/pause-all"
  | "/budget"
  | "/agents"
  | "/skills"
  | "/doctor"
  | "/tracker"
  | "/setup"
  | "/tour"
  | "/whats-new";

export interface SlashCommandSpec {
  command: SlashCommandName;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    command: "/status",
    usage: "/status",
    description: "Show ARIA status, active tasks, waiting items, watches and reminders",
  },
  {
    command: "/tasks",
    usage: "/tasks [running | waiting | done | failed | project]",
    description: "List background tasks, their state, branch and credit usage",
  },
  {
    command: "/watch",
    usage: "/watch [list | stop W-n | target]",
    description: "List active GitHub watches, stop a watch, or ask ARIA to watch a target",
  },
  {
    command: "/focus",
    usage: "/focus [on | off]",
    description: "Toggle Focus mode (only blocking items toast while away)",
  },
  {
    command: "/pause-all",
    usage: "/pause-all",
    description: "Stop all running and queued background tasks",
  },
  {
    command: "/budget",
    usage: "/budget [+credits] [B-n | @task] | /budget daily <credits | off>",
    description: "Show task and daily credit budgets, add credits to a paused task, or set a daily cap",
  },
  {
    command: "/agents",
    usage: "/agents [filter | @task <agent | default>]",
    description: "List installed agents, or switch a task's agent (/agents @task <agent>)",
  },
  {
    command: "/skills",
    usage: "/skills [filter]",
    description: "List installed built-in, personal, project, and plugin skills",
  },
  {
    command: "/doctor",
    usage: "/doctor",
    description: "Check Copilot CLI, runtime, git worktrees, GitHub CLI and MCP integrations",
  },
  {
    command: "/tracker",
    usage: "/tracker [none | default | config id]",
    description: "Show the task tracker configs and the active tracker, or switch between them",
  },
  {
    command: "/setup",
    usage: "/setup",
    description: "Open the Getting Started & configuration checklist",
  },
  {
    command: "/tour",
    usage: "/tour",
    description: "Start the interactive 1-minute GUI tour of ARIA",
  },
  {
    command: "/whats-new",
    usage: "/whats-new",
    description: "Show new features and bug fixes in this version of ARIA",
  },
];

const STOPPABLE_STATES = new Set<Task["state"]>([
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_permission",
  "waiting_plan",
]);

const ACTIVE_OR_WAITING_STATES = new Set<Task["state"]>([
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_permission",
  "waiting_plan",
  "waiting_budget",
  "interrupted",
]);

export interface SlashCommandDeps {
  tracker(): TaskTracker;
  status(): ConductorStatus;
  attention(): AttentionSettings;
  setFocusMode(focusMode: boolean): AttentionSettings;
  tasks(): Task[];
  pendingItems(): PendingItem[];
  cancelTask(taskId: string): Promise<void>;
  continueBudget(ref: string, addCredits: number): Task;
  watches(): Watch[];
  github(): GitHubState;
  unwatch(ref: string): Watch;
  reminders(): Reminder[];
  todayTime(): TodayTimeSummary | undefined;
  dailyBudget?(): DailyBudgetState;
  setDailyBudget?(credits: number | null): DailyBudgetState;
  agents?(): DiscoveredAgentItem[];
  setTaskAgent?(ref: string, agent: string | null): Promise<Task>;
  skills?(): DiscoveredSkillItem[];
  runDoctor?(): Promise<DoctorReport>;
  /** `/tracker` with what follows it: lists the tracker configs, or switches (the reply says which). */
  trackerCommand?(arg: string): string;
  releases?(): readonly ReleaseNoteEntry[];
  appVersion?(): string;
}

export type SlashCommandOutcome =
  | { handled: false; rewritePrompt?: string }
  | { handled: true; command: SlashCommandName; reply: string; digestLine?: string };

function formatCredits(n: number): string {
  return `${Number(n.toFixed(2))} cr`;
}

function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

export async function executeSlashCommand(
  rawText: string,
  deps: SlashCommandDeps,
): Promise<SlashCommandOutcome> {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      "Unknown slash command. Available commands: /status, /tasks, /watch, /focus, /pause-all, /budget.",
    );
  }
  const word = match[1]!.toLowerCase();
  const arg = (match[2] ?? "").trim();

  switch (word) {
    case "status": {
      const st = deps.status();
      const att = deps.attention();
      const tasks = deps.tasks();
      const pending = deps.pendingItems();
      const watches = deps.watches().filter((w) => w.state === "active" && w.kind !== "inbox");
      const reminders = deps.reminders().filter((r) => r.status === "fired");
      const today = deps.todayTime();

      const running = tasks.filter((t) => t.state === "running" || t.state === "starting");
      const queued = tasks.filter((t) => t.state === "queued");
      const waiting = tasks.filter((t) =>
        ["waiting_input", "waiting_permission", "waiting_plan", "waiting_budget", "interrupted"].includes(t.state),
      );

      const modelInfo = st.model ? `${st.model}${st.reasoningEffort ? ` · ${st.reasoningEffort}` : ""}` : "default";
      const lines: string[] = [
        `**ARIA status:** ${st.state} (${modelInfo}) · **Focus mode:** ${att.focusMode ? "on" : "off"}`,
        `**Tasks:** ${running.length} running, ${waiting.length} waiting on you, ${queued.length} queued (${tasks.length} total)`,
      ];
      if (pending.length > 0) {
        lines.push(
          `**Waiting on you (${pending.length}):**\n` +
            pending.map((p) => `- **${p.shortId}** · ${p.title} (${p.repoName}): ${p.text}`).join("\n"),
        );
      }
      if (watches.length > 0) {
        lines.push(
          `**Active watches (${watches.length}):** ` +
            watches.map((w) => `${w.shortId} (${w.title}${w.repoName ? ` · ${w.repoName}` : ""})`).join(", "),
        );
      }
      if (reminders.length > 0) {
        lines.push(
          `**Reminders due (${reminders.length}):** ` +
            reminders.map((r) => `${r.shortId} "${r.text}"`).join(", "),
        );
      }
      if (today) {
        lines.push(
          `**Today's time (${today.date}):** ${formatMinutes(today.dayTotalMinutes)} of ${formatMinutes(today.expectedMinutes)} (${formatMinutes(today.registeredMinutes)} registered, ${formatMinutes(today.draftMinutes)} draft)`,
        );
      }
      return {
        handled: true,
        command: "/status",
        reply: lines.join("\n\n"),
      };
    }

    case "tasks": {
      const all = deps.tasks();
      if (all.length === 0) {
        return {
          handled: true,
          command: "/tasks",
          reply: "No background tasks yet.",
        };
      }
      const q = arg.toLowerCase();
      let filtered: typeof all;
      if (q) {
        if (q === "active" || q === "running") {
          filtered = all.filter((t) => t.state === "running" || t.state === "starting");
        } else if (q === "waiting" || q === "needs-you" || q === "needs you") {
          filtered = all.filter((t) =>
            ["waiting_input", "waiting_permission", "waiting_plan", "waiting_budget", "interrupted"].includes(t.state),
          );
        } else {
          filtered = all.filter(
            (t) =>
              t.state.toLowerCase() === q ||
              t.title.toLowerCase().includes(q) ||
              t.repoName.toLowerCase().includes(q) ||
              `@${t.slug.toLowerCase()}` === q ||
              t.slug.toLowerCase().includes(q),
          );
        }
      } else {
        const active = all.filter((t) => ACTIVE_OR_WAITING_STATES.has(t.state));
        const finished = all.filter((t) => !ACTIVE_OR_WAITING_STATES.has(t.state));
        filtered = [...active, ...finished.slice(0, 10)];
      }

      if (filtered.length === 0) {
        return {
          handled: true,
          command: "/tasks",
          reply: `No tasks matching "${arg}".`,
        };
      }

      const rows = filtered.map((t) => {
        const shortWait =
          t.question?.shortId ??
          t.permissions?.[0]?.shortId ??
          t.plan?.shortId ??
          t.budgetShortId;
        const stateLabel = shortWait ? `${t.state.replace(/_/g, " ")} (${shortWait})` : t.state.replace(/_/g, " ");
        const budgetPart = t.budgetCredits ? `${formatCredits(t.costCredits)} / ${formatCredits(t.budgetCredits)}` : formatCredits(t.costCredits);
        const agentPart = t.agent ? ` · agent: \`${t.agent}\`` : "";
        return `- **${t.title}** (\`@${t.slug}\` · ${t.repoName}) — **${stateLabel}** · ${t.profileName} (${t.model}${t.reasoningEffort ? ` · ${t.reasoningEffort}` : ""})${agentPart} · ${budgetPart}`;
      });
      const omitted = !q && all.length > filtered.length ? `\n\n*(…and ${all.length - filtered.length} older finished task${all.length - filtered.length === 1 ? "" : "s"})*` : "";
      return {
        handled: true,
        command: "/tasks",
        reply: `**Tasks (${filtered.length}${!q && all.length > filtered.length ? ` of ${all.length}` : ""}):**\n${rows.join("\n")}${omitted}`,
      };
    }

    case "watch": {
      if (!arg || arg.toLowerCase() === "list") {
        const gh = deps.github();
        const active = deps.watches().filter((w) => w.state === "active" && w.kind !== "inbox");
        const ghLine =
          gh.status === "ok"
            ? `GitHub connected${gh.login ? ` as @${gh.login}` : ""} · Inbox watch: ${gh.inbox ? "on" : "off"}`
            : `GitHub status: ${gh.status}${gh.message ? ` (${gh.message})` : ""}`;
        if (active.length === 0) {
          return {
            handled: true,
            command: "/watch",
            reply: `**Active watches:** none.\n${ghLine}`,
          };
        }
        const list = active.map(
          (w) => `- **${w.shortId}** · ${w.title}${w.repoName ? ` (${w.repoName})` : ""} — ${w.status}`,
        );
        return {
          handled: true,
          command: "/watch",
          reply: `**Active watches (${active.length}):**\n${list.join("\n")}\n\n${ghLine}`,
        };
      }

      const stopMatch = /^(?:stop|off|unwatch)\s+([\s\S]+)$/i.exec(arg);
      if (stopMatch) {
        const ref = stopMatch[1]!.trim();
        const ended = deps.unwatch(ref);
        return {
          handled: true,
          command: "/watch",
          reply: `Stopped watching **${ended.shortId}** (${ended.title}${ended.repoName ? ` · ${ended.repoName}` : ""}).`,
        };
      }

      return {
        handled: false,
        rewritePrompt: `Watch ${arg}`,
      };
    }

    case "focus": {
      const modeArg = arg.toLowerCase();
      const current = deps.attention().focusMode;
      let next: boolean;
      if (!modeArg || modeArg === "toggle") {
        next = !current;
      } else if (modeArg === "on" || modeArg === "true" || modeArg === "1") {
        next = true;
      } else if (modeArg === "off" || modeArg === "false" || modeArg === "0") {
        next = false;
      } else {
        throw new Error("Usage: /focus [on | off]");
      }
      deps.setFocusMode(next);
      return {
        handled: true,
        command: "/focus",
        reply: next
          ? "Focus mode is **on**: only blocking items (questions, approvals, plans, budget pauses, failures and reminders) toast while you're away."
          : "Focus mode is **off**: finished tasks and GitHub milestones will also toast while you're away.",
        digestLine: `[slash] You turned Focus mode ${next ? "on" : "off"} with /focus.`,
      };
    }

    case "pause-all": {
      const toStop = deps.tasks().filter((t) => STOPPABLE_STATES.has(t.state));
      if (toStop.length === 0) {
        return {
          handled: true,
          command: "/pause-all",
          reply: "No running or queued tasks to stop.",
        };
      }
      await Promise.all(toStop.map((t) => deps.cancelTask(t.id)));
      const names = toStop.map((t) => `**${t.title}** (${t.repoName})`).join(", ");
      return {
        handled: true,
        command: "/pause-all",
        reply: `Stopped ${toStop.length} task${toStop.length === 1 ? "" : "s"}: ${names}.`,
        digestLine: `[slash] You stopped ${toStop.length} task${toStop.length === 1 ? "" : "s"} with /pause-all (${toStop.map((t) => `"${t.title}"`).join(", ")}).`,
      };
    }

    case "budget": {
      const tasks = deps.tasks();
      const daily = deps.dailyBudget?.();
      const warnPct = daily?.budgetWarningPercent ?? 80;

      const formatDailyLine = (d: DailyBudgetState): string => {
        if (d.dailyBudgetCredits && d.dailyBudgetCredits > 0) {
          const pct = Math.round((d.usedCredits / d.dailyBudgetCredits) * 100);
          const badge = d.limitReached
            ? " · ⚠️ **daily budget reached**"
            : d.warningReached
              ? " · ⚠️ **near daily budget**"
              : "";
          return `**Today's AI credits (${d.date}):** ${formatCredits(d.usedCredits)} / ${formatCredits(d.dailyBudgetCredits)} daily budget (${pct}%)${badge}`;
        }
        return `**Today's AI credits (${d.date}):** ${formatCredits(d.usedCredits)} (no daily cap — set one with \`/budget daily <credits>\`)`;
      };

      if (!arg) {
        if (tasks.length === 0) {
          const baseReply = "No tasks yet (0 AI credits used).";
          return {
            handled: true,
            command: "/budget",
            reply: daily ? `${formatDailyLine(daily)}\n\n${baseReply}` : baseReply,
          };
        }
        const totalCredits = tasks.reduce((sum, t) => sum + t.costCredits, 0);
        const paused = tasks.filter((t) => t.state === "waiting_budget");
        const lines: string[] = [];
        if (daily) {
          lines.push(formatDailyLine(daily));
        }
        lines.push(
          `**Total AI credits across ${tasks.length} task${tasks.length === 1 ? "" : "s"}:** ${formatCredits(totalCredits)}`,
        );
        if (paused.length > 0) {
          lines.push(
            `**Paused at budget (${paused.length}):**\n` +
              paused
                .map(
                  (t) =>
                    `- **${t.budgetShortId ?? `@${t.slug}`}** · **${t.title}** (${t.repoName}): ${formatCredits(t.costCredits)} of ${formatCredits(t.budgetCredits ?? 0)} — type \`/budget +${Math.max(1, t.budgetCredits ?? 5)} ${t.budgetShortId ?? `@${t.slug}`}\` to continue`,
                )
                .join("\n"),
          );
        }
        const top = tasks.slice(0, 10).map((t) => {
          const cap = t.budgetCredits ? `${formatCredits(t.costCredits)} / ${formatCredits(t.budgetCredits)}` : `${formatCredits(t.costCredits)} (no cap)`;
          const nearBudget =
            t.budgetCredits !== undefined &&
            t.budgetCredits > 0 &&
            t.costCredits >= (t.budgetCredits * warnPct) / 100;
          const warnBadge = nearBudget ? " · ⚠️ near budget" : "";
          return `- **${t.title}** (\`@${t.slug}\` · ${t.repoName}): ${cap}${warnBadge} · ${t.state.replace(/_/g, " ")}`;
        });
        lines.push(`**Recent tasks:**\n${top.join("\n")}`);
        return {
          handled: true,
          command: "/budget",
          reply: lines.join("\n\n"),
        };
      }

      const dailyMatch = /^daily(?:\s+([\s\S]*))?$/i.exec(arg);
      if (dailyMatch) {
        const rawVal = (dailyMatch[1] ?? "").trim();
        if (!rawVal) {
          throw new Error("Usage: /budget daily <credits | off>");
        }
        if (/^(?:off|clear|none|disable|disabled|0)$/i.test(rawVal)) {
          deps.setDailyBudget?.(null);
          return {
            handled: true,
            command: "/budget",
            reply: "Cleared the daily AI credit budget.",
            digestLine: "[slash] You cleared your daily AI credit budget with /budget.",
          };
        }
        const cleaned = rawVal.replace(/^\+/, "").replace(/\s*(?:credits?|cr)$/i, "").trim();
        const dailyCredits = Number(cleaned);
        if (!Number.isFinite(dailyCredits) || dailyCredits < 0.1 || dailyCredits > 100_000) {
          throw new Error("Daily budget must be between 0.1 and 100,000 AI credits, or `off`.");
        }
        const updatedDaily = deps.setDailyBudget?.(dailyCredits);
        const usedToday = updatedDaily ? formatCredits(updatedDaily.usedCredits) : "0 cr";
        return {
          handled: true,
          command: "/budget",
          reply: `Set daily AI credit budget to **${formatCredits(dailyCredits)}** (today: ${usedToday} / ${formatCredits(dailyCredits)}).`,
          digestLine: `[slash] You set your daily AI credit budget to ${dailyCredits} credits with /budget.`,
        };
      }

      // Parse `/budget +5`, `/budget +5 B-1`, `/budget B-1 +5`, `/budget @slug 5`
      const tokens = arg.split(/\s+/).filter(Boolean);
      const creditIdx = tokens.findIndex((tok) => /^\+?\d+(?:\.\d+)?$/.test(tok));
      if (creditIdx < 0) {
        throw new Error("Usage: /budget [+credits] [B-n | @task] (for example `/budget +5` or `/budget B-1 +5`).");
      }
      const addCredits = Number(tokens[creditIdx]!.replace(/^\+/, ""));
      if (!Number.isFinite(addCredits) || addCredits <= 0 || addCredits > 10_000) {
        throw new Error("Credits to add must be between 0.01 and 10,000.");
      }
      const targetRef = tokens
        .filter((_, idx) => idx !== creditIdx && !/^credits?$|^cr$/i.test(tokens[idx]!))
        .join(" ")
        .trim();

      let targetTask: Task;
      if (targetRef) {
        targetTask = deps.continueBudget(targetRef, addCredits);
      } else {
        const paused = tasks.filter((t) => t.state === "waiting_budget");
        if (paused.length === 0) {
          throw new Error("No tasks are currently paused at their budget.");
        }
        if (paused.length > 1) {
          const list = paused.map((t) => `${t.budgetShortId ?? `@${t.slug}`} ("${t.title}")`).join(", ");
          throw new Error(
            `Multiple tasks are paused at their budget (${list}). Specify which one, e.g. \`/budget +${addCredits} ${paused[0]!.budgetShortId ?? `@${paused[0]!.slug}`}\`.`,
          );
        }
        targetTask = deps.continueBudget(paused[0]!.id, addCredits);
      }

      return {
        handled: true,
        command: "/budget",
        reply: `Added **+${formatCredits(addCredits)}** to **${targetTask.title}** (${targetTask.repoName}); it continues (new budget: ${formatCredits(targetTask.budgetCredits ?? addCredits)}).`,
      };
    }

    case "agents": {
      const all = deps.agents?.() ?? [];
      const switchMatch = /^(?:set\s+)?@([\w.-]+)\s+([\s\S]+)$/i.exec(arg);
      if (switchMatch && deps.setTaskAgent) {
        const taskRef = `@${switchMatch[1]!}`;
        const rawAgent = switchMatch[2]!.trim();
        let nextAgent: string | null;
        if (/^(?:default|none|off|clear|reset)$/i.test(rawAgent)) {
          nextAgent = null;
        } else {
          const lower = rawAgent.toLowerCase();
          const exact = all.find((a) => a.id.toLowerCase() === lower || a.name.toLowerCase() === lower);
          nextAgent = exact ? exact.id : rawAgent;
        }
        const updated = await deps.setTaskAgent(taskRef, nextAgent);
        return {
          handled: true,
          command: "/agents",
          reply: updated.agent
            ? `Switched **${updated.title}** (\`@${updated.slug}\` · ${updated.repoName}) to agent **\`${updated.agent}\`**.`
            : `Reset **${updated.title}** (\`@${updated.slug}\` · ${updated.repoName}) to the **default coding agent**.`,
          digestLine: `[slash] You switched "${updated.title}" (${updated.repoName}) to ${updated.agent ? `agent ${updated.agent}` : "the default coding agent"} with /agents.`,
        };
      }
      if (all.length === 0) {
        return {
          handled: true,
          command: "/agents",
          reply: "No custom or plugin agents discovered yet. Open **Customize › Integrations** to refresh or install plugins from a marketplace.",
        };
      }
      const q = arg.toLowerCase();
      const filtered = q
        ? all.filter(
            (a) =>
              a.id.toLowerCase().includes(q) ||
              a.name.toLowerCase().includes(q) ||
              a.displayName.toLowerCase().includes(q) ||
              a.description.toLowerCase().includes(q) ||
              (a.source ?? "").toLowerCase().includes(q),
          )
        : all;
      if (filtered.length === 0) {
        return {
          handled: true,
          command: "/agents",
          reply: `No agents matching "${arg}".`,
        };
      }
      const rows = filtered.map(
        (a) =>
          `- **${a.displayName || a.name}** (\`${a.id}\`${a.source ? ` · ${a.source}` : ""})${a.description ? ` — ${a.description}` : ""}`,
      );
      return {
        handled: true,
        command: "/agents",
        reply:
          `**Installed agents (${filtered.length}${q ? ` of ${all.length}` : ""}):**\n${rows.join("\n")}\n\n` +
          `*Tip: Switch a task's agent with \`/agents @task <agent-id | default>\`, pick one in the session view or **+ New session**, or tell ARIA in chat.*`,
      };
    }

    case "skills": {
      const all = deps.skills?.() ?? [];
      if (all.length === 0) {
        return {
          handled: true,
          command: "/skills",
          reply: "No skills discovered yet. Open **Customize › Integrations** to refresh or install plugins.",
        };
      }
      const q = arg.toLowerCase();
      const filtered = q
        ? all.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q) ||
              s.source.toLowerCase().includes(q) ||
              (s.pluginName ?? "").toLowerCase().includes(q),
          )
        : all;
      if (filtered.length === 0) {
        return {
          handled: true,
          command: "/skills",
          reply: `No skills matching "${arg}".`,
        };
      }
      const rows = filtered.map(
        (s) =>
          `- **${s.name}** (${s.pluginName ? `plugin: ${s.pluginName}` : s.source} · ${s.enabled ? "enabled" : "disabled"})${s.description ? ` — ${s.description}` : ""}`,
      );
      return {
        handled: true,
        command: "/skills",
        reply: `**Installed skills (${filtered.length}${q ? ` of ${all.length}` : ""}):**\n${rows.join("\n")}`,
      };
    }

    case "doctor": {
      if (!deps.runDoctor) {
        return {
          handled: true,
          command: "/doctor",
          reply: "Doctor check is not available in this session.",
        };
      }
      const report = await deps.runDoctor();
      return {
        handled: true,
        command: "/doctor",
        reply: formatDoctorMarkdown(report),
      };
    }

    case "tracker": {
      return {
        handled: true,
        command: "/tracker",
        reply: deps.trackerCommand ? deps.trackerCommand(arg) : "Task tracker configs are not available in this session.",
      };
    }

    case "setup": {
      return {
        handled: true,
        command: "/setup",
        reply:
          "**Getting Started & Setup Checklist**\n" +
          "1. **Copilot CLI & Models** (*Required*): Run `copilot` once in a terminal to sign in, then pick your Conductor model and Worker profiles in **Customize › Models**.\n" +
          "2. **Projects** (*Required*): Auto-scanned from `~/Documents/GitHub`, or click **+** next to **PROJECTS** in the sidebar.\n" +
          "3. **GitHub CLI (`gh`)** (*Recommended*): Run `gh auth login` to unlock **My work**, PR creation, and CI/PR watches.\n" +
          (isNoTracker(deps.tracker())
            ? "4. **MCP Integrations** (*Recommended*): In **Customize › Integrations**, click **Import from Copilot CLI** and sign in to **Work IQ** (Mail, Calendar, Teams). To read your tasks and register time, pick a task tracker there too (optional).\n"
            : `4. **MCP Integrations** (*Recommended*): In **Customize › Integrations**, click **Import from Copilot CLI** and sign in to **Work IQ** (Mail, Calendar, Teams) and **${deps.tracker().label}** for automated timesheets.\n`) +
          "5. **Daily Rhythm & Extras** (*Optional*): Configure daily hours in **Time**, routines in **Automations**, or voice/away notifications in **Customize › Notifications**.",
      };
    }

    case "tour": {
      return {
        handled: true,
        command: "/tour",
        reply:
          "**ARIA GUI Tour**\n" +
          "- **One Chat (Center)**: Ask questions or start coding tasks. Cards show progress, questions (`Q-1`), permissions (`P-1`), plans (`L-1`), and diffs.\n" +
          "- **Projects & Sessions Sidebar (Left, `Ctrl+B`)**: Browse repositories, active worktree tasks, and GitHub watches.\n" +
          "- **Inspect & Session View (Right)**: View any task's live transcript/plan/diff, or click **Inspect** to see ARIA's `<updates>` digest and tool calls.\n" +
          (isNoTracker(deps.tracker())
            ? "- **My Work, Time & Automations**: Track GitHub PRs (and your tasks, once you pick a task tracker in Customize › Integrations: optional), review daily AI-drafted timesheets, and schedule morning briefs.\n"
            : `- **My Work, Time & Automations**: Track GitHub PRs + ${deps.tracker().label} tasks, review daily AI-drafted timesheets, and schedule morning briefs.\n`) +
          "- **Quick Prompt (`Ctrl+Alt+Space` globally or `Ctrl+Space` in ARIA)**: Summon the quick prompt bar without switching windows.",
      };
    }

    case "whats-new":
    case "changelog": {
      const list = deps.releases?.() ?? RELEASES;
      const latest = list[0];
      if (!latest) {
        return {
          handled: true,
          command: "/whats-new",
          reply: "No release notes available.",
        };
      }
      const featLines = latest.features.map((f) => `- **${f.title}**: ${f.description}`);
      const fixLines = latest.fixes.map((f) => `- ${f}`);
      return {
        handled: true,
        command: "/whats-new",
        reply:
          `**What's new in ARIA v${latest.version}** (${latest.date})\n${latest.headline}\n\n` +
          `**New features:**\n${featLines.join("\n")}` +
          (fixLines.length ? `\n\n**Fixes & hardening:**\n${fixLines.join("\n")}` : ""),
      };
    }

    default:
      throw new Error(
        `Unknown slash command "/${word}". Available commands: /status, /tasks, /watch, /focus, /pause-all, /budget, /agents, /skills, /doctor, /tracker, /setup, /tour, /whats-new.`,
      );
  }
}
