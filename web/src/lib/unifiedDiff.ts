// Reading a unified diff as rows that can be drawn side by side — the shape GitHub's "split" view
// shows, with the old file on the left and the new one on the right.
//
// A unified diff is a sequence of lines, not a pairing: a change is a run of "-" lines followed by a
// run of "+" lines, and nothing in the format says which removed line became which added one. The
// pairing is this file's whole job, and it does the obvious thing — first with first, second with
// second — which is right for the edited line it usually is, and harmless when a run of five became
// a run of two (the extras simply have nothing opposite them).

/** One side of a row: the text of a line and the number it has in that side's file. */
export interface DiffLine {
  text: string;
  number: number;
}

export interface DiffRow {
  /** context: unchanged. add/del: a line on one side only. replace: a line changed into another. */
  kind: "context" | "add" | "del" | "replace";
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface DiffHunk {
  /** The "@@ … @@" line, including the function context git puts after it — worth showing. */
  header: string;
  rows: DiffRow[];
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A hunk header's line count for one side. Absent means one line, which is what the format says. */
function hunkLength(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read one file's unified diff into hunks of side-by-side rows. Everything before the first "@@" is
 * header — the paths, the modes, the blob hashes — and is dropped: what it says is already on the
 * file row this diff hangs under.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (!diff) return hunks;

  let hunk: DiffHunk | null = null;
  let oldNum = 0;
  let newNum = 0;
  // How many lines of each side the current hunk still has to account for, from its own header. A
  // hunk is exactly that long, and reading it that way is what keeps anything after the last one out
  // of the file: a diff arrives newline-terminated, so splitting it leaves a final empty string, and
  // an empty string is indistinguishable from a blank context line whose single leading space some
  // tool trimmed. Counted, it is simply past the end of the hunk and never becomes a row.
  let oldLeft = 0;
  let newLeft = 0;
  // The run of removals and the run of additions being collected, waiting to be paired off.
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    if (!hunk) return;
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i] ?? null;
      const right = adds[i] ?? null;
      hunk.rows.push({ kind: left && right ? "replace" : left ? "del" : "add", left, right });
    }
    dels = [];
    adds = [];
  };

  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const match = HUNK.exec(line);
    if (match) {
      flush();
      oldNum = Number(match[1]);
      newNum = Number(match[3]);
      oldLeft = hunkLength(match[2]);
      newLeft = hunkLength(match[4]);
      hunk = { header: line, rows: [] };
      hunks.push(hunk);
      continue;
    }
    // Before the first hunk (the file header), or past the end of the last one.
    if (!hunk || oldLeft + newLeft <= 0) continue;

    const marker = line[0];
    if (marker === "+") {
      adds.push({ text: line.slice(1), number: newNum++ });
      newLeft--;
    } else if (marker === "-") {
      dels.push({ text: line.slice(1), number: oldNum++ });
      oldLeft--;
    } else if (marker === " " || line === "") {
      // A run ends where an unchanged line starts. An empty line counts as a context line here — the
      // hunk's own length is what says whether there is still a line to read, so a trimmed leading
      // space costs nothing and the trailing empty string is never mistaken for one.
      flush();
      const text = line.slice(1);
      hunk.rows.push({
        kind: "context",
        left: { text, number: oldNum++ },
        right: { text, number: newNum++ },
      });
      oldLeft--;
      newLeft--;
    } else if (marker === "\\") {
      // "\ No newline at end of file" — a note about the line above, not a line of its own.
      continue;
    } else {
      // A hunk claiming more lines than it has: a diff cut short, or a following file's header in a
      // patch that was split wrongly. Stop rather than read the next file into this one.
      break;
    }
  }
  flush();
  return hunks;
}

/**
 * Whether a file's diff has anything to put on both sides. A file that was added or deleted has
 * nothing on one of them, so a second column would be a tall empty gutter beside the only thing
 * there is to read — those are drawn as a single column of content instead.
 *
 * A copy is not one of those, whatever it has in common with an addition: git records the file it
 * was copied from, the diff carries both sides, and drawing it one-sided would quietly drop every
 * line the copy changed.
 */
export function oneSidedAs(status: string): "add" | "del" | null {
  if (status === "A") return "add";
  if (status === "D") return "del";
  return null;
}

/** Every row of every hunk, flattened — what the one-sided view draws. */
export function allRows(hunks: DiffHunk[]): DiffRow[] {
  return hunks.flatMap((h) => h.rows);
}
