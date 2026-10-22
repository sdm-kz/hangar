import { useEffect, useMemo, useState } from "react";
import { ApiError, type Api } from "@/lib/api";
import { homeNodeId, useApi } from "@/lib/node";
import { mentionsOtherPaths } from "@/lib/carry";
import type { ClaudeMemoryFile, ClaudeMemoryListing, SessionInfo } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ArrowRightLeft, Brain, Loader2 } from "lucide-react";
import { FolderPicker } from "./FolderPicker";
import { NodePicker, type LaunchNode } from "./NodePicker";

export type CarryMode = "continue" | "memory";

/** How a memory file of the session's folder stands against the target folder's. */
type Standing = "new" | "same" | "differs" | "tooLarge";

interface MemoryRow {
  file: ClaudeMemoryFile;
  standing: Standing;
  /** It names paths of the other kind of machine: worth a look before it goes. */
  foreign: boolean;
}

/**
 * Carry a session's work to another machine (plans/multi-node.md, phase 6): its conversation, resumed there
 * in the folder the repo sits at on that machine, and the memory Claude keeps for the folder — or the
 * memory alone.
 *
 * Mounted inside the picked machine's {@link NodeProvider}: its folder picker browses there, and every call
 * that writes goes there. That machine reads the session's machine through its own pairing, as a paste
 * between machines does; the conversation it resumes is a fork (`--fork-session`), so the two machines never
 * hold one conversation id that each goes on writing.
 */
