import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { sessionKey, useApi, useNodeId } from "@/lib/node";
import { newSessionChat, setChatView, setNewSessionChat } from "@/lib/chatView";
import { NodePicker, type LaunchNode } from "./NodePicker";
import { folderName } from "@/lib/recentFolders";
import { cn } from "@/lib/utils";
import { ProjectGlyph } from "./ProjectGlyph";
import { sameRecent, type RecentSession } from "@/lib/recentSessions";
import { buildPrompt, templateFolderChoices, templateSections } from "@/lib/templates";
import type { Project, SessionInfo, SessionTemplate } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FolderPicker, FolderChips } from "./FolderPicker";
import {
  DEFAULT_LAUNCH,
  LaunchFields,
  ToggleCard,
  launchFromTemplate,
  type LaunchOptions,
} from "./LaunchOptions";
import { TemplateDialog } from "./TemplateDialog";
import {
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";

/** Which half of the dialog is showing: a session set up by hand, or one started from a template. */
type Tab = "new" | "templates";

export function NewSessionDialog({
  open,
  onOpenChange,
  onCreated,
  preset,
  project,
  projects,
  defaultContinue,
  defaultChat,
  nodes = [],
  node = null,
  origin = null,
  onNodeChange,
}: {
  /**
   * The machines it can launch on, this one first (plans/multi-node.md §7). The dialog sits inside the
   * picked one's NodeProvider: its folder picker, recents, templates and the launch itself all go there.
   */
  nodes?: LaunchNode[];
  node?: string | null;
  /** The machine it was opened from, whose the preset, the project and their conversation are. */
  origin?: string | null;
  onNodeChange?: (node: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (s: SessionInfo) => void;
  /** When opened from the Recent tab, prefill the form with this preset. */
  preset?: RecentSession | null;
  /**
   * When opened from a project's "+", the project to start in: its linked folders are offered as
   * one-click picks. The folder picker still takes anything else — starting somewhere new is a
   * perfectly ordinary thing to do from here, and the project just saves the typing.
   */
  project?: Project | null;
  /** Every project, for the Templates tab's headings and its editor's project dropdown. */
  projects?: Project[];
  /** Overrides the "continue conversation" default (normally on for presets, off otherwise). */
  defaultContinue?: boolean;
  /**
   * The view it opens on, when it reopens a closed session: the one that session was left on. Otherwise
   * the last new session's, and this launch becomes the next one's default.
   */
  defaultChat?: boolean;
}) {
  const api = useApi();
  const nodeId = useNodeId();
  const [tab, setTab] = useState<Tab>("new");
  // Whether the session opens on its chat or its terminal. Starts where the last one started from here did.
  const [chat, setChat] = useState(newSessionChat);

  // ---- the hand-made session (the "New" tab) --------------------------------------------------
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [launch, setLaunch] = useState<LaunchOptions>(DEFAULT_LAUNCH);
  const [continueSession, setContinueSession] = useState(false); // resume the folder's last conversation

  // ---- the template launch (the "Templates" tab) ----------------------------------------------
  // Its own copy of the folder, name and settings rather than the fields above: the two tabs are two
  // launches being set up side by side, and picking a template overwrites all three — which would
  // quietly eat whatever had been typed into the other tab if they shared.
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [input, setInput] = useState(""); // the detail pasted in: the log entry, the Jira key
  const [tDir, setTDir] = useState("");
  const [tName, setTName] = useState("");
  const [tLaunch, setTLaunch] = useState<LaunchOptions>(DEFAULT_LAUNCH);
  const [showOptions, setShowOptions] = useState(false);
  // The template being edited, or { template: null } while one is being created. A separate popup
  // over this one, the way the confirm dialog stacks over the project settings.
  const [editing, setEditing] = useState<{ template: SessionTemplate | null } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  // The preset as the server currently has it. The one we're handed came from the session list's last
  // load, which may predate the server stamping a conversation id onto it (that happens once Claude's
  // first hook arrives, seconds after launch).
  const [stored, setStored] = useState<RecentSession | null>(null);

  // The exact conversation "continue" will resume, when the server has stamped one onto this preset.
  // Tied to the folder: point the form somewhere else and the id no longer applies, so we fall back to
  // plain --continue (the folder's most recent conversation).
  // ...and only on the machine it was opened from: that conversation is in that machine's transcripts.
  const presetId = node === origin ? (stored?.claudeSessionId ?? preset?.claudeSessionId ?? null) : null;
  const resumeId = presetId && preset?.workingDirectory === dir.trim() ? presetId : null;

  const allProjects = projects ?? (project ? [project] : []);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const sections = templateSections(templates, allProjects);
  // The project a template belongs to, for its folder chips — its own, not the one this dialog was
  // opened from.
  const templateProject = allProjects.find((p) => p.id === template?.projectId) ?? null;

  // Refresh the recent-folders list each time the dialog opens — and each time another machine is picked:
  // the folders, like the templates below, are that machine's.
  useEffect(() => {
    if (!open) return;
    let gone = false;
    api
      .getRecents()
      .then((r) => {
        if (gone) return;
        setRecents(r.folders);
        setStored(preset ? r.sessions.find((s) => sameRecent(s, preset)) ?? null : null);
      })
      .catch(() => {});
    // Templates are read fresh too: they are edited from here and from the project settings, so the
    // list a browser opened an hour ago is not necessarily the list on the server.
    api
      .getTemplates()
      .then((list) => !gone && setTemplates(list))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [open, api, preset]);

  /**
   * What is filled in from a machine's disk — a folder, its recents, its templates. It belongs to the machine
   * it came from (`filledFor`): opened on another one, or switched to another, the dialog starts those over.
   */
  const filledFor = useRef(node);
  const nodeNow = useRef(node);
  nodeNow.current = node;
  const clearMachine = () => {
    setDir("");
    setTDir("");
    setRecents([]);
    setTemplates([]);
    setTemplateId(null);
    setStored(null);
  };
  // Read when the dialog opens, not followed: the project goes away when another machine is picked, and a
  // peer's project objects are replaced whenever its projects are re-read — neither is a reason to fill
  // the form in again over what has been chosen since.
  const projectNow = useRef(project);
  projectNow.current = project;

  // Prefill from a preset if given.
  useEffect(() => {
    if (!open) return;
    if (filledFor.current !== nodeNow.current) {
      clearMachine();
      filledFor.current = nodeNow.current;
    }
    const project = projectNow.current;
    setError(null);
    setStored(null); // until the refresh above lands
    // Reusing a preset is a "New" tab errand by definition — it *is* a filled-in form.
    setTab("new");
    setTemplateId(null);
    setInput("");
    setShowOptions(false);
    setChat(defaultChat ?? newSessionChat());
    // Relaunching a remembered preset almost always means picking the work back up, so default to
    // continuing its conversation; a plain "New session" starts fresh. Some openers override this
    // (cloning a live session wants a fresh conversation alongside the original).
    setContinueSession(defaultContinue ?? !!preset);
    // A preset's settings are prefilled; without one the last launch's are kept, so a model or a
    // permission mode picked once holds for the next session started from this page.
    setLaunch((prev) =>
      preset
        ? {
            model: preset.model,
            remoteControl: preset.remoteControl,
            permissionMode: preset.permissionMode || "auto",
          }
        : prev
    );
    // A project with exactly one linked folder has an unambiguous answer, so fill it in. With several
    // there is nothing to guess between, and the chips below are one click away.
    if (project && !preset) setDir(project.folders.length === 1 ? project.folders[0] : "");
    if (preset) {
      setDir(preset.workingDirectory);
      setName(preset.name);
      setCommand(preset.command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset, defaultContinue, defaultChat]);

  /** Picking a template fills the launch in from it; the fields below stay editable for this run. */
  const pickTemplate = (t: SessionTemplate) => {
    // Re-picking the one already selected keeps what has been typed into the details box. That path
    // is not hypothetical: saving an edit re-picks the template, and losing a pasted stack trace to
    // a trip through its settings would be a nasty little surprise.
    if (t.id !== templateId) setInput("");
    setTemplateId(t.id);
    setTDir(t.workingDirectory);
    // The template's name is the obvious name for the session it starts ("MH Log Issue"), and Claude
    // renames itself once it knows what the errand turned out to be.
    setTName(t.name);
    setTLaunch(launchFromTemplate(t));
    setError(null);
    // A template with no folder yet can't launch, so open the settings where that is fixed rather
    // than failing on the button with the field folded away.
    setShowOptions(!t.workingDirectory.trim());
  };

  /**
   * Another machine: what was filled in from this one's disk — a folder, a recent, a template — means
   * nothing there and goes. The name, the start command and the launch options carry over.
   */
  const pickNode = (id: string | null) => {
    if (id === node || busy) return;
    onNodeChange?.(id);
    clearMachine();
    filledFor.current = id;
    setError(null);
    // Continuing means a conversation on the machine it was opened from; anywhere else there is none to
    // continue — and --continue there would pick up whatever last ran in a folder of the same name.
    setContinueSession(id === origin ? (defaultContinue ?? !!preset) : false);
  };
  const picked = nodes.find((n) => n.id === node);

  async function create() {
    const fromTemplate = tab === "templates";
    if (picked?.unavailable) {
      setError(`${picked.name}: ${picked.unavailable}`);
      return;
    }
    if (fromTemplate && !template) {
      setError("Pick a template");
      return;
    }
    const folder = (fromTemplate ? tDir : dir).trim();
    if (!folder) {
      setError("Choose a working folder");
      if (fromTemplate) setShowOptions(true);
      return;
    }
    const opts = fromTemplate ? tLaunch : launch;
    const label = (fromTemplate ? tName : name).trim();
    const prompt = fromTemplate ? buildPrompt(template!.prompt, input) : command.trim();

    setBusy(true);
    setError(null);
    try {
      const s = await api.createSession({
        workingDirectory: folder,
        name: label || null,
        remoteControl: opts.remoteControl,
        model: opts.model || null,
        initialPrompt: prompt || null,
        permissionMode: opts.permissionMode,
        // Continuing a conversation skips the start command, so it is never offered for a template —
        // the prompt *is* the point of the launch.
        continue: !fromTemplate && continueSession,
        resumeSessionId: !fromTemplate && continueSession ? resumeId : null,
      });
      // Remember the folder server-side for quick reuse next time. Fire-and-forget: a failure here
      // shouldn't block the (already created) session.
      await api.addRecentFolder(folder).catch(() => {});
      // The full launch preset, but only for a hand-made session: a template is already the reusable
      // thing, and saving one as a recent would fill that list with one-off prompts — this log entry,
      // that Jira key — which are exactly what you'd never want to relaunch verbatim.
      if (!fromTemplate)
        await api
          .addRecentSession({
            workingDirectory: folder,
            name: label,
            command: command.trim(),
            model: opts.model,
            remoteControl: opts.remoteControl,
            permissionMode: opts.permissionMode,
          })
          .catch(() => {});
      // Before the session is shown, so it opens on the view picked here — in this browser and, through
      // the session's saved state, in the others.
      setChatView(sessionKey(nodeId, s.id), chat);
      if (defaultChat === undefined) setNewSessionChat(chat);
      onCreated(s);
      // Reset the transient fields for next time.
      setName("");
      setCommand("");
      setInput("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[90vh] flex-col"
          onOpenAutoFocus={(e) => {
            // Prefilled with a folder (clone / "new session here") — keep the folder picker collapsed
            // instead of auto-focusing its input, which would pop the browser open over the whole form.
            if (preset?.workingDirectory || project) e.preventDefault();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>
              {tab === "templates" ? (
                "Start a session from a template — pick one, then paste in what this run is about."
              ) : project ? (
                <>
                  Start a Claude Code session in{" "}
                  <span className="font-medium text-foreground">{project.name}</span> — pick one of its
                  folders, or any other.
                </>
              ) : (
                "Start a Claude Code session in a working folder."
              )}
            </DialogDescription>
          </DialogHeader>

          <NodePicker nodes={nodes} value={node} onChange={pickNode} disabled={busy} />

          {/* Set up by hand, or from a template. The same row as the sidebar's Sessions/Recent tabs. */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-1">
            <TabButton active={tab === "new"} onClick={() => setTab("new")}>
              New session
            </TabButton>
            <TabButton active={tab === "templates"} onClick={() => setTab("templates")} count={templates.length}>
              <Sparkles className="size-3.5" /> Templates
            </TabButton>
          </div>

          {/* Enter submits (native form submit); the folder picker and the textareas handle Enter
              themselves, so they don't trigger it. The body scrolls on short screens. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            {/* -mx-1 px-1 is not spacing: a scroller clips on both axes, and a control whose edge
                is flush with this box loses whatever it paints *outside* itself there -- which is
                its focus ring, cut clean off down the left while the rest of it draws. The padding
                buys the ring a gutter and the negative margin gives it back, so nothing moves. */}
            <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
              {tab === "new" ? (
                <>
                  <div className="space-y-2">
                    <Label>Working folder</Label>
                    <FolderPicker value={dir} onChange={setDir} />

                    {project && (
                      <FolderChips
                        folders={project.folders}
                        value={dir}
                        onPick={setDir}
                        label={
                          <>
                            <ProjectGlyph project={project} className="size-3" />
                            {project.name}
                          </>
                        }
                        empty="No folders linked yet — choose one above and link it in the project’s settings."
                      />
                    )}

                    {recents.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <History className="size-3" /> Recent
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {recents.map((p) => (
                            <span
                              key={p}
                              className="group flex max-w-full items-center gap-1 rounded-md border pl-2 pr-1 py-1 text-xs hover:bg-accent"
                            >
                              <button
                                type="button"
                                onClick={() => setDir(p)}
                                title={p}
                                className="truncate"
                              >
                                {folderName(p)}
                              </button>
                              <button
                                type="button"
                                title="Remove from recent"
                                onClick={async () => {
                                  const r = await api.removeRecentFolder(p).catch(() => null);
                                  if (r) setRecents(r.folders);
                                }}
                                className="shrink-0 text-muted-foreground opacity-60 hover:text-destructive hover:opacity-100"
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <LaunchFields
                    value={launch}
                    onChange={(p) => setLaunch((v) => ({ ...v, ...p }))}
                    name={name}
                    onName={setName}
                    idPrefix="new"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="command">Start command (optional)</Label>
                      <Textarea
                        id="command"
                        value={command}
                        placeholder="Initial prompt sent to Claude on startup, e.g. “run the tests and fix any failures”"
                        onChange={(e) => setCommand(e.target.value)}
                        className="min-h-20"
                      />
                    </div>

                    <ToggleCard
                      checked={continueSession}
                      onCheckedChange={setContinueSession}
                      icon={<RotateCcw className="size-3.5" />}
                      title="Continue previous conversation"
                    >
                      {resumeId ? (
                        <>
                          Resumes <em>this</em> session&apos;s own conversation (
                          <code className="font-mono">--resume</code>), not just the folder&apos;s most
                          recent one.
                        </>
                      ) : (
                        <>
                          Starts with <code className="font-mono">--continue</code> so Claude picks up the
                          folder&apos;s most recent conversation instead of a blank one.
                        </>
                      )}{" "}
                      The start command is skipped when continuing.
                    </ToggleCard>
                  </LaunchFields>
                </>
              ) : (
                <TemplatesTab
                  sections={sections}
                  total={templates.length}
                  selected={templateId}
                  onPick={pickTemplate}
                  onEdit={(t) => setEditing({ template: t })}
                  onNew={() => setEditing({ template: null })}
                  template={template}
                  templateProject={templateProject}
                  input={input}
                  onInput={setInput}
                  dir={tDir}
                  onDir={setTDir}
                  name={tName}
                  onName={setTName}
                  launch={tLaunch}
                  onLaunch={(p) => setTLaunch((v) => ({ ...v, ...p }))}
                  showOptions={showOptions}
                  onToggleOptions={() => setShowOptions((v) => !v)}
                />
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter className="shrink-0">
              <ViewSwitch chat={chat} onChange={setChat} disabled={busy} />
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || (tab === "templates" && !template)}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Stacked over the dialog above, the way the confirm popup stacks over the project settings.
          Saving replaces the list here, and re-picks the template that was edited so the launch being
          set up below follows the edit. */}
      {editing && (
        <TemplateDialog
          template={editing.template}
          projects={allProjects}
          defaultProjectId={editing.template ? undefined : project?.id ?? null}
          defaultFolder={editing.template ? undefined : dir || project?.folders[0] || ""}
          onSaved={(list) => {
            setTemplates(list);
            const edited = editing.template
              ? list.find((t) => t.id === editing.template!.id)
              : // A new one is appended, so the last entry is it.
                list[list.length - 1];
            if (edited) pickTemplate(edited);
            else setTemplateId(null); // it was deleted
            setTab("templates");
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** Open the new session on its chat or on its terminal. Either way the other is a click away in its tab. */
function ViewSwitch({ chat, onChange, disabled }: { chat: boolean; onChange: (chat: boolean) => void; disabled: boolean }) {
  const option = (on: boolean, Icon: typeof TerminalSquare, label: string, title: string) => (
    <button
      type="button"
      title={title}
      aria-pressed={chat === on}
      disabled={disabled}
      onClick={() => onChange(on)}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors sm:flex-none",
        chat === on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Icon className="size-3.5" /> {label}
    </button>
  );
  return (
    <div role="group" aria-label="Open in" className="flex items-center gap-2 sm:mr-auto">
      <span className="shrink-0 text-xs text-muted-foreground">Open in</span>
      <div className="flex flex-1 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5 sm:flex-none">
        {option(true, MessageSquare, "Chat", "Open the session on its chat")}
        {option(false, TerminalSquare, "Terminal", "Open the session on its terminal")}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="text-xs tabular-nums opacity-70">{count}</span>
      )}
    </button>
  );
}

/**
 * The Templates tab: the templates as a tree under their projects, and — once one is picked — the
 * box for this run's detail, with the launch itself folded away underneath.
 *
 * The folding is the point of the tab. A template already answers the folder, the model and the
 * permission mode; what is left to say is the one thing that changes, so that is the only field
 * showing. Everything a template decided is still there under "Session settings", because a template
 * is a starting point and not a straitjacket.
 */
function TemplatesTab({
  sections,
  total,
  selected,
  onPick,
  onEdit,
  onNew,
  template,
  templateProject,
  input,
  onInput,
  dir,
  onDir,
  name,
  onName,
  launch,
  onLaunch,
  showOptions,
  onToggleOptions,
}: {
  sections: ReturnType<typeof templateSections>;
  total: number;
  selected: string | null;
  onPick: (t: SessionTemplate) => void;
  onEdit: (t: SessionTemplate) => void;
  onNew: () => void;
  template: SessionTemplate | null;
  templateProject: Project | null;
  input: string;
  onInput: (v: string) => void;
  dir: string;
  onDir: (v: string) => void;
  name: string;
  onName: (v: string) => void;
  launch: LaunchOptions;
  onLaunch: (patch: Partial<LaunchOptions>) => void;
  showOptions: boolean;
  onToggleOptions: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Template</Label>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onNew}>
            <Plus className="mr-1 size-3.5" /> New template
          </Button>
        </div>

        {total === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            No templates yet. A template remembers a project, a folder and a prompt — the errands that
            come back — so starting one is picking it and pasting in what this run is about.
          </p>
        ) : (
          <div className="max-h-56 space-y-2 overflow-y-auto overscroll-contain rounded-md border p-1.5">
            {sections.map((sec) => {
              return (
                <div key={sec.project?.id ?? "none"} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                    <ProjectGlyph project={sec.project} className="size-3" />
                    <span className="truncate">{sec.project?.name ?? "No project"}</span>
                  </div>
                  {sec.templates.map((t) => (
                    <div
                      key={t.id}
                      className={cn(
                        "group flex items-center gap-1 rounded-md border pr-1 transition-colors",
                        selected === t.id ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onPick(t)}
                        className="min-w-0 flex-1 px-2 py-1.5 text-left"
                      >
                        <span className="block truncate text-sm">{t.name}</span>
                        {/* The description, or the folder when there is none — either way a second
                            line saying which of two similarly-named templates this is. */}
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {t.description ??
                            (t.workingDirectory
                              ? folderName(t.workingDirectory)
                              : "No folder yet — set one before starting")}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="Edit this template"
                        onClick={() => onEdit(t)}
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {template && (
        <>
          <div className="space-y-2">
            <Label htmlFor="template-input">Details (optional)</Label>
            <Textarea
              id="template-input"
              value={input}
              autoFocus
              placeholder={template.inputHint ?? "What this run is about — paste the error, the request, the issue key…"}
              onChange={(e) => onInput(e.target.value)}
              className="min-h-24"
            />
            {template.prompt && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  What Claude will be sent
                </summary>
                <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
                  {buildPrompt(template.prompt, input) || "(nothing — it starts with a blank prompt)"}
                </pre>
              </details>
            )}
          </div>

          <div className="rounded-lg border">
            <button
              type="button"
              onClick={onToggleOptions}
              aria-expanded={showOptions}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium hover:bg-accent/50"
            >
              {showOptions ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Session settings
              <span className="ml-auto truncate text-xs font-normal text-muted-foreground">
                {dir ? folderName(dir) : "no folder yet"} · {launch.model || "default model"}
              </span>
            </button>
            {showOptions && (
              <div className="space-y-4 border-t p-3">
                <div className="space-y-2">
                  <Label>Working folder</Label>
                  <FolderPicker value={dir} onChange={onDir} />
                  {templateProject && (
                    <FolderChips
                      folders={templateFolderChoices({ workingDirectory: dir }, templateProject)}
                      value={dir}
                      onPick={onDir}
                      label={
                        <>
                          <ProjectGlyph project={templateProject} className="size-3" />
                          {templateProject.name}
                        </>
                      }
                    />
                  )}
                </div>
                <LaunchFields
                  value={launch}
                  onChange={onLaunch}
                  name={name}
                  onName={onName}
                  namePlaceholder={template.name}
                  idPrefix="tmpl-run"
                />
                <p className="text-xs text-muted-foreground">
                  Changes here apply to this session only — the template itself keeps what it had.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
