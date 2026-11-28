import type { CardItem, AriaApi } from "@aria/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acmeTracker } from "../../../packages/core/test/helpers/acme.ts";

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    create: (createState: any) => {
      const store = actual.createStore(createState);
      const useBoundStore = (selector: (s: any) => any = (s: any) => s) => selector(store.getState());
      Object.assign(useBoundStore, store);
      return useBoundStore;
    },
  };
});

import { Card } from "../src/renderer/src/components/Cards";
import { Chat } from "../src/renderer/src/components/Chat";
import { OnboardingModal, OnboardingTour, SidebarHelpFooter, WhatsNewModal } from "../src/renderer/src/components/Onboarding";
import { UpdateBar } from "../src/renderer/src/components/UpdateBar";
import { useAria } from "../src/renderer/src/store";

const api: Partial<AriaApi> = {
  runDoctor: async () => ({
    checkedAt: 1000,
    overallStatus: "ok",
    checks: [],
  }),
};
(globalThis as { window?: unknown }).window = { aria: api };

describe("Onboarding, Copilot CLI Doctor, GUI Tour & What's New UI", () => {
  beforeEach(() => {
    useAria.setState({
      status: { state: "ready", model: "claude-haiku-5.5" },
      conductor: { model: "claude-haiku-5.5", reasoningEffort: "low" },
      timeline: [],
      streaming: [],
      tasks: [],
      projects: [
        {
          id: 1,
          name: "Moonrise",
          path: "C:\\Users\\sam\\Documents\\GitHub\\Moonrise",
          addedVia: "scan",
          pinned: false,
          hidden: false,
        },
      ],
      github: { status: "ok", login: "sam", inbox: true },
      integrations: {
        servers: [
          {
            name: "Acme Tasks",
            status: "connected",
            seen: true,
            lastSeen: 1000,
            toolCount: 56,
            github: false,
          },
        ],
        tools: [],
        runtimeUp: true,
        refreshing: false,
      },
      appVersion: "0.1.0",
      onboarding: {
        lastSeenVersion: "0.1.0",
        setupCompleted: false,
        tourCompleted: false,
        updatedAt: 1000,
      },
      releases: [
        {
          version: "0.1.0",
          date: "2026-11-04",
          headline: "Welcome to ARIA 0.1",
          features: [
            {
              title: "One Chat + Isolated Background Worktrees",
              description: "Delegate coding tasks in plain English.",
              action: { kind: "tour", label: "Take 1-minute GUI tour" },
            },
          ],
          fixes: ["Hardened Git 2.53+ policy rules"],
        },
      ],
      doctor: null,
      onboardingModalOpen: false,
      whatsNewModalOpen: false,
      tourActive: false,
      tourStep: 0,
      tracker: undefined,
    });
  });

  it("renders WelcomeSetupBanner in EmptyState with live readiness count and hides it once setupCompleted is true", () => {
    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="empty"');
    expect(html).toContain('data-testid="welcome-banner"');
    expect(html).toContain("4 of 4 setup items ready");
    expect(html).toContain('data-testid="welcome-start-tour"');
    expect(html).toContain('data-testid="welcome-open-setup"');

    useAria.setState({
      onboarding: {
        lastSeenVersion: "0.1.0",
        setupCompleted: true,
        tourCompleted: true,
        updatedAt: 2000,
      },
    });
    const htmlAfter = renderToStaticMarkup(<Chat />);
    expect(htmlAfter).toContain('data-testid="empty"');
    expect(htmlAfter).not.toContain('data-testid="welcome-banner"');
  });

  it("renders CopilotErrorTroubleshooter with diagnostic checks and 1-click sign-in when status is error", () => {
    useAria.setState({
      status: { state: "error", detail: "Copilot CLI isn't signed in." },
      doctor: {
        checkedAt: 2000,
        overallStatus: "error",
        checks: [
          {
            id: "copilot_runtime",
            title: "Copilot runtime & models",
            category: "required",
            status: "error",
            summary: "Copilot CLI needs you to sign in with your GitHub Copilot account.",
            remediation: "Open a terminal and run `copilot` once to finish signing in, then click Reconnect.",
            action: "open_copilot_login",
          },
        ],
      },
    });

    const html = renderToStaticMarkup(<Chat />);
    expect(html).toContain('data-testid="error"');
    expect(html).toContain("ARIA couldn&#x27;t connect to the Copilot runtime.");
    expect(html).toContain("Copilot CLI isn&#x27;t signed in.");
    expect(html).toContain('data-testid="reconnect"');
    expect(html).toContain('data-testid="error-copilot-login"');
    expect(html).toContain('data-testid="error-run-doctor"');
    expect(html).toContain('data-testid="error-check-copilot_runtime"');
  });

  it("renders OnboardingModal, OnboardingTour, WhatsNewCardView, WhatsNewModal, and SidebarHelpFooter", () => {
    useAria.setState({
      onboardingModalOpen: true,
      whatsNewModalOpen: true,
      tourActive: true,
      tourStep: 0,
    });

    const modalHtml = renderToStaticMarkup(<OnboardingModal />);
    expect(modalHtml).toContain('data-testid="onboarding-modal"');
    expect(modalHtml).toContain("Setup Guide &amp; Copilot CLI Doctor");
    expect(modalHtml).toContain('data-testid="onboarding-complete"');

    const tourHtml = renderToStaticMarkup(<OnboardingTour />);
    expect(tourHtml).toContain('data-testid="onboarding-tour"');
    expect(tourHtml).toContain("Step 1 of 6");
    expect(tourHtml).toContain("1. One Chat for Everything");
    expect(tourHtml).toContain('data-testid="tour-next"');

    const whatsNewModalHtml = renderToStaticMarkup(<WhatsNewModal />);
    expect(whatsNewModalHtml).toContain('data-testid="whats-new-modal"');
    expect(whatsNewModalHtml).toContain("Welcome to ARIA 0.1");

    const cardItem: Extract<CardItem, { cardType: "whats_new" }> = {
      kind: "card",
      id: "wn-1",
      cardType: "whats_new",
      createdAt: 3000,
      payload: {
        fromVersion: "0.0.9",
        toVersion: "0.1.0",
        releases: useAria.getState().releases,
      },
    };
    const cardHtml = renderToStaticMarkup(<Card card={cardItem} />);
    expect(cardHtml).toContain('data-testid="card-whats-new"');
    expect(cardHtml).toContain("What&#x27;s new in ARIA v0.1.0 (updated from v0.0.9)");
    expect(cardHtml).toContain("Hardened Git 2.53+ policy rules");

    const footerHtml = renderToStaticMarkup(<SidebarHelpFooter />);
    expect(footerHtml).toContain('data-testid="sidebar-help-footer"');
    expect(footerHtml).toContain("v0.1.0");
    expect(footerHtml).toContain('data-testid="sidebar-open-setup"');
    expect(footerHtml).toContain('data-testid="sidebar-start-tour"');
  });

  it("names the tracker's MCP server in the setup guide: its own name for it, else its label", () => {
    const sentence = (server: string) =>
      `Import your MCP servers from Copilot CLI and sign in to Work IQ (Mail, Calendar, Teams) and ${server} for automated timesheets.`;
    // The fictional Acme Tracker (packages/core/test/fixtures/trackers/acme.json), whose info the engine sends: the
    // sentence names its server hint. Core's tracker tests pin that hint's text, so together the sentence is the one the
    // window shows for any tracker that has one.
    const { serverHint } = acmeTracker.info;
    expect(serverHint).toBeTruthy();
    expect(serverHint).not.toBe(acmeTracker.info.label);
    useAria.setState({ onboardingModalOpen: true, tracker: acmeTracker.info });
    expect(renderToStaticMarkup(<OnboardingModal />)).toContain(sentence(serverHint!));

    // A tracker that names no server: its label.
    useAria.setState({
      tracker: { id: "acme", label: "Acme", taskUrlTemplate: "https://acme.example/tasks/{id}", taskRefPlaceholder: "Acme task ID", capabilities: { timeLogs: false, projects: false } },
    });
    const html = renderToStaticMarkup(<OnboardingModal />);
    expect(html).toContain(sentence("Acme"));
    expect(html).toContain("4. MCP Integrations (Acme &amp; Microsoft 365 Work IQ)");
  });

  it("shows the Update Available banner and download button in WhatsNewModal and orange indicator in SidebarHelpFooter", () => {
    useAria.setState({
      whatsNewModalOpen: true,
      availableUpdate: {
        version: "0.2.0",
        tagName: "v0.2.0",
        headline: "ARIA v0.2.0",
        notes: "New features and fixes.",
        releaseUrl: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
        installerName: "ARIA-Setup-0.2.0.exe",
        installerUrl: "https://github.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe",
      },
    });

    const modalHtml = renderToStaticMarkup(<WhatsNewModal />);
    expect(modalHtml).toContain('data-testid="update-available-banner"');
    expect(modalHtml).toContain("Update Available — ARIA v0.2.0");
    expect(modalHtml).toContain("Download ARIA-Setup-0.2.0.exe");
    expect(modalHtml).toContain('data-testid="update-available-download"');

    const footerHtml = renderToStaticMarkup(<SidebarHelpFooter />);
    expect(footerHtml).toContain('data-testid="sidebar-update-dot"');
    expect(footerHtml).toContain("v0.1.0 → v0.2.0");
  });

  describe("the update bar and What's New's Update now (D80)", () => {
    const update = {
      version: "0.2.0",
      tagName: "v0.2.0",
      releaseUrl: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
      installerName: "ARIA-Setup-0.2.0.exe",
      installerUrl: "https://github.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe",
      installerSize: 1_000_000,
      installerSha256: "b".repeat(64),
    };
    beforeEach(() => {
      useAria.setState({ availableUpdate: update, canInstallUpdates: true, updateStatus: { phase: "idle" }, updateConfirming: false });
    });

    it("says an update is available, with What's new, Later and Update now", () => {
      const html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-testid="update-bar"');
      expect(html).toContain('data-phase="idle"');
      expect(html).toContain("ARIA v0.2.0</span> is available");
      expect(html).toContain("(you have v0.1.0)");
      expect(html).toContain('data-testid="update-bar-whats-new"');
      expect(html).toContain('data-testid="update-bar-later"');
      expect(html).toContain('data-testid="update-bar-update"');
      expect(html).not.toContain('data-testid="update-bar-download"');
    });

    it("offers Download in a build that can't install, and is gone with no update or after Later", () => {
      useAria.setState({ canInstallUpdates: false });
      const html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-testid="update-bar-download"');
      expect(html).not.toContain('data-testid="update-bar-update"');

      useAria.setState({ onboarding: { ...useAria.getState().onboarding, updateSnooze: { version: "0.2.0", until: Date.now() + 60_000 } } });
      expect(renderToStaticMarkup(<UpdateBar />)).toBe("");
      useAria.setState({ availableUpdate: null });
      expect(renderToStaticMarkup(<UpdateBar />)).toBe("");
    });

    it("asks before a restart that stops tasks, then shows the download and the restart", () => {
      useAria.setState({ updateConfirming: true, tasks: [{ id: "t1", state: "running" } as never, { id: "t2", state: "waiting_plan" } as never] });
      let html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-phase="confirming"');
      expect(html).toContain("2 tasks are in progress. Updating restarts ARIA: they stop, and you can resume them after the restart.");
      expect(html).toContain('data-testid="update-bar-confirm"');
      expect(html).toContain('data-testid="update-bar-cancel"');

      useAria.setState({ updateConfirming: false, updateStatus: { phase: "downloading", version: "0.2.0", received: 420_000, total: 1_000_000 } });
      html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-phase="downloading"');
      expect(html).toContain("Downloading ARIA v0.2.0…");
      expect(html).toContain("42%");
      expect(html).toContain("width:42%");

      useAria.setState({ updateStatus: { phase: "installing", version: "0.2.0" } });
      expect(renderToStaticMarkup(<UpdateBar />)).toContain("Restarting ARIA to install v0.2.0…");
    });

    it("offers Update when they're done only while tasks are in progress, then says it waits for them", () => {
      useAria.setState({ updateConfirming: true, tasks: [] });
      let html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain("Updating restarts ARIA.");
      expect(html).not.toContain('data-testid="update-bar-when-done"');

      useAria.setState({ tasks: [{ id: "t1", state: "running" } as never] });
      html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-testid="update-bar-when-done"');
      expect(html).toContain("Update when it&#x27;s done");
      useAria.setState({ tasks: [{ id: "t1", state: "running" } as never, { id: "t2", state: "starting" } as never] });
      expect(renderToStaticMarkup(<UpdateBar />)).toContain("Update when they&#x27;re done");

      useAria.setState({ updateConfirming: false, updateStatus: { phase: "waiting", version: "0.2.0" } });
      html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-phase="waiting"');
      expect(html).toContain("ARIA v0.2.0 is ready. It installs, and ARIA restarts, once no task is in progress.");
      expect(html).toContain('data-testid="update-bar-cancel-wait"');
      expect(html).toContain('data-testid="update-bar-restart-now"');
    });

    it("says why it failed, with Download instead, Later and Try again", () => {
      useAria.setState({ updateStatus: { phase: "failed", version: "0.2.0", reason: "The download stopped before the end." } });
      const html = renderToStaticMarkup(<UpdateBar />);
      expect(html).toContain('data-phase="failed"');
      expect(html).toContain("Couldn&#x27;t update to v0.2.0.");
      expect(html).toContain("The download stopped before the end.");
      expect(html).toContain('data-testid="update-bar-download"');
      expect(html).toContain('data-testid="update-bar-later"');
      expect(html).toContain('data-testid="update-bar-retry"');
    });

    it("gives What's New's banner Update now and Later", () => {
      useAria.setState({ whatsNewModalOpen: true });
      const html = renderToStaticMarkup(<WhatsNewModal />);
      expect(html).toContain('data-testid="update-available-install"');
      expect(html).toContain('data-testid="update-available-later"');
      expect(html).toContain('data-testid="update-available-release"');
      expect(html).not.toContain('data-testid="update-available-download"');
    });
  });
});
