import { Code2, FileText, Globe, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildHtmlSrcDoc, splitFrontmatter, type PreviewKind } from "../filePreview";
import { Markdown } from "./Markdown";

export interface FilePreviewProps {
  path: string;
  kind: PreviewKind;
  /** Content already on hand (from tool arguments or diff lines), shown right away and used as fallback. */
  fallbackContent?: string | undefined;
  /** When set, the full file can be read from the task's worktree. */
  taskId?: string | undefined;
  /** Whether to read the full file from the worktree (e.g. for edited files or truncated tool args). */
  loadFromWorktree?: boolean | undefined;
  /** Bumped when the task changes state or commits, so the preview refreshes. */
  reloadKey?: string | number | undefined;
}

/**
 * Renders a `.md` or `.html` file created or modified by a session as a clean UI:
 * - Markdown files render with GFM tables, task lists, syntax-highlighted code blocks, and optional YAML frontmatter cards.
 * - HTML files render inside a locked-down `<iframe sandbox="" srcDoc={...}>` with default styling and expand toggle.
 */
export function FilePreview({ path, kind, fallbackContent, taskId, loadFromWorktree = false, reloadKey }: FilePreviewProps) {
  const targetKey = `${taskId ?? ""}:${path}`;
  const [worktreeFile, setWorktreeFile] = useState<{ key: string; content: string; truncated: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const shouldLoad = Boolean(taskId && (loadFromWorktree || !fallbackContent));

  useEffect(() => {
    if (!shouldLoad || !taskId || typeof window === "undefined" || !window.aria?.getTaskFile) return;
    let cancelled = false;
    void window.aria
      .getTaskFile(taskId, path)
      .then((res) => {
        if (!cancelled) {
          setWorktreeFile(res ? { key: targetKey, content: res.content, truncated: res.truncated } : null);
        }
      })
      .catch(() => {
        if (!cancelled) setWorktreeFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, taskId, path, targetKey, reloadKey]);

  const currentWorktreeFile = worktreeFile?.key === targetKey ? worktreeFile : null;
  const content = currentWorktreeFile?.content ?? fallbackContent ?? "";
  const truncated = currentWorktreeFile?.truncated ?? false;

  const parsedMd = useMemo(() => (kind === "markdown" ? splitFrontmatter(content) : null), [kind, content]);
  const srcDoc = useMemo(() => (kind === "html" ? buildHtmlSrcDoc(content) : ""), [kind, content]);

  const fileName = path.split(/[\\/]/).pop() || path;

  return (
    <div
      className="overflow-hidden rounded-md border border-line bg-panel/60"
      data-testid="file-preview"
      data-preview-kind={kind}
      data-path={path}
    >
      <div className="flex items-center gap-2 border-b border-line bg-raised/70 px-2.5 py-1 text-[11px] text-muted">
        {kind === "markdown" ? <FileText className="h-3.5 w-3.5 shrink-0 text-accent" /> : <Globe className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="truncate font-mono text-fg/90" title={path}>
          {fileName}
        </span>
        <span
          className="rounded border border-line bg-canvas px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted"
          data-testid="file-preview-badge"
        >
          {kind === "markdown" ? "Markdown" : "HTML UI"}
        </span>
        {kind === "html" && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted" title="Rendered in an isolated sandboxed frame (scripts disabled)">
            <Code2 className="h-3 w-3" /> sandboxed
          </span>
        )}
        <button
          type="button"
          data-testid="file-preview-expand"
          aria-label={expanded ? "Compact preview" : "Expand preview"}
          title={expanded ? "Compact height" : "Expand height"}
          onClick={() => setExpanded(!expanded)}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-canvas hover:text-fg"
        >
          {expanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          <span>{expanded ? "Compact" : "Expand"}</span>
        </button>
      </div>

      {!content.trim() ? (
        <div className="px-3 py-4 text-xs text-muted" data-testid="file-preview-empty">
          Empty {kind === "markdown" ? "Markdown" : "HTML"} file.
        </div>
      ) : kind === "markdown" && parsedMd ? (
        <div className={`${expanded ? "max-h-[680px]" : "max-h-96"} overflow-y-auto bg-canvas/80 px-4 py-3 text-sm`} data-testid="markdown-preview-body">
          {parsedMd.frontmatter.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-line bg-panel px-3 py-2 text-xs" data-testid="md-frontmatter">
              {parsedMd.frontmatter.map((field) => (
                <div key={field.key} className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[11px] text-muted">{field.key}:</span>
                  <span className="font-medium text-fg">{field.value}</span>
                </div>
              ))}
            </div>
          )}
          <div className="md-doc">
            <Markdown text={parsedMd.body} />
          </div>
        </div>
      ) : (
        <iframe
          data-testid="html-preview-frame"
          sandbox=""
          srcDoc={srcDoc}
          title={`Preview of ${path}`}
          className={`${expanded ? "h-[600px]" : "h-80"} min-h-44 w-full resize-y border-0 bg-canvas`}
        />
      )}

      {truncated && (
        <div className="border-t border-line bg-raised/50 px-3 py-1 text-[11px] text-warn" data-testid="file-preview-truncated">
          Preview cut off at 512 KB. Open the worktree in VS Code to view the entire file.
        </div>
      )}
    </div>
  );
}
