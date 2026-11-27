import type {
  CardItem,
  CustomizePage,
  DoctorCheck,
  ReleaseFeatureItem,
  ReleaseNoteEntry,
  UiState,
} from "@aria/protocol";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  Compass,
  Download,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  Info,
  LoaderCircle,
  LogIn,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { openPage } from "../openPage";
import { useHasTracker, useAria, useTracker } from "../store";
import { trackerLabel, trackerServerHint } from "../tracker";
import { Button, Shell } from "./CardParts";

export interface TourStop {
  id: string;
  targetTestId: string;
  title: string;
  summary: string;
  tip: string;
  view?: UiState["view"];
}

/** The "My Work & Time" stop: with no task tracker it names none and points at Customize › Integrations. */
const myWorkStop = (tracker: string, hasTracker: boolean): Pick<TourStop, "title" | "summary" | "tip"> =>
  hasTracker
    ? {
        title: `4. My Work & Automated ${tracker} Timesheets`,
        summary: `My work gathers your GitHub PRs, issues, CI runs, and ${tracker} tasks. Time collects your git commits, PRs, ARIA tasks, and Outlook meetings into a checked daily draft for 1-click ${tracker} submission.`,
        tip: "When you correct a task mapping on a timesheet, ARIA offers to remember it as an automatic rule.",
      }
    : {
        title: "4. My Work & Time Drafts",
        summary:
          "My work gathers your GitHub PRs, issues, and CI runs. Time collects your git commits, PRs, ARIA tasks, and Outlook meetings into a checked daily draft.",
        tip: "To read your tasks and register your time, pick a task tracker in Customize › Integrations (optional).",
      };

export const tourStops = (tracker: string, hasTracker = true): readonly TourStop[] => [
  {
    id: "chat",
    targetTestId: "composer",
    title: "1. One Chat for Everything",
    summary:
      "Ask questions or delegate coding work in plain English. ARIA runs coding tasks in the background in isolated git worktrees (under C:\\wt) and reports back here with interactive cards.",
    tip: "Type @ to message a running task directly, or / for zero-cost commands (/status, /tasks, /budget, /doctor).",
    view: "chat",
  },
  {
    id: "sidebar",
    targetTestId: "sidebar",
    title: "2. Projects & Background Sessions",
    summary:
      "Your repositories live in the sidebar with their active tasks and GitHub CI/PR watches underneath. Click + next to PROJECTS to add local folders or clone from GitHub.",
    tip: "Press Ctrl+B anytime to collapse the sidebar into a compact Live Strip at the top of the chat.",
    view: "chat",
  },
  {
    id: "inspect",
    targetTestId: "inspect-aria",
    title: "3. Full Transparency & Flow Tuning",
    summary:
      "Click any task to open its live transcript, plan, and file diff on the right—or click Inspect here to see the exact <updates> digest and tool calls ARIA used.",
    tip: "In any session view, use 'Always allow this' on commands and 'Save as memory' on your replies to tune future tasks.",
    view: "chat",
  },
  {
    id: "mywork-time",
    targetTestId: "nav-time",
    ...myWorkStop(tracker, hasTracker),
    view: "chat",
  },
  {
    id: "customize",
    targetTestId: "nav-customize",
    title: "5. Models, Permissions & MCP Integrations",
    summary:
      "In Customize, you choose the exact model and reasoning effort for ARIA, worker profiles, and Timekeeper, plus sandbox rules, prompt history, and MCP tool permissions (Auto / Ask / Never).",
    tip: "Open Customize › Integrations to import servers from Copilot CLI and sign in to Microsoft 365 Work IQ.",
    view: "chat",
  },
  {
    id: "quick-prompt",
    targetTestId: "open-quick-prompt",
    title: "6. Quick Prompt Bar & Focus Mode",
    summary:
      "Press Ctrl+Alt+Space from any application on Windows (or Ctrl+Space inside ARIA) to summon the Spotlight-style Quick Prompt bar without switching windows. Turn on Focus mode when you only want blocking questions to toast.",
    tip: "Hold Ctrl+Shift+Space (or the mic button) for push-to-talk voice transcription.",
    view: "chat",
  },
];

function StatusIcon({ status }: { status: DoctorCheck["status"] }) {
  if (status === "ok") return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />;
  if (status === "warning") return <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />;
  if (status === "error") return <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />;
  return <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />;
}

/**
 * Interactive Copilot CLI & runtime troubleshooter shown in Chat when `status.state === "error"`.
 * Preserves `data-testid="error"` and `data-testid="reconnect"` for existing E2E specs while adding
 * actionable diagnostics, 1-click terminal sign-in, log access, and Doctor checks.
 */
