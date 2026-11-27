import type { CustomizePage } from "@aria/protocol";
import { SidebarToggle } from "../sidebar";
import { useAria } from "../store";
import { CustomizeData } from "./CustomizeData";
import { CustomizeIntegrations } from "./CustomizeIntegrations";
import { CustomizeMemory } from "./CustomizeMemory";
import { CustomizeModels } from "./CustomizeModels";
import { CustomizeNotifications } from "./CustomizeNotifications";
import { CustomizePermissions } from "./CustomizePermissions";
import { CustomizePrompts } from "./CustomizePrompts";

const PAGES: Array<{ page: CustomizePage; label: string }> = [
  { page: "models", label: "Models" },
  { page: "permissions", label: "Permissions" },
  { page: "prompts", label: "Prompts" },
  { page: "notifications", label: "Notifications" },
  { page: "memory", label: "Memory" },
  { page: "integrations", label: "Integrations" },
  { page: "data", label: "Data" },
];

/** Customize (PLAN.md §4.5, §4.8, §4.12, §5.3): models and profiles, what tasks may do on their own, the prompts, notifications, memory, integrations, and the database (D1). */
export function Customize() {
  const page = useAria((s) => s.ui.customizePage ?? "models");
  const setPage = useAria((s) => s.setCustomizePage);
  return (
    <div className="flex h-full flex-col">
      {/* The tabs wrap onto a second line when the window is narrow, instead of running off its edge. */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <SidebarToggle />
        <h1 className="font-semibold">Customize</h1>
        <nav className="flex flex-wrap gap-1" aria-label="Customize pages">
          {PAGES.map((p) => (
            <button
              key={p.page}
              data-testid={`customize-${p.page}`}
              aria-current={page === p.page ? "page" : undefined}
              onClick={() => setPage(p.page)}
              className={`rounded-md px-2.5 py-1 text-sm ${page === p.page ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1">{page === "permissions" ? <CustomizePermissions /> : page === "prompts" ? <CustomizePrompts /> : page === "notifications" ? <CustomizeNotifications /> : page === "memory" ? <CustomizeMemory /> : page === "integrations" ? <CustomizeIntegrations /> : page === "data" ? <CustomizeData /> : <CustomizeModels />}</div>
    </div>
  );
}
