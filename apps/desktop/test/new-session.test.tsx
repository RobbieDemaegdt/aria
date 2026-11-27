import type { AriaApi, Project, Task } from "@aria/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { NewSessionDialog } from "../src/renderer/src/components/NewSessionDialog";
import { SessionView } from "../src/renderer/src/components/SessionView";
import { useAria } from "../src/renderer/src/store";

const api: Partial<AriaApi> = {
  pickFiles: async () => ["C:\\docs\\spec.pdf"],
};
(globalThis as { window?: unknown }).window = { aria: api };

describe("NewSessionDialog files and extra context", () => {
  const project: Project = {
    id: 1,
    name: "Demo Project",
    path: "C:\\Demo",
    addedVia: "scan",
    pinned: false,
    hidden: false,
  };

  beforeEach(() => {
    useAria.setState({
      projects: [project],
      profiles: [
        {
          id: "p1",
          name: "Fast",
          model: "claude-haiku-5.5",
          mode: "autopilot",
          isDefault: true,
        },
      ],
      integrations: { servers: [], tools: [], runtimeUp: true, refreshing: false },
      tasks: [],
      newSession: null,
      openTaskId: null,
      transcripts: {},
      actionError: null,
    });
  });

  it("renders extra context and file attachments inputs in new session dialog", () => {
    useAria.setState({
      newSession: { projectId: 1 },
    });

    const html = renderToStaticMarkup(<NewSessionDialog />);
    expect(html).toContain('data-testid="new-session"');
    expect(html).toContain('data-testid="new-session-brief"');
    expect(html).toContain('data-testid="new-session-extra-context"');
    expect(html).toContain('data-testid="new-session-add-files"');
    expect(html).toContain('data-testid="new-session-file-input"');
    expect(html).toContain('data-testid="new-session-add-file-btn"');
    expect(html).toContain("Attach files…");
    expect(html).toContain("Extra context (optional)");
  });

  it("renders prefilled extra context and files when provided in newSession", () => {
    useAria.setState({
      newSession: {
        projectId: 1,
        extraContext: "Keep architecture stateless",
        files: ["C:\\docs\\design.md", "src\\utils.ts"],
      },
    });

    const html = renderToStaticMarkup(<NewSessionDialog />);
    expect(html).toContain("Keep architecture stateless");
    expect(html).toContain('data-testid="new-session-file-list"');
    expect(html).toContain("design.md");
    expect(html).toContain("utils.ts");
    expect(html).toContain('data-testid="new-session-remove-file-0"');
    expect(html).toContain('data-testid="new-session-remove-file-1"');
  });

  it("renders session files badge in SessionView when task has files", () => {
    const task: Task = {
      id: "task-with-files",
      slug: "task-with-files",
      title: "Task with files",
      brief: "Implement feature",
      repoId: 1,
      repoName: "Demo Project",
      repoPath: "C:\\Demo",
      profileName: "Fast",
      model: "claude-haiku-5.5",
      mode: "autopilot",
      state: "running",
      costCredits: 0,
      startedBy: "you",
      createdAt: 1000,
      updatedAt: 1000,
      extraContext: "Some extra context",
      files: ["C:\\docs\\spec.pdf", "C:\\data\\test.json"],
    };

    useAria.setState({
      tasks: [task],
      openTaskId: "task-with-files",
    });

    const html = renderToStaticMarkup(<SessionView />);
    expect(html).toContain('data-testid="session-files-badge"');
    expect(html).toContain("2 files");
  });
});
