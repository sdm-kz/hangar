import clsx from "clsx";
import { ArrowLeft, FolderOpen, History, Loader2 } from "lucide-react";
import type { ApiError, NewSessionOptions, NewSessionTarget } from "@/lib/tauri";
import { sessionColor } from "@web/lib/sessionColors";
import { MESSAGE_MIN, PICKER_MIN } from "./Splitter";

export type OptionsState =
  | { kind: "loading" }
  | { kind: "ready"; options: NewSessionOptions }
  | { kind: "error"; error: ApiError | string };

/** The last path segment, for a folder's chip. */
export const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * Where a session started from this capture will run, in place of the session list: a project
 * (optional), the folder, and a group of that project (optional). The message box above becomes its
 * first prompt, and the picture goes with it.
 *
 * A project offers its folders as one-click picks; any other folder is fine too, and one that no
 * project has yet is linked into the chosen project when the session starts. A folder that is
 * already another project's is refused by the server, which says so.
 */
export function NewSessionPanel(props: {
  state: OptionsState;
  value: NewSessionTarget;
  onChange(v: NewSessionTarget): void;
  onBack(): void;
  onRetry(): void;
  onBrowse(): void;
  folderRef: React.RefObject<HTMLInputElement | null>;
  width: number;
  pickerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state, value, onChange } = props;
  const options = state.kind === "ready" ? state.options : null;
  const project = options?.projects.find((p) => p.id === value.projectId) ?? null;
  const set = (patch: Partial<NewSessionTarget>) => onChange({ ...value, ...patch });

  // A project's own folders first, then the recent ones it doesn't already list.
  const projectFolders = project?.folders ?? [];
  const recents = (options?.recentFolders ?? []).filter((f) => !projectFolders.includes(f)).slice(0, 8);

  return (
    <div
      ref={props.pickerRef}
      style={{ width: props.width, maxWidth: `calc(100% - ${MESSAGE_MIN + 12}px)`, minWidth: PICKER_MIN }}
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border px-1.5">
        <button
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={props.onBack}
          title="Back to the running sessions"
        >
          <ArrowLeft size={13} /> Sessions
        </button>
        <span className="truncate text-[12.5px] font-medium">New session</span>
      </div>

      {state.kind === "loading" && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading projects…
        </div>
      )}
      {state.kind === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
          {typeof state.error === "string" ? state.error : state.error.message ?? "Could not load the projects."}
          <button className="text-accent hover:underline" onClick={props.onRetry}>
            Try again
          </button>
        </div>
      )}

      {options && (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5 text-[12.5px]">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Project</span>
            <select
              value={value.projectId ?? ""}
              onChange={(e) => {
                const next = options.projects.find((p) => p.id === e.target.value) ?? null;
                // A project with one folder has an unambiguous answer; and a group only means
                // something inside its own project.
                set({
                  projectId: next?.id ?? null,
                  groupId: null,
                  folder: next && next.folders.length === 1 ? next.folders[0] : value.folder,
                });
              }}
              className="h-7 rounded-md border border-border bg-background px-1.5 outline-none focus:border-accent/70"
            >
              <option value="">None — wherever the folder is</option>
              {options.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Folder</span>
            <div className="flex gap-1">
              <input
                ref={props.folderRef}
                value={value.folder}
                onChange={(e) => set({ folder: e.target.value })}
                placeholder={options.local ? "C:\\path\\to\\project" : "A folder on the server"}
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] outline-none focus:border-accent/70"
              />
              {options.local && (
                <button
                  className="flex h-7 shrink-0 items-center rounded-md border border-border px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(e) => {
                    e.preventDefault();
                    props.onBrowse();
                  }}
                  title="Browse for a folder"
                >
                  <FolderOpen size={14} />
                </button>
              )}
            </div>
          </label>
          {(projectFolders.length > 0 || recents.length > 0) && (
            <div className="flex flex-wrap gap-1">
              {projectFolders.map((f) => (
                <Chip key={f} path={f} selected={samePath(f, value.folder)} onPick={() => set({ folder: f })} color={project?.color} />
              ))}
              {recents.map((f) => (
                <Chip key={f} path={f} selected={samePath(f, value.folder)} onPick={() => set({ folder: f })} recent />
              ))}
            </div>
          )}

          {project && project.groups.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Group</span>
              <select
                value={value.groupId ?? ""}
                onChange={(e) => set({ groupId: e.target.value || null })}
                className="h-7 rounded-md border border-border bg-background px-1.5 outline-none focus:border-accent/70"
              >
                <option value="">None</option>
                {project.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="mt-auto text-[11.5px] leading-snug text-muted-foreground">
            The message becomes the session's first prompt, with the picture.
          </p>
        </div>
      )}
    </div>
  );
}

function samePath(a: string, b: string) {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function Chip(props: { path: string; selected: boolean; onPick(): void; color?: string | null; recent?: boolean }) {
  const dot = sessionColor(props.color ?? null);
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        props.onPick();
      }}
      title={props.path}
      className={clsx(
        "flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px]",
        props.selected ? "border-accent/60 bg-accent/15" : "border-border hover:bg-muted",
      )}
    >
      {props.recent ? (
        <History size={11} className="shrink-0 text-muted-foreground" />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot ?? "var(--muted-foreground)" }} />
      )}
      <span className="truncate">{folderName(props.path)}</span>
    </button>
  );
}
