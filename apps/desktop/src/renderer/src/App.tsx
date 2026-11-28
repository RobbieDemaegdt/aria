import { Component, useEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AutomationsView } from "./components/AutomationsView";
import { Chat } from "./components/Chat";
import { Customize } from "./components/Customize";
import { Inspector } from "./components/Inspector";
import { MyWork } from "./components/MyWork";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { OnboardingModal, OnboardingTour, WhatsNewModal } from "./components/Onboarding";
import { QuickPromptBar } from "./components/QuickPromptBar";
import { SearchView } from "./components/SearchView";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { TimeView } from "./components/TimeView";
import { UpdateBar } from "./components/UpdateBar";
import { sidebarPanel, toggleSidebar } from "./sidebar";
import { useAria } from "./store";

class ViewErrorBoundary extends Component<
  { resetKey: string; onBack?: () => void; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidUpdate(prevProps: { resetKey: string }): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs" data-testid="view-error-boundary">
        <div className="text-sm font-semibold text-bad">Something went wrong in this view</div>
        <div className="max-w-md font-mono text-muted">{this.state.error.message}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded border border-line bg-raised px-2.5 py-1 text-fg hover:border-accent"
          >
            Try again
          </button>
          {this.props.onBack && (
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
                this.props.onBack?.();
              }}
              className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90"
            >
              Back to ARIA
            </button>
          )}
        </div>
      </div>
    );
  }
}

export function App() {
  const loaded = useAria((s) => s.loaded);
  const view = useAria((s) => s.ui.view);
  const sidebarCollapsed = useAria((s) => s.ui.sidebarCollapsed);
  const openTaskId = useAria((s) => s.openTaskId);
  const inspecting = useAria((s) => s.inspecting);
  const myWorkOpen = useAria((s) => s.myWorkOpen);
  const sessionFull = useAria((s) => s.sessionFull);
  // The session pane shows a task, ARIA's inspector, or My work (PLAN.md §5.2).
  const sessionOpen = openTaskId !== null || inspecting || myWorkOpen;
  const load = useAria((s) => s.load);
  const setSidebarCollapsed = useAria((s) => s.setSidebarCollapsed);
  const restored = useRef(false);

  useEffect(() => {
    void load();
  }, [load]);

  // Restore the remembered sidebar state once, after the first load.
  useEffect(() => {
    if (!loaded || restored.current || !sidebarPanel.current) return;
    restored.current = true;
    if (sidebarCollapsed) sidebarPanel.current.collapse();
  }, [loaded, sidebarCollapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useAria.getState().openSearch();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.code === "Space" || e.key === " ")) {
        e.preventDefault();
        useAria.getState().toggleQuickPrompt();
        return;
      }
      // Escape closes the session view, unless a dialog is open or it would throw away something you're typing.
      if (e.key === "Escape" && !e.defaultPrevented) {
        const state = useAria.getState();
        if (state.quickPromptOpen) {
          state.closeQuickPrompt();
          return;
        }
        if (state.tourActive) {
          state.stopTour(false);
          return;
        }
        if (state.onboardingModalOpen) {
          state.closeOnboardingModal();
          return;
        }
        if (state.whatsNewModalOpen) {
          state.closeWhatsNewModal();
          return;
        }
        if (state.newSession) return;
        const target = e.target;
        if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value.trim()) return;
        if (target instanceof HTMLElement && target.isContentEditable) return;
        if (state.openTaskId || state.inspecting || state.myWorkOpen) {
          state.closeTask();
        } else if (state.ui.view === "search" && !state.searchQuery.trim()) {
          state.setView("chat");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return <div className="flex h-full items-center justify-center text-muted">Starting ARIA…</div>;

  return (
    <>
      <div className="flex h-full flex-col">
        <UpdateBar />
        <Group orientation="horizontal" className="min-h-0 flex-1">
          <Panel
            id="sidebar"
            panelRef={sidebarPanel}
            defaultSize={260}
            minSize={180}
            maxSize={440}
            collapsible
            collapsedSize={0}
            onResize={() => setSidebarCollapsed(sidebarPanel.current?.isCollapsed() ?? false)}
          >
            <Sidebar />
          </Panel>
          <Separator className="w-px bg-line transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent" />
          {!(sessionOpen && sessionFull) && (
            <Panel id="main" minSize={380}>
              <ViewErrorBoundary
                resetKey={view}
                {...(view !== "chat" ? { onBack: () => useAria.getState().setView("chat") } : {})}
              >
                {view === "customize" ? (
                  <Customize />
                ) : view === "time" ? (
                  <TimeView />
                ) : view === "search" ? (
                  <SearchView />
                ) : view === "automations" ? (
                  <AutomationsView />
                ) : (
                  <Chat />
                )}
              </ViewErrorBoundary>
            </Panel>
          )}
          {sessionOpen && !sessionFull && <Separator className="w-px bg-line transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent" />}
          {sessionOpen && (
            <Panel id="session" defaultSize={560} minSize={380}>
              <ViewErrorBoundary
                resetKey={`${inspecting}:${myWorkOpen}:${openTaskId ?? ""}`}
                onBack={() => useAria.getState().closeTask()}
              >
                {inspecting ? <Inspector /> : myWorkOpen ? <MyWork /> : <SessionView />}
              </ViewErrorBoundary>
            </Panel>
          )}
        </Group>
      </div>
      <NewSessionDialog />
      <QuickPromptBar />
      <OnboardingModal />
      <WhatsNewModal />
      <OnboardingTour />
    </>
  );
}
