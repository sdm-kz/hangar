# Hand a viewer the screen, not the bytes that drew it

**Goal.** A viewer attaching to a session sees the screen as it stands. No duplicated paragraphs in
the scrollback, no unpainted input box, and no width nudge on attach.

**Non-goal.** Reflowing history when the grid changes. What scrolled off was drawn at the width it
was drawn at, and tmux makes the same bargain for the same reason.

---

## 1. What was wrong

Each session kept a 512 KB ring of the raw VT bytes the child had written, and an attaching viewer
was sent the ring verbatim (`TerminalChannel._ring` → `PtyHostClient._ring` → `TerminalSocket`).

Raw bytes are not a description of a screen. They are the **edits** that produced one, and an edit
only means something against the screen and the grid it was made against:

- A repaint says "up nine rows, draw this". Replayed where the cursor is elsewhere, it draws its
  nine rows *again*, below the ones already there.
- Bytes drawn at 120 columns wrap differently at 118, so everything after a width change lands on
  the wrong row.
- The ring wraps. A session of any length hands over a tape that **starts mid-frame**, with cursor
  moves relative to a screen the receiving terminal never had.

The second failure had a partner. The browser asked for a repaint on every attach and every return
to a visible tab, and the host performs one by nudging the width (cols-1, then back) because a TUI
built on Ink redraws when its stdout resizes and on nothing else. Ink erases its previous frame by
moving up the number of lines it believes it wrote — and it cannot reach a line that has scrolled
above the viewport. So each nudge left a copy of the frame behind, in the live stream, for everyone.

Measured, with a real Ink app (`scratchpad/inkdemo`) through a real ConPTY:

| | copies of the frame in the buffer |
|---|---|
| no resize | **1** |
| four width nudges | **5** |

That is the reported symptom exactly: the tail of the transcript, stacked, once per nudge.

## 2. The shape

`shared/Pty/ScreenModel.cs` — a terminal. It consumes the child's output and keeps the screen those
bytes describe: the grid, the scrollback above it, the cursor, the pen, the modes.
`Snapshot()` returns the sequences that reproduce that screen from nothing.

```
child ──bytes──> ScreenModel (pty host)   ──snapshot──> ScreenModel (web app) ──snapshot──> xterm.js
                 └ the screen, per session   at handshake  └ fan-out to every tab   per attach
```

Both sides keep one, as both sides kept a ring before: the host's survives a restart of the web app,
the web app's serves several tabs without a round-trip each.

- `ScreenBuffer` is the grid. Scrolled-off lines are stored **rendered** — history is immutable, so a
  line costs one small string instead of `cols` cells. That is what makes 3000 lines of scrollback
  cheaper than the 512 KB of bytes it replaces, which in a repainting TUI bought perhaps a dozen
  screens.
- `CharWidth` answers the one question a terminal and its emulator must agree on.
- The wire format does not change: the host still sends one output frame after the welcome. A new
  `CanSnapshot` flag says whether that frame is a snapshot or the old tape, so a session still served
  by a host from a previous build keeps working — the web app asks for the redraw on its behalf.

With a snapshot there is nothing left unpainted, so the browser no longer asks for a repaint on
attach or on becoming visible. What remains: the redraw button, and narrowing (where output already
on the wire was drawn for a wider grid).

## 3. Keeping the two models in step

The host's model is the authority; the web app's is a replica fed by the same bytes. Two things keep
them from drifting, both learned the hard way in review:

- **The replica turns when the host turns, not when it asks.** The host broadcasts the size it has
  applied (`size` control), and the replica resizes on that — otherwise everything still in flight,
  drawn for the old width, lands in the new grid and wraps, putting a mangled copy of each frame into
  the history a later viewer is handed. A host from before this build says nothing, so for those the
  ask is still all there is.
- **Neither model follows the repaint nudge.** The nudge parks the pseudoconsole one column off on
  purpose; a narrowing resize costs the model the last column of every row, for a width the child is
  never drawn at. Both sides resize only to the size the viewers agreed on.

A viewer that falls behind far enough to have output dropped (a frozen phone tab, a socket under
backpressure) is repaired rather than left with a hole in its stream: the queue is emptied and the
screen re-sent, on the socket's own write loop, the moment it starts draining again.

## 4. What it is not

Not a general emulator. It covers what a ConPTY on Windows 11 emits and what Ink draws with —
absolute cursor moves, erases, SGR including 24-bit colour, scroll regions, the alternate screen, and
the DEC private modes that change what the user sees or what their keyboard and mouse send. Queries
are not answered: the terminal at the other end is the browser's, and it answers for itself. OSC
payloads are dropped, which incidentally fixes a thing nobody had noticed — an OSC 52 in the ring
used to put whatever the session had once copied onto the clipboard of every viewer that attached.

## 5. How it was checked

Harnesses live in the scratchpad, not the repo (`vtprobe` captures real PTY streams, `vtcheck` runs
the model, `xtermcheck` runs a real xterm.js).

- 33 checks over wrapping, erases, scrolling into history, colour, the alternate screen, wide and
  combining characters, mode restoration, and the history cap — including the invariant that matters:
  **a snapshot fed to a fresh terminal produces the same screen.**
- A fuzzer holding that invariant over random byte soup — CSI sequences with plausible parameters,
  SGR in both spellings, OSC strings, truncated UTF-8, raw noise — with resizes thrown in mid-stream.
  It found four ways the snapshot could disagree with the screen (an orphaned half of a double-width
  character, a wrapped line carried across a resize, a wrap joined onto an erased row, and a glyph cut
  in half by narrowing) and one C# escape-literal trap. 15 000 rounds now pass clean.
- Real captures through a real ConPTY: 200 scrolling lines, Claude Code's own TUI, and `less` on the
  alternate screen. For each, **xterm.js renders the snapshot identically to the raw stream**, cursor
  position included.
- End to end through the app, with a shell session: a viewer that attaches after the fact ends up
  with the live viewer's screen and 190 lines of scrollback, from a 4.7 KB snapshot where the live
  stream had been 17 KB. On a longer run: 232 KB of snapshot against the 512 KB the ring would have
  sent, with more history in it.