export function CopilotErrorTroubleshooter() {
  const status = useAria((s) => s.status);
  const reconnect = useAria((s) => s.reconnect);
  const doctor = useAria((s) => s.doctor);
  const doctorLoading = useAria((s) => s.doctorLoading);
  const runDoctor = useAria((s) => s.runDoctor);
  const openCliTerminal = useAria((s) => s.openCliTerminal);
  const openLogsFolder = useAria((s) => s.openLogsFolder);
  const openOnboardingModal = useAria((s) => s.openOnboardingModal);
  const [terminalMsg, setTerminalMsg] = useState<string | null>(null);

  const launchCopilotSignIn = async () => {
    setTerminalMsg(null);
    const err = await openCliTerminal("copilot");
    setTerminalMsg(
      err ?? "Opened a terminal running `copilot`. Complete any sign-in prompt there, then click Reconnect.",
    );
  };

  const relevantChecks = doctor?.checks.filter(
    (c) => c.id === "copilot_cli" || c.id === "copilot_runtime" || c.id === "environment",
  );

  return (
    <div
      className="mx-auto mt-10 max-w-lg rounded-lg border border-bad/40 bg-bad/10 p-4 text-sm"
      data-testid="error"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-bad">ARIA couldn't connect to the Copilot runtime.</div>
        <span className="shrink-0 rounded bg-bad/20 px-1.5 py-0.5 text-[11px] font-medium text-bad">
          Copilot CLI Help
        </span>
      </div>
      <div className="mt-1 text-muted">{status.detail}</div>
      <div className="mt-2 text-xs text-muted">
        Check that Copilot CLI is installed and signed in (run `copilot` once), then reconnect.
      </div>

      {relevantChecks && relevantChecks.length > 0 && (
        <div
          className="mt-3 space-y-1.5 rounded-md border border-line bg-panel/90 p-2.5 text-xs"
          data-testid="error-doctor-checks"
        >
          <div className="font-medium text-fg">Diagnostic checks</div>
          {relevantChecks.map((check) => (
            <div key={check.id} className="flex items-start gap-2" data-testid={`error-check-${check.id}`}>
              <StatusIcon status={check.status} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-fg">{check.title}</div>
                <div className="text-muted">{check.summary}</div>
                {check.detail && <div className="truncate font-mono text-[11px] text-muted/80">{check.detail}</div>}
                {check.remediation && <div className="mt-0.5 text-warn">{check.remediation}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {terminalMsg && (
        <div className="mt-2 rounded border border-line bg-panel px-2.5 py-1.5 text-xs text-fg" data-testid="error-terminal-msg">
          {terminalMsg}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button testId="reconnect" primary onClick={() => void reconnect()}>
          <RotateCcw className="h-3 w-3" /> Reconnect
        </Button>
        <Button testId="error-copilot-login" onClick={() => void launchCopilotSignIn()}>
          <Terminal className="h-3 w-3" /> Sign in to Copilot CLI
        </Button>
        <Button
          testId="error-run-doctor"
          disabled={doctorLoading}
          onClick={() => void runDoctor()}
        >
          {doctorLoading ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
          Diagnose
        </Button>
        <Button testId="error-open-logs" onClick={() => void openLogsFolder()}>
          <FolderOpen className="h-3 w-3" /> Logs
        </Button>
        <Button testId="error-open-setup" onClick={() => openOnboardingModal()}>
          <Wrench className="h-3 w-3" /> Setup guide
        </Button>
      </div>
    </div>
  );
}

/**
 * First-run Getting Started & Setup guide shown inside `EmptyState` in `Chat.tsx` until dismissed.
 * Shows live readiness across Required, Recommended, and Optional configuration, and launches the
 * 1-minute GUI Tour or full Setup & Doctor modal.
 */
export function WelcomeSetupBanner() {
  const onboarding = useAria((s) => s.onboarding);
  const trackerName = trackerLabel(useTracker());
  const hasTracker = useHasTracker();
  const status = useAria((s) => s.status);
  const conductor = useAria((s) => s.conductor);
  const projects = useAria((s) => s.projects);
  const github = useAria((s) => s.github);
  const integrations = useAria((s) => s.integrations);
  const startTour = useAria((s) => s.startTour);
  const openOnboardingModal = useAria((s) => s.openOnboardingModal);
  const openWhatsNewModal = useAria((s) => s.openWhatsNewModal);
  const setOnboardingState = useAria((s) => s.setOnboardingState);
  const setCustomizePage = useAria((s) => s.setCustomizePage);

  if (onboarding.setupCompleted) return null;

  const visibleProjects = projects.filter((p) => !p.hidden);
  const runtimeReady = status.state === "ready" || status.state === "busy";
  const githubReady = github.status === "ok";
  const seenServers = integrations.servers.filter((s) => s.seen && s.status !== "disabled");
  const needsAuthServers = seenServers.filter((s) => s.status === "needs-auth");
  const mcpReady = seenServers.length > 0 && needsAuthServers.length === 0;

  const readyCount = [runtimeReady, visibleProjects.length > 0, githubReady, mcpReady].filter(Boolean).length;

  return (
    <div
      className="mx-auto mb-6 max-w-2xl rounded-xl border border-line bg-panel p-4 text-left shadow-sm"
      data-testid="welcome-banner"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-fg">Welcome to ARIA — Getting Started</span>
            <span
              className="rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] font-medium text-muted"
              data-testid="welcome-readiness"
            >
              {readyCount} of 4 setup items ready
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {hasTracker
              ? `Take a quick tour of the interface or review the setup checklist to unlock GitHub watches, Microsoft 365 Work IQ, and ${trackerName} timesheets.`
              : "Take a quick tour of the interface or review the setup checklist to unlock GitHub watches and Microsoft 365 Work IQ."}
          </p>
        </div>
        <button
          type="button"
          data-testid="welcome-dismiss"
          title="Dismiss getting started guide (you can reopen it anytime from the sidebar footer or /setup)"
          onClick={() => void setOnboardingState({ setupCompleted: true })}
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <button
          type="button"
          data-testid="welcome-item-models"
          onClick={() => setCustomizePage("models")}
          className="flex items-start gap-2 rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
        >
          <StatusIcon status={runtimeReady ? "ok" : "error"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-fg">1. Copilot & Models</span>
              <span className="text-[10px] uppercase tracking-wide text-accent">Required</span>
            </div>
            <div className="truncate text-muted">
              {runtimeReady
                ? `Connected · ${conductor.model ?? status.model ?? "default model"}`
                : "Copilot CLI needs sign-in"}
            </div>
          </div>
        </button>

        <button
          type="button"
          data-testid="welcome-item-projects"
          onClick={() => openOnboardingModal()}
          className="flex items-start gap-2 rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
        >
          <StatusIcon status={visibleProjects.length > 0 ? "ok" : "warning"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-fg">2. Your Projects</span>
              <span className="text-[10px] uppercase tracking-wide text-accent">Required</span>
            </div>
            <div className="truncate text-muted">
              {visibleProjects.length > 0
                ? `${visibleProjects.length} repo${visibleProjects.length === 1 ? "" : "s"} found in ~/Documents/GitHub`
                : "Add or clone a repository to run tasks"}
            </div>
          </div>
        </button>

        <button
          type="button"
          data-testid="welcome-item-github"
          onClick={() => setCustomizePage("notifications")}
          className="flex items-start gap-2 rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
        >
          <StatusIcon status={githubReady ? "ok" : "warning"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-fg">3. GitHub CLI (gh)</span>
              <span className="text-[10px] uppercase tracking-wide text-muted">Recommended</span>
            </div>
            <div className="truncate text-muted">
              {githubReady
                ? `Signed in${github.login ? ` as @${github.login}` : ""} · PRs & watches active`
                : "Sign in with `gh auth login` for My work & CI"}
            </div>
          </div>
        </button>

        <button
          type="button"
          data-testid="welcome-item-mcp"
          onClick={() => setCustomizePage("integrations")}
          className="flex items-start gap-2 rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
        >
          <StatusIcon status={mcpReady ? "ok" : needsAuthServers.length > 0 ? "warning" : "info"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-fg">{hasTracker ? `4. ${trackerName} & Work IQ MCP` : "4. Work IQ MCP"}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted">Recommended</span>
            </div>
            <div className="truncate text-muted">
              {needsAuthServers.length > 0
                ? `${needsAuthServers.length} server${needsAuthServers.length === 1 ? " needs" : "s need"} sign-in`
                : seenServers.length > 0
                  ? `${seenServers.length} MCP server${seenServers.length === 1 ? "" : "s"} configured`
                  : "Import from Copilot CLI for Time & M365"}
            </div>
          </div>
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button testId="welcome-start-tour" primary onClick={() => startTour(0)}>
            <Compass className="h-3.5 w-3.5" /> Take 1-minute GUI tour
          </Button>
          <Button testId="welcome-open-setup" onClick={() => openOnboardingModal()}>
            <Wrench className="h-3.5 w-3.5" /> Setup & Copilot CLI doctor
          </Button>
          <Button testId="welcome-whats-new" onClick={() => openWhatsNewModal()}>
            <Sparkles className="h-3.5 w-3.5" /> What's new
          </Button>
        </div>
        <button
          type="button"
          data-testid="welcome-done"
          onClick={() => void setOnboardingState({ setupCompleted: true })}
          className="text-xs text-muted hover:text-fg"
        >
          Mark setup complete
        </button>
      </div>
    </div>
  );
}

/**
 * Full Setup Checklist & Copilot CLI Doctor modal, accessible from the Welcome banner,
 * Sidebar footer ("Help & Setup"), error troubleshooter, or `/setup` command.
 */
export function OnboardingModal() {
  const open = useAria((s) => s.onboardingModalOpen);
  const tracker = useTracker();
  const trackerName = trackerLabel(tracker);
  const trackerServer = trackerServerHint(tracker);
  const hasTracker = useHasTracker();
  const close = useAria((s) => s.closeOnboardingModal);
  const status = useAria((s) => s.status);
  const conductor = useAria((s) => s.conductor);
  const projects = useAria((s) => s.projects);
  const github = useAria((s) => s.github);
  const integrations = useAria((s) => s.integrations);
  const doctor = useAria((s) => s.doctor);
  const doctorLoading = useAria((s) => s.doctorLoading);
  const runDoctor = useAria((s) => s.runDoctor);
  const reconnect = useAria((s) => s.reconnect);
  const addProjectFolder = useAria((s) => s.addProjectFolder);
  const rescanProjects = useAria((s) => s.rescanProjects);
  const retryGitHub = useAria((s) => s.retryGitHub);
  const importCliMcp = useAria((s) => s.importCliMcp);
  const signIn = useAria((s) => s.signIn);
  const openCliTerminal = useAria((s) => s.openCliTerminal);
  const openLogsFolder = useAria((s) => s.openLogsFolder);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const setView = useAria((s) => s.setView);
  const startTour = useAria((s) => s.startTour);
  const setOnboardingState = useAria((s) => s.setOnboardingState);

  const [tab, setTab] = useState<"checklist" | "doctor">("checklist");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFeedback(null);
  }, [open]);

  if (!open) return null;

  const visibleProjects = projects.filter((p) => !p.hidden);
  const runtimeReady = status.state === "ready" || status.state === "busy";
  const seenServers = integrations.servers.filter((s) => s.seen && s.status !== "disabled");
  const needsAuthServers = seenServers.filter((s) => s.status === "needs-auth");

  const goCustomize = (page: CustomizePage) => {
    close();
    setCustomizePage(page);
  };

  const handleImportMcp = async () => {
    setBusy(true);
    setFeedback(null);
    const res = await importCliMcp(false);
    setBusy(false);
    if (res.error) setFeedback(res.error);
    else setFeedback(`Imported ${res.imported ?? 0} server(s), updated ${res.updated ?? 0}.`);
    void runDoctor();
  };

  const handleTerminal = async (target: "copilot" | "gh_login") => {
    setFeedback(null);
    const err = await openCliTerminal(target);
    setFeedback(
      err ??
        (target === "copilot"
          ? "Opened terminal with `copilot`. Sign in there, then click Reconnect."
          : "Opened terminal with `gh auth login`. Sign in there, then click Try again."),
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="onboarding-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Setup Guide & Copilot CLI Doctor</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="onboarding-tab-checklist"
              onClick={() => setTab("checklist")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                tab === "checklist" ? "bg-raised text-fg" : "text-muted hover:text-fg"
              }`}
            >
              Setup Checklist
            </button>
            <button
              type="button"
              data-testid="onboarding-tab-doctor"
              onClick={() => {
                setTab("doctor");
                void runDoctor();
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                tab === "doctor" ? "bg-raised text-fg" : "text-muted hover:text-fg"
              }`}
            >
              Copilot CLI Doctor
            </button>
            <button
              type="button"
              data-testid="onboarding-close"
              aria-label="Close setup guide"
              onClick={close}
              className="ml-2 rounded p-1 text-muted hover:bg-raised hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {feedback && (
            <div
              className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-fg"
              data-testid="onboarding-feedback"
            >
              {feedback}
            </div>
          )}

          {tab === "checklist" ? (
            <>
              <div className="space-y-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                  Required — Needed for Core Chat & Coding Tasks
                </div>

                {/* 1. Copilot Runtime & Models */}
                <div className="rounded-lg border border-line bg-canvas/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <StatusIcon status={runtimeReady ? "ok" : "error"} />
                      <div>
                        <div className="font-medium text-fg">1. Copilot CLI Runtime & Models</div>
                        <div className="mt-0.5 text-muted">
                          {runtimeReady
                            ? `Connected · ARIA uses ${conductor.model ?? status.model ?? "default"}${conductor.reasoningEffort ? ` (${conductor.reasoningEffort})` : ""}.`
                            : `Not connected${status.detail ? `: ${status.detail}` : ""}. Sign in to Copilot CLI first.`}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {!runtimeReady && (
                        <>
                          <Button testId="setup-copilot-login" onClick={() => void handleTerminal("copilot")}>
                            <Terminal className="h-3 w-3" /> Sign in (`copilot`)
                          </Button>
                          <Button testId="setup-reconnect" primary onClick={() => void reconnect()}>
                            <RotateCcw className="h-3 w-3" /> Reconnect
                          </Button>
                        </>
                      )}
                      <Button testId="setup-open-models" onClick={() => goCustomize("models")}>
                        <Settings className="h-3 w-3" /> Choose models
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 2. Projects */}
                <div className="rounded-lg border border-line bg-canvas/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <StatusIcon status={visibleProjects.length > 0 ? "ok" : "warning"} />
                      <div>
                        <div className="font-medium text-fg">2. Repositories (Projects)</div>
                        <div className="mt-0.5 text-muted">
                          {visibleProjects.length > 0
                            ? `${visibleProjects.length} repository folder${visibleProjects.length === 1 ? "" : "s"} registered (${visibleProjects
                                .slice(0, 4)
                                .map((p) => p.name)
                                .join(", ")}${visibleProjects.length > 4 ? "…" : ""}).`
                            : "No repositories registered yet. ARIA scans ~/Documents/GitHub automatically, or you can add any local git folder."}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button testId="setup-add-project" onClick={() => void addProjectFolder()}>
                        <FolderPlus className="h-3 w-3" /> Add folder…
                      </Button>
                      <Button testId="setup-rescan-projects" onClick={() => void rescanProjects()}>
                        <RefreshCw className="h-3 w-3" /> Rescan
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5 pt-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {hasTracker ? <>Recommended — Unlocks GitHub Watchers, Microsoft 365 & {trackerName} Time</> : "Recommended — Unlocks GitHub Watchers and Microsoft 365"}
                </div>

                {/* 3. GitHub CLI */}
                <div className="rounded-lg border border-line bg-canvas/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <StatusIcon status={github.status === "ok" ? "ok" : "warning"} />
                      <div>
                        <div className="font-medium text-fg">3. GitHub CLI (`gh`)</div>
                        <div className="mt-0.5 text-muted">
                          {github.status === "ok"
                            ? `Signed in${github.login ? ` as @${github.login}` : ""}. Powers My work, PR creation, CI watches, and 1-click Fix it.`
                            : "Sign in with `gh auth login` so ARIA can watch your PRs, CI runs, and review requests."}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {github.status !== "ok" && (
                        <>
                          <Button testId="setup-gh-login" onClick={() => void handleTerminal("gh_login")}>
                            <Terminal className="h-3 w-3" /> `gh auth login`
                          </Button>
                          <Button
                            testId="setup-gh-retry"
                            onClick={async () => {
                              const err = await retryGitHub();
                              setFeedback(err ?? "Rechecked GitHub CLI status.");
                              void runDoctor();
                            }}
                          >
                            <RefreshCw className="h-3 w-3" /> Try again
                          </Button>
                        </>
                      )}
                      <Button testId="setup-open-github" onClick={() => goCustomize("notifications")}>
                        GitHub settings
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 4. MCP Integrations */}
                <div className="rounded-lg border border-line bg-canvas/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <StatusIcon
                        status={
                          seenServers.length > 0 && needsAuthServers.length === 0
                            ? "ok"
                            : needsAuthServers.length > 0
                              ? "warning"
                              : "info"
                        }
                      />
                      <div>
                        <div className="font-medium text-fg">
                          {hasTracker ? <>4. MCP Integrations ({trackerName} & Microsoft 365 Work IQ)</> : "4. MCP Integrations (Microsoft 365 Work IQ)"}
                        </div>
                        <div className="mt-0.5 text-muted">
                          {hasTracker
                            ? `Import your MCP servers from Copilot CLI and sign in to Work IQ (Mail, Calendar, Teams) and ${trackerServer} for automated timesheets.`
                            : "Import your MCP servers from Copilot CLI and sign in to Work IQ (Mail, Calendar, Teams). To read your tasks and register time, pick a task tracker in Customize › Integrations (optional)."}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button testId="setup-import-mcp" disabled={busy} onClick={() => void handleImportMcp()}>
                        <RefreshCw className="h-3 w-3" /> Import from CLI
                      </Button>
                      <Button testId="setup-open-integrations" onClick={() => goCustomize("integrations")}>
                        Integrations
                      </Button>
                    </div>
                  </div>

                  {needsAuthServers.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
                      <span className="text-[11px] text-warn">Needs sign-in:</span>
                      {needsAuthServers.map((srv) => (
                        <Button
                          key={srv.name}
                          testId={`setup-signin-${srv.name}`}
                          onClick={async () => {
                            const err = await signIn(srv.name);
                            setFeedback(err ?? `Opened browser sign-in for ${srv.displayName ?? srv.name}.`);
                          }}
                        >
                          <LogIn className="h-3 w-3" /> Sign in to {srv.displayName ?? srv.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2.5 pt-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Optional — Customize Your Workflow
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    data-testid="setup-opt-time"
                    onClick={() => {
                      close();
                      setView("time");
                    }}
                    className="rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
                  >
                    <div className="font-medium text-fg">{hasTracker ? "Time & Mapping Rules" : "Time"}</div>
                    <div className="mt-0.5 text-muted">
                      {hasTracker ? <>Set expected daily hours, 16:30 draft schedule, and repo → {trackerName} task rules.</> : "Set expected daily hours and the 16:30 draft schedule."}
                    </div>
                  </button>
                  <button
                    type="button"
                    data-testid="setup-opt-permissions"
                    onClick={() => goCustomize("permissions")}
                    className="rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
                  >
                    <div className="font-medium text-fg">Sandbox & Permissions</div>
                    <div className="mt-0.5 text-muted">Configure allowed hosts, extra readable folders, and auto-approved shell rules.</div>
                  </button>
                  <button
                    type="button"
                    data-testid="setup-opt-notifications"
                    onClick={() => goCustomize("notifications")}
                    className="rounded-lg border border-line bg-canvas/60 p-2.5 text-left hover:border-accent"
                  >
                    <div className="font-medium text-fg">Voice, Phone & Telegram</div>
                    <div className="mt-0.5 text-muted">Enable spoken announcements, push-to-talk, ntfy/Pushover, or two-way Telegram.</div>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-3" data-testid="doctor-panel">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas/60 p-3">
                <div>
                  <div className="font-medium text-fg">
                    {doctor
                      ? doctor.overallStatus === "ok"
                        ? "All required checks passed"
                        : doctor.overallStatus === "warning"
                          ? "Ready with recommendations"
                          : "Action needed on required checks"
                      : "Running diagnostics…"}
                  </div>
                  <div className="text-muted">
                    Checks Copilot CLI binary resolution, SDK runtime connection, environment hygiene, git worktrees, sandbox support, GitHub CLI, and MCP servers.
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button testId="doctor-rerun" disabled={doctorLoading} onClick={() => void runDoctor()}>
                    {doctorLoading ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Re-run checks
                  </Button>
                  <Button testId="doctor-open-logs" onClick={() => void openLogsFolder()}>
                    <FolderOpen className="h-3 w-3" /> Open logs
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {(doctor?.checks ?? []).map((check) => (
                  <div
                    key={check.id}
                    data-testid={`doctor-check-${check.id}`}
                    data-status={check.status}
                    className="flex items-start justify-between gap-3 rounded-lg border border-line bg-canvas/60 p-3"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <StatusIcon status={check.status} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-fg">{check.title}</span>
                          <span className="rounded bg-raised px-1.5 py-px text-[10px] uppercase text-muted">
                            {check.category}
                          </span>
                        </div>
                        <div className="mt-0.5 text-muted">{check.summary}</div>
                        {check.detail && (
                          <div className="mt-0.5 truncate font-mono text-[11px] text-muted/80" title={check.detail}>
                            {check.detail}
                          </div>
                        )}
                        {check.remediation && <div className="mt-1 text-warn">{check.remediation}</div>}
                      </div>
                    </div>

                    {check.action && (
                      <div className="shrink-0">
                        {check.action === "open_copilot_login" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => void handleTerminal("copilot")}>
                            <Terminal className="h-3 w-3" /> Sign in (`copilot`)
                          </Button>
                        )}
                        {check.action === "open_gh_login" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => void handleTerminal("gh_login")}>
                            <Terminal className="h-3 w-3" /> `gh auth login`
                          </Button>
                        )}
                        {check.action === "reconnect" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => void reconnect()}>
                            <RotateCcw className="h-3 w-3" /> Reconnect
                          </Button>
                        )}
                        {check.action === "open_models" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => goCustomize("models")}>
                            Models
                          </Button>
                        )}
                        {check.action === "open_permissions" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => goCustomize("permissions")}>
                            Permissions
                          </Button>
                        )}
                        {check.action === "open_integrations" && (
                          <Button testId={`doctor-act-${check.id}`} onClick={() => goCustomize("integrations")}>
                            Integrations
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-raised/40 px-5 py-3">
          <Button testId="onboarding-start-tour" onClick={() => startTour(0)}>
            <Compass className="h-3.5 w-3.5" /> Start 1-minute GUI tour
          </Button>
          <div className="flex items-center gap-2">
            <Button testId="onboarding-close-btn" onClick={close}>
              Close
            </Button>
            <Button
              testId="onboarding-complete"
              primary
              onClick={async () => {
                await setOnboardingState({ setupCompleted: true });
                close();
              }}
            >
              <Check className="h-3.5 w-3.5" /> Mark setup complete
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 6-stop interactive GUI spotlight tour anchored to live `data-testid` elements.
 * Supports keyboard navigation (`ArrowRight`, `ArrowLeft`, `Escape`).
 */
export function OnboardingTour() {
  const active = useAria((s) => s.tourActive);
  const stepIndex = useAria((s) => s.tourStep);
  const nextTourStep = useAria((s) => s.nextTourStep);
  const prevTourStep = useAria((s) => s.prevTourStep);
  const stopTour = useAria((s) => s.stopTour);
  const stops = tourStops(trackerLabel(useTracker()), useHasTracker());

  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const stop = stops[stepIndex] ?? stops[0]!;

  useLayoutEffect(() => {
    if (!active || typeof document === "undefined") return;
    const updateRect = () => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${stop.targetTestId}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else {
        setRect(null);
      }
    };
    updateRect();
    window.addEventListener("resize", updateRect);
    return () => window.removeEventListener("resize", updateRect);
  }, [active, stop.targetTestId]);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopTour(false);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nextTourStep(stops.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevTourStep();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, nextTourStep, prevTourStep, stopTour, stops.length]);

  if (!active) return null;

  const isLast = stepIndex >= stops.length - 1;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none" data-testid="onboarding-tour" data-step={stop.id}>
      {rect && (
        <div
          data-testid="tour-spotlight"
          style={{
            top: Math.max(4, rect.top - 4),
            left: Math.max(4, rect.left - 4),
            width: rect.width + 8,
            height: rect.height + 8,
          }}
          className="fixed rounded-lg border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-all duration-200"
        />
      )}
      {!rect && <div className="fixed inset-0 bg-black/55" />}

      <div className="pointer-events-auto fixed bottom-6 right-6 z-10 w-full max-w-md rounded-xl border border-accent/50 bg-panel p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent" data-testid="tour-step-counter">
            Step {stepIndex + 1} of {stops.length}
          </span>
          <button
            type="button"
            data-testid="tour-skip"
            onClick={() => stopTour(true)}
            className="text-xs text-muted hover:text-fg"
          >
            Skip tour (Esc)
          </button>
        </div>

        <h3 className="mt-2 text-sm font-semibold text-fg" data-testid="tour-title">
          {stop.title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted" data-testid="tour-summary">
          {stop.summary}
        </p>
        <div className="mt-2.5 rounded-md border border-line bg-canvas/80 px-2.5 py-1.5 text-[11px] text-fg">
          <span className="font-semibold text-accent">Tip: </span>
          {stop.tip}
        </div>

        <div className="mt-3.5 flex items-center justify-between border-t border-line pt-3">
          <div className="flex gap-1">
            {stops.map((s, idx) => (
              <span
                key={s.id}
                className={`h-1.5 w-4 rounded-full ${idx === stepIndex ? "bg-accent" : "bg-line"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {stepIndex > 0 && (
              <Button testId="tour-prev" onClick={() => prevTourStep()}>
                <ArrowLeft className="h-3 w-3" /> Back
              </Button>
            )}
            <Button
              testId="tour-next"
              primary
              onClick={() => nextTourStep(stops.length)}
            >
              {isLast ? (
                <>
                  <Check className="h-3 w-3" /> Finish tour
                </>
              ) : (
                <>
                  Next <ArrowRight className="h-3 w-3" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReleaseBody({
  release,
  onDone,
}: {
  release: ReleaseNoteEntry;
  onDone?: () => void;
}) {
  const setView = useAria((s) => s.setView);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const setPrefill = useAria((s) => s.setPrefill);
  const startTour = useAria((s) => s.startTour);

  const runFeatureAction = (action: NonNullable<ReleaseFeatureItem["action"]>) => {
    onDone?.();
    if (action.kind === "tour") {
      startTour(0);
    } else if (action.kind === "prefill") {
      setPrefill(action.text);
    } else if (action.kind === "view") {
      if (action.view === "customize" && action.customizePage) {
        setCustomizePage(action.customizePage);
      } else {
        setView(action.view);
      }
    }
  };

  return (
    <div className="space-y-3 text-xs" data-testid={`release-entry-${release.version}`}>
      <div>
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent">
            v{release.version}
          </span>
          <span className="text-muted">{release.date}</span>
        </div>
        <div className="mt-1 font-medium text-fg">{release.headline}</div>
      </div>

      {release.features.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">New Features</div>
          <ul className="space-y-1.5">
            {release.features.map((feat) => (
              <li
                key={feat.title}
                className="flex items-start justify-between gap-2 rounded-md border border-line bg-canvas/60 p-2"
              >
                <div className="min-w-0">
                  <div className="font-medium text-fg">{feat.title}</div>
                  <div className="mt-0.5 text-muted">{feat.description}</div>
                </div>
                {feat.action && (
                  <Button
                    testId={`release-action-${feat.title}`}
                    onClick={() => runFeatureAction(feat.action!)}
                  >
                    {feat.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {release.fixes.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Bug Fixes & Hardening</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted">
            {release.fixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      )}

      {release.newSettings && release.newSettings.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">New Settings to Configure</div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {release.newSettings.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => {
                  onDone?.();
                  setCustomizePage(s.customizePage);
                }}
                className="rounded-md border border-line bg-canvas/60 p-2 text-left hover:border-accent"
              >
                <div className="font-medium text-fg">{s.title} →</div>
                <div className="mt-0.5 text-muted">{s.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Timeline card automatically emitted when an update is installed (`lastSeenVersion !== appVersion`).
 */
export function WhatsNewCardView({ card }: { card: Extract<CardItem, { cardType: "whats_new" }> }) {
  const dismissCard = useAria((s) => s.dismissCard);
  const p = card.payload;

  return (
    <Shell
      testId="card-whats-new"
      cardId={card.id}
      icon={<Sparkles className="h-4 w-4 text-accent" />}
      title={`What's new in ARIA v${p.toVersion}${p.fromVersion ? ` (updated from v${p.fromVersion})` : ""}`}
      right={
        <button
          type="button"
          data-testid="whats-new-card-dismiss"
          title="Dismiss release notes"
          onClick={() => void dismissCard(card.id)}
          className="rounded p-0.5 text-muted hover:bg-raised hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      }
    >
      <div className="space-y-4">
        {p.releases.map((rel) => (
          <ReleaseBody key={rel.version} release={rel} />
        ))}
      </div>
    </Shell>
  );
}

/**
 * Full Release Notes & Update Available modal opened automatically on startup when an update is available
 * or was recently installed, or manually from the Sidebar footer ("What's new") or `/whats-new` slash command.
 */
export function WhatsNewModal() {
  const open = useAria((s) => s.whatsNewModalOpen);
  const close = useAria((s) => s.closeWhatsNewModal);
  const releases = useAria((s) => s.releases);
  const appVersion = useAria((s) => s.appVersion);
  const availableUpdate = useAria((s) => s.availableUpdate);
  const startTour = useAria((s) => s.startTour);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="whats-new-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            {availableUpdate ? (
              <Download className="h-4 w-4 text-warn" />
            ) : (
              <BookOpen className="h-4 w-4 text-accent" />
            )}
            <h2 className="text-sm font-semibold text-fg">
              {availableUpdate
                ? `Update Available — ARIA v${availableUpdate.version}`
                : `What's New in ARIA (v${appVersion})`}
            </h2>
          </div>
          <button
            type="button"
            data-testid="whats-new-close"
            aria-label="Close release notes"
            onClick={close}
            className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {availableUpdate && (
            <div
              className="rounded-lg border border-warn/50 bg-warn/10 p-3.5 text-xs"
              data-testid="update-available-banner"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-warn/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-warn">
                      v{appVersion} → v{availableUpdate.version}
                    </span>
                    <span className="font-semibold text-fg">
                      {availableUpdate.headline ?? `ARIA v${availableUpdate.version} is available`}
                    </span>
                  </div>
                  {availableUpdate.notes && (
                    <div className="mt-1.5 whitespace-pre-wrap text-muted">
                      {availableUpdate.notes}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    testId="update-available-download"
                    primary
                    onClick={() => openPage(availableUpdate.installerUrl ?? availableUpdate.releaseUrl)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {availableUpdate.installerName
                      ? `Download ${availableUpdate.installerName}`
                      : `Download v${availableUpdate.version}`}
                  </Button>
                  <Button
                    testId="update-available-release"
                    onClick={() => openPage(availableUpdate.releaseUrl)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Release page
                  </Button>
                </div>
              </div>
            </div>
          )}

          {releases.length === 0 ? (
            <div className="text-xs text-muted">No release notes found.</div>
          ) : (
            releases.map((rel) => <ReleaseBody key={rel.version} release={rel} onDone={close} />)
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line bg-raised/40 px-5 py-3">
          <Button
            testId="whats-new-tour"
            onClick={() => {
              close();
              startTour(0);
            }}
          >
            <Compass className="h-3.5 w-3.5" /> Take GUI tour
          </Button>
          <Button testId="whats-new-done" primary onClick={close}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact footer at the bottom of `Sidebar.tsx` giving 1-click access to the GUI Tour, Setup & Doctor,
 * and "What's new" release notes at any time.
 */
export function SidebarHelpFooter() {
  const appVersion = useAria((s) => s.appVersion);
  const onboarding = useAria((s) => s.onboarding);
  const availableUpdate = useAria((s) => s.availableUpdate);
  const status = useAria((s) => s.status);
  const startTour = useAria((s) => s.startTour);
  const openOnboardingModal = useAria((s) => s.openOnboardingModal);
  const openWhatsNewModal = useAria((s) => s.openWhatsNewModal);

  const needsAttention = status.state === "error" || !onboarding.setupCompleted;
  const hasUpdateDot =
    Boolean(availableUpdate) ||
    Boolean(
      onboarding.dismissedWhatsNewVersion &&
        onboarding.dismissedWhatsNewVersion !== appVersion,
    );

  return (
    <div
      className="mt-auto flex items-center justify-between gap-1 border-t border-line px-2.5 py-2 text-xs text-muted"
      data-testid="sidebar-help-footer"
    >
      <button
        type="button"
        data-testid="sidebar-whats-new"
        title={
          availableUpdate
            ? `Update available: ARIA v${availableUpdate.version}`
            : "View release notes and what's new"
        }
        onClick={() => openWhatsNewModal()}
        className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-raised hover:text-fg"
      >
        {hasUpdateDot ? (
          <span className="h-1.5 w-1.5 rounded-full bg-warn" data-testid="sidebar-update-dot" />
        ) : (
          <Sparkles className="h-3 w-3 text-accent" />
        )}
        <span className="font-mono text-[11px]">
          {availableUpdate ? `v${appVersion} → v${availableUpdate.version}` : `v${appVersion}`}
        </span>
      </button>

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="sidebar-open-setup"
          title="Setup checklist & Copilot CLI doctor (/setup or /doctor)"
          onClick={() => openOnboardingModal()}
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-raised hover:text-fg"
        >
          {needsAttention && <span className="h-1.5 w-1.5 rounded-full bg-warn" data-testid="sidebar-setup-dot" />}
          <HelpCircle className="h-3.5 w-3.5" />
          <span>Setup</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-start-tour"
          title="Take the 1-minute GUI tour (/tour)"
          onClick={() => startTour(0)}
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-raised hover:text-fg"
        >
          <Compass className="h-3.5 w-3.5" />
          <span>Tour</span>
        </button>
      </div>
    </div>
  );
}
