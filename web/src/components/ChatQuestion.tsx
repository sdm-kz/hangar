import { useMemo, useState } from "react";
import { Check, CircleHelp, Loader2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ToolResult } from "@/lib/chat";
import { cn } from "@/lib/utils";

/** One question of an AskUserQuestion call, as Claude writes it into the transcript. */
interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** What was chosen for one question: the options (by index), and anything typed as its own answer. */
interface Answer {
  picked: number[];
  other: string;
}

const DOWN = "\x1b[B";
const ENTER = "\r";

/** The questions of an AskUserQuestion input, or null for one that can't be read (cut short, say). */
export function parseQuestions(input: string | null): Question[] | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as { questions?: unknown };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
    const qs = parsed.questions as Question[];
    return qs.every((q) => typeof q?.question === "string" && Array.isArray(q.options)) ? qs : null;
  } catch {
    return null;
  }
}

/**
 * The keys that answer Claude's question dialog the way a person at the terminal would. Each question is a
 * tab of its own, the cursor on its first option:
 * - one answer: its number picks it and moves on; the number after the last option is "Type something.",
 *   which takes the text and an Enter;
 * - several: each number ticks one; then down past the options to "Type something" (typing there ticks it
 *   too), one more to the question's Submit, and Enter moves on.
 * More than one question, or any with several answers, ends on a review tab whose first choice submits.
 */
export function questionKeys(questions: Question[], answers: Answer[]): string[] {
  const keys: string[] = [];
  questions.forEach((q, i) => {
    const a = answers[i];
    const n = q.options.length;
    const other = typedAnswer(a.other);
    if (!q.multiSelect) {
      if (other) keys.push(String(n + 1), other, ENTER);
      else keys.push(String(a.picked[0] + 1));
      return;
    }
    for (const p of a.picked) keys.push(String(p + 1));
    for (let d = 0; d < n; d++) keys.push(DOWN);
    if (other) keys.push(other);
    keys.push(DOWN, ENTER);
  });
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) keys.push("1");
  return keys;
}

// One line of plain text: the dialog's field ends at Enter and has no use for control characters.
// eslint-disable-next-line no-control-regex
const typedAnswer = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

/** The answers out of the tool result Claude got: `"question"="answer"` pairs. */
function answeredPairs(result: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const m of result.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) pairs.set(m[1], m[2]);
  return pairs;
}

/**
 * Claude asking you something (AskUserQuestion), drawn as a form. While Claude waits on it, the choices are
 * typed into its dialog in the terminal (see questionKeys); once answered, it shows what was answered.
 */
export function ChatQuestion({
  input,
  result,
  pending,
  onAnswer,
  onShowTerminal,
}: {
  input: string | null;
  result?: ToolResult;
  /** Claude is waiting on this question now: it can be answered from here. */
  pending: boolean;
  /** Type these keys into the terminal, in order; resolves false if the terminal wasn't there to take them. */
  onAnswer: (keys: string[]) => Promise<boolean>;
  onShowTerminal: () => void;
}) {
  const questions = useMemo(() => parseQuestions(input), [input]);
  const [answers, setAnswers] = useState<Answer[]>(() =>
    (questions ?? []).map(() => ({ picked: [], other: "" }))
  );
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!questions) return null;
  const answered = result && !result.isError ? answeredPairs(result.text) : null;
  const live = pending && !result && !sent;

  const set = (i: number, next: Partial<Answer>) =>
    setAnswers((cur) => cur.map((a, j) => (j === i ? { ...a, ...next } : a)));
  const toggle = (i: number, k: number) => {
    const q = questions[i];
    const a = answers[i];
    if (!q.multiSelect) set(i, { picked: [k], other: "" });
    else set(i, { picked: a.picked.includes(k) ? a.picked.filter((p) => p !== k) : [...a.picked, k].sort() });
  };
  const complete = answers.every((a) => a.picked.length > 0 || typedAnswer(a.other).length > 0);

  const submit = async () => {
    if (!complete || sending) return;
    setSending(true);
    setError(null);
    const ok = await onAnswer(questionKeys(questions, answers));
    setSending(false);
    if (ok) setSent(true);
    else setError("The terminal isn't connected, so nothing was sent. Try again, or answer in the terminal.");
  };

  return (
    <div className={cn("rounded-lg border text-sm", live ? "border-primary/30 bg-background" : "bg-background")}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <CircleHelp className="size-3.5" />
        <span className="flex-1">{live ? "Claude is asking" : answered ? "Claude asked" : "Claude asked — not answered"}</span>
        {answered && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
      </div>
      <div className="flex flex-col gap-4 px-3 py-3">
        {questions.map((q, i) => {
          const a = answers[i];
          const reply = answered?.get(q.question);
          return (
            <fieldset key={i} disabled={!live || sending} className="flex flex-col gap-1.5">
              <legend className="mb-1">
                {q.header && (
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {q.header}
                  </span>
                )}
                <span className="font-medium">{q.question}</span>
                {q.multiSelect && live && <span className="ml-1.5 text-xs text-muted-foreground">(any number)</span>}
              </legend>
              {live ? (
                <>
                  {q.options.map((o, k) => {
                    const on = a.picked.includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        role={q.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        onClick={() => toggle(i, k)}
                        className={cn(
                          "flex items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                          on ? "border-primary bg-muted/60" : "hover:bg-muted/50"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 grid size-4 shrink-0 place-items-center border",
                            q.multiSelect ? "rounded-[3px]" : "rounded-full",
                            on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
                          )}
                        >
                          {on && <Check className="size-3" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block">{o.label}</span>
                          {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                  <Input
                    value={a.other}
                    placeholder="Or type your own answer"
                    className="h-8"
                    onChange={(e) =>
                      // One answer: typing one replaces a picked option, as the terminal's dialog does.
                      set(i, q.multiSelect ? { other: e.target.value } : { other: e.target.value, picked: [] })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                </>
              ) : (
                <p className={cn("text-sm", reply ? "" : "text-muted-foreground")}>
                  {reply ? <>→ {reply}</> : q.options.map((o) => o.label).join(" · ")}
                </p>
              )}
            </fieldset>
          );
        })}
        {live && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8" disabled={!complete || sending} onClick={() => void submit()}>
              {sending && <Loader2 className="size-3.5 animate-spin" />}
              {questions.length > 1 ? "Submit answers" : "Submit answer"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onShowTerminal}>
              <TerminalSquare className="size-3.5" /> Answer in terminal
            </Button>
            {error && <span className="text-xs text-destructive">{error}</span>}
          </div>
        )}
        {sent && !result && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Sent — waiting for Claude to take it…
          </p>
        )}
      </div>
    </div>
  );
}
