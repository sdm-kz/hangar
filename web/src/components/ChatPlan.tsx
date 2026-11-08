import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ClipboardList, CornerDownLeft, Loader2, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ToolResult } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { typedAnswer } from "./ChatQuestion";

const ENTER = "\r";
const SHIFT_TAB = "\x1b[Z";

// How often the terminal is read for the dialog's choices while the plan waits on them.
const SCREEN_POLL_MS = 500;

/** The plan of an ExitPlanMode input, or null for one that can't be read (cut short, say). */
export function parsePlan(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as { plan?: unknown };
    return typeof parsed.plan === "string" && parsed.plan.trim() ? parsed.plan : null;
  } catch {
    return null;
  }
}

/**
 * The choices of the approval dialog on screen, as numbered under "Would you like to proceed?": every one
 * but the last approves (in Claude Code 2.1, "Yes, and use auto mode" and "Yes, manually approve edits"),
 * and the last is the field for feedback, whatever it shows. Null when the dialog isn't up. Read rather
 * than assumed: how many there are depends on the session's modes, and a wrong count types the wrong key.
 */
export function planOptions(lines: string[]): string[] | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (/would you like to proceed\?/i.test(lines[i])) at = i;
  if (at < 0) return null;
  const options: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s*(?:[>❯›]\s*)?(\d+)\.\s+(.*?)\s*$/);
    if (m) {
      if (Number(m[1]) !== options.length + 1) break;
      options.push(m[2]);
    } else if (options.length > 0 && !line.trim()) break;
  }
  return options.length >= 2 ? options : null;
}

/**
 * The keys that answer the plan dialog. A choice's number picks it at once. The last number puts the
 * cursor in the feedback field; the text then goes in, and Enter sends it back to Claude to keep
 * planning — or Shift+Tab approves the plan (as the first choice does) with the text as a note.
 */
export function planKeys(count: number, answer: { approve: number } | { feedback: string; approve: boolean }): string[] {
  if ("feedback" in answer) return [String(count), typedAnswer(answer.feedback), answer.approve ? SHIFT_TAB : ENTER];
  return [String(answer.approve + 1)];
}

type Outcome = { kind: "approved" } | { kind: "feedback"; text: string } | { kind: "declined" };

/** How the dialog was answered, read off the result Claude got. */
function planOutcome(result: ToolResult): Outcome {
  if (!result.isError) return { kind: "approved" };
  const said = result.text.match(/the user said:\n([\s\S]*?)(?:\n\nNote:|$)/);
  return said?.[1].trim() ? { kind: "feedback", text: said[1].trim() } : { kind: "declined" };
}

