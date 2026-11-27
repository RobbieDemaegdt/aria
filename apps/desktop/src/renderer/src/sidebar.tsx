import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useAria } from "./store";

/** The sidebar panel's handle, set by App; react-resizable-panels collapses panels imperatively. */
export const sidebarPanel: { current: PanelImperativeHandle | null } = { current: null };

export function toggleSidebar(): void {
  const panel = sidebarPanel.current;
  if (!panel) return;
  if (panel.isCollapsed()) panel.expand();
  else panel.collapse();
}

/** A visible way to collapse and restore the sidebar for mouse users (Ctrl+B does the same). */
export function SidebarToggle() {
  const collapsed = useAria((s) => s.ui.sidebarCollapsed);
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)";
  return (
    <button data-testid="toggle-sidebar" title={label} aria-label={label} onClick={toggleSidebar} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg">
      <Icon className="h-4 w-4" />
    </button>
  );
}