export function CarryDialog({
  session,
  mode,
  from,
  fromName,
  sourceApi,
  nodes,
  node,
  onNodeChange,
  suggestFolder,
  onDone,
  onClose,
}: {
  /** The session whose work is carried. */
  session: SessionInfo;
  mode: CarryMode;
  /** The machine it is on: null for the one this page came from. */
  from: string | null;
  fromName: string;
  /** The client of the machine it is on — handed in, since everything else here is the target's. */
  sourceApi: Api;
  /** The machines it can go to, the one it is on left out. */
  nodes: LaunchNode[];
  /** The machine picked to carry it to. */
  node: string | null;
  onNodeChange: (node: string | null) => void;
  /** A folder on a machine to start from: where the session's repo seems to be there, or "". */
  suggestFolder: (node: string | null) => string;
  /** After a continue: the session started there. */
  onDone: (created: SessionInfo | null) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const targetName = nodes.find((n) => n.id === node)?.name ?? "that machine";
  const [dir, setDir] = useState(() => suggestFolder(node));
  const [source, setSource] = useState<ClaudeMemoryListing | null>(null);
  const [target, setTarget] = useState<ClaudeMemoryListing | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [closeHere, setCloseHere] = useState(session.state === "Running");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const conversation = session.claudeSessionId;
  const continuing = mode === "continue";

  // The folder's memory where the session is: read once.
  useEffect(() => {
    let gone = false;
    sourceApi
      .claudeMemory(session.workingDirectory)
      .then((l) => !gone && setSource(l))
      .catch((e) => !gone && setError(e instanceof ApiError ? e.message : "Couldn't read this folder's memory."));
    return () => {
      gone = true;
    };
  }, [sourceApi, session.workingDirectory]);

  // ...and what the folder picked there already has, asked again as the folder changes.
  useEffect(() => {
    setTarget(null);
    if (!dir.trim()) return;
    let gone = false;
    const t = setTimeout(() => {
      api
        .claudeMemory(dir.trim())
        .then((l) => !gone && setTarget(l))
        .catch(() => !gone && setTarget({ folder: dir, files: [] }));
    }, 300);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [api, dir]);

  const rows = useMemo<MemoryRow[]>(() => {
    if (!source) return [];
    const there = new Map((target?.files ?? []).map((f) => [f.name, f]));
    return source.files.map((file) => {
      const have = there.get(file.name);
      const standing: Standing =
        file.content === null ? "tooLarge" : !have ? "new" : have.content === file.content ? "same" : "differs";
      return { file, standing, foreign: !!file.content && !!dir && mentionsOtherPaths(file.content, dir) };
    });
  }, [source, target, dir]);

  // Ticked to start with: whatever is new there. One that differs is theirs until you say to replace it.
  useEffect(() => {
    setPicked(new Set(rows.filter((r) => r.standing === "new").map((r) => r.file.name)));
  }, [rows]);

  const toggle = (name: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const targetOk = nodes.some((n) => n.id === node && !n.unavailable);
  const ready = targetOk && !!dir.trim() && !!source && !!target && !busy && !result;
  const canGo = ready && (continuing ? !!conversation : picked.size > 0);

  async function go() {
    // The session's machine as the one it goes to knows it: this page's own by its id, a peer by its.
    const fromId = from ?? homeNodeId();
    if (!fromId) {
      setError("This machine's id isn't known yet. Try again in a moment.");
      return;
    }
    const toDir = dir.trim();
    setBusy(true);
    setError(null);
    try {
      if (picked.size > 0) {
        const names = [...picked];
        const replace = rows.filter((r) => r.standing === "differs" && picked.has(r.file.name)).map((r) => r.file.name);
        const merged = await api.importClaudeMemory(fromId, session.workingDirectory, toDir, names, replace);
        if (!continuing) {
          setResult(memorySummary(merged.copied.length, merged.same.length + merged.kept.length, merged.missing.length));
          return;
        }
      }
      if (!continuing || !conversation) return;
      await api.importConversation(fromId, conversation, toDir);
      const created = await api.createSession({
        workingDirectory: toDir,
        name: session.name,
        remoteControl: session.remoteControl,
        model: session.model,
        permissionMode: session.permissionMode,
        color: session.color,
        resumeSessionId: conversation,
        forkSession: true,
      });
      if (closeHere && session.state === "Running") {
        // Started there already: a session left running here is a second copy, not a failure.
        await sourceApi.stopSession(session.id).catch(() => undefined);
      }
      onDone(created);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : continuing ? "Couldn't continue it there." : "Couldn't copy the memory.");
    } finally {
      setBusy(false);
    }
  }

  const Icon = continuing ? ArrowRightLeft : Brain;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4" />
            {continuing ? "Continue on another machine" : "Copy memory to another machine"}
          </DialogTitle>
          <DialogDescription>
            {continuing ? (
              <>
                Starts <span className="font-medium text-foreground">{session.name}</span>&rsquo;s conversation on
                another machine, in the folder the repo is at there. The conversation here stays as it is.
              </>
            ) : (
              <>
                Copies what Claude remembers about{" "}
                <span className="font-mono text-foreground">{session.workingDirectory}</span> to a folder on another
                machine. Nothing there is replaced unless you tick it.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canGo) void go();
          }}
          className="flex min-w-0 flex-col gap-4"
        >
          <NodePicker nodes={nodes} value={node} onChange={onNodeChange} label="To" disabled={busy} />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Folder on {targetName}</Label>
            <FolderPicker value={dir} onChange={setDir} />
            <p className="truncate text-[11px] text-muted-foreground" title={session.workingDirectory}>
              On {fromName}: <span className="font-mono">{session.workingDirectory}</span>
            </p>
          </div>

          {continuing && !conversation && (
            <p className="text-sm text-destructive">
              This session hasn&rsquo;t reported its conversation id yet — send it a message first.
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Claude&rsquo;s memory for this folder</Label>
            {!source ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Reading…
              </p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Claude has no memory for this folder on {fromName}.</p>
            ) : (
              <ul className="max-h-60 space-y-1 overflow-auto rounded-md border p-1.5">
                {rows.map((r) => {
                  const disabled = r.standing === "same" || r.standing === "tooLarge" || !target || busy;
                  return (
                    <li key={r.file.name}>
                      <label className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-accent has-[:disabled]:cursor-default">
                        <Checkbox
                          className="mt-0.5"
                          checked={picked.has(r.file.name)}
                          disabled={disabled}
                          onCheckedChange={(v) => toggle(r.file.name, v === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-xs">{r.file.name}</span>
                            <StandingTag standing={r.standing} targetName={targetName} />
                            {r.foreign && (
                              <span
                                className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400"
                                title={`It names paths on ${fromName}. It may not hold on ${targetName}.`}
                              >
                                mentions {fromName} paths
                              </span>
                            )}
                          </span>
                          {r.file.description && (
                            <span className="line-clamp-2 text-[11px] text-muted-foreground">{r.file.description}</span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {continuing && session.state === "Running" && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={closeHere} disabled={busy} onCheckedChange={(v) => setCloseHere(v === true)} />
              Close it on {fromName} once it has started there
            </label>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && <p className="text-sm text-emerald-600 dark:text-emerald-400">{result}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {result ? "Close" : "Cancel"}
            </Button>
            {!result && (
              <Button type="submit" disabled={!canGo}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
                {continuing ? `Continue on ${targetName}` : `Copy to ${targetName}`}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StandingTag({ standing, targetName }: { standing: Standing; targetName: string }) {
  const [text, title] =
    standing === "new"
      ? ["new", `${targetName} has no memory by this name.`]
      : standing === "same"
        ? ["already there", `${targetName} has it, word for word.`]
        : standing === "differs"
          ? ["differs", `${targetName} has its own version. Tick to replace it with this one.`]
          : ["too large", "Too large to carry."];
  return (
    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title={title}>
      {text}
    </span>
  );
}

function memorySummary(copied: number, left: number, missing: number): string {
  const parts = [`Copied ${copied} ${copied === 1 ? "memory" : "memories"}`];
  if (left) parts.push(`${left} left as ${left === 1 ? "it was" : "they were"}`);
  if (missing) parts.push(`${missing} no longer there to copy`);
  return parts.join(", ") + ".";
}