/** The plan's first heading, or else its first line, to name it once it is folded away. */
function planTitle(plan: string): string {
  const heading =
    plan.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? plan.trim().split("\n")[0].replace(/^(?:[-*+]|\d+\.)\s+/, "");
  return heading.replace(/[`*_]/g, "").trim() || "Plan";
}

// What was picked for each plan (by its call's id), for the card to say after: the result Claude gets
// doesn't name it. Kept outside the card so it outlives a switch to the terminal and back.
const chosenFor = new Map<string, string>();

/**
 * Claude's plan (ExitPlanMode), drawn as a card. While Claude waits on it, the dialog's choices are buttons
 * typed into the terminal (see planKeys), as read off its screen (see planOptions); once answered, the card
 * folds the plan away and shows what was chosen.
 */
export function ChatPlan({
  callId,
  input,
  result,
  pending,
  readScreen,
  onAnswer,
  onShowTerminal,
}: {
  /** The ExitPlanMode call's id, to remember what was picked for it. */
  callId: string | null;
  input: string | null;
  result?: ToolResult;
  /** Claude is waiting on this plan now: it can be answered from here. */
  pending: boolean;
  /** The terminal's lines on screen, to read the dialog's choices from. */
  readScreen: () => string[];
  /** Type these keys into the terminal, in order; resolves false if the terminal wasn't there to take them. */
  onAnswer: (keys: string[]) => Promise<boolean>;
  onShowTerminal: () => void;
}) {
  const plan = useMemo(() => parsePlan(input), [input]);
  const [screenOptions, setScreenOptions] = useState<string[] | null>(null);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [chosen, setChosen] = useState(() => (callId ? chosenFor.get(callId) : undefined));
  const [error, setError] = useState<string | null>(null);
  const live = pending && !result && !sent;

  useEffect(() => {
    if (!live) return;
    const read = () => {
      const found = planOptions(readScreen());
      if (found) setScreenOptions((cur) => (cur?.join("\n") === found.join("\n") ? cur : found));
    };
    read();
    const timer = window.setInterval(read, SCREEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, readScreen]);

  if (!plan) return null;
  const options = screenOptions ?? [];
  const approvals = options.slice(0, -1);
  const outcome = result ? planOutcome(result) : null;
  const note = typedAnswer(feedback);

  const send = async (keys: string[], label: string) => {
    if (sending) return;
    setError(null);
    // Answered in the terminal since the transcript was last read: the keys would land in the prompt.
    if (planOptions(readScreen())?.length !== options.length) {
      setError("The dialog isn't up in the terminal any more, so nothing was sent.");
      return;
    }
    setSending(true);
    const ok = await onAnswer(keys);
    setSending(false);
    if (ok) {
      setSent(true);
      setChosen(label);
      if (callId && label) chosenFor.set(callId, label);
    } else setError("The terminal isn't connected, so nothing was sent. Try again, or answer in the terminal.");
  };
  const sendFeedback = (approve: boolean) => {
    if (!note || !screenOptions) return;
    void send(planKeys(options.length, { feedback: note, approve }), approve ? approvals[0] : "");
  };

  const status = live
    ? "Claude's plan — waiting for your approval"
    : outcome?.kind === "approved"
      ? "Plan approved"
      : outcome?.kind === "feedback"
        ? "Plan sent back"
        : outcome
          ? "Plan not approved"
          : sent
            ? "Claude's plan"
            : "Claude's plan — not answered";

  return (
    <div className={cn("rounded-lg border bg-background text-sm", live && "border-primary/30")}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <ClipboardList className="size-3.5" />
        <span className="flex-1">{status}</span>
        {outcome?.kind === "approved" && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
        {outcome?.kind === "feedback" && <CornerDownLeft className="size-3.5" />}
        {outcome?.kind === "declined" && <X className="size-3.5 text-destructive" />}
      </div>
      <div className="flex flex-col gap-3 px-3 py-3">
        {live ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <PlanText plan={plan} />
          </div>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="min-w-0 truncate">{planTitle(plan)}</span>
            </summary>
            <div className="mt-2 border-l-2 pl-3">
              <PlanText plan={plan} />
            </div>
          </details>
        )}
        {live && !screenOptions && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Looking for the approval dialog in the terminal…
            </span>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onShowTerminal}>
              <TerminalSquare className="size-3.5" /> Answer in terminal
            </Button>
          </div>
        )}
        {live && screenOptions && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {approvals.map((label, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant={i === 0 ? "default" : "outline"}
                  className="h-8"
                  disabled={sending}
                  onClick={() => void send(planKeys(options.length, { approve: i }), label)}
                >
                  {label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onShowTerminal}>
                <TerminalSquare className="size-3.5" /> Answer in terminal
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <Textarea
                value={feedback}
                rows={2}
                disabled={sending}
                placeholder="Or tell Claude what to change"
                className="min-h-0 resize-none"
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendFeedback(false);
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-8" disabled={!note || sending} onClick={() => sendFeedback(false)}>
                  {sending && <Loader2 className="size-3.5 animate-spin" />}
                  Send back to keep planning
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  disabled={!note || sending}
                  title={`Approve the plan (${approvals[0]}) and pass this on as a note`}
                  onClick={() => sendFeedback(true)}
                >
                  Approve with this note
                </Button>
                {error && <span className="text-xs text-destructive">{error}</span>}
              </div>
            </div>
          </>
        )}
        {sent && !result && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Sent — waiting for Claude to take it…
          </p>
        )}
        {outcome && (
          <p className={cn("text-sm", outcome.kind === "declined" && "text-muted-foreground")}>
            {outcome.kind === "approved" ? (
              <>→ Approved{chosen ? `: ${chosen}` : ""}</>
            ) : outcome.kind === "feedback" ? (
              <>→ Keep planning: {outcome.text}</>
            ) : (
              <>→ Not approved</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function PlanText({ plan }: { plan: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-3 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-pre:bg-muted prose-pre:text-foreground [&>div>*:first-child]:mt-0">
      <Markdown text={plan} />
    </div>
  );
}
