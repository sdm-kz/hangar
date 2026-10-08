import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown, Check, Copy, RefreshCw, TextSelect, X } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "@/lib/api";
import { getTheme, subscribeTheme, type Theme } from "@/lib/theme";
import { writeToClipboard } from "@/lib/clipboard";
import { uploadImageFile } from "@/lib/upload";
import { usePersistentZoom, ZoomControls, ZOOM_LEVELS } from "@/components/ZoomControls";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The terminal zooms by font size rather than CSS `zoom`: the grid is measured from the font, so a
// larger font means fewer, bigger cells (and a PTY resize), where scaling the box would just blow up
// the same cell count into a blurry, clipped picture. 13px is the unzoomed size; the multipliers are
// the app-wide zoom stops, so a percentage here means what it means in the file viewers.
const BASE_FONT_SIZE = 13;
const fontSizeFor = (zoom: number) => Math.max(6, Math.round(BASE_FONT_SIZE * zoom));

/**
 * The terminal's text, for the selection overlay: scrollback and screen from the normal buffer, and
 * just the screen from the alternate one -- an alt-screen app (Claude Code's TUI) has no scrollback
 * by definition, and the rows behind it belong to whatever ran before.
 *
 * A soft-wrapped row is joined back onto the line it continues rather than emitted as its own line,
 * so a long command copies as the one command you typed instead of arriving pre-broken at the width
 * of the window it happened to be read in.
 */
function bufferText(term: Terminal): string {
  const buf = term.buffer.active;
  const end = buf.type === "alternate" ? term.rows : buf.baseY + term.rows;
  const lines: string[] = [];
  for (let i = 0; i < end; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  // Blank rows below the last output are the empty part of the screen, not content.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// How much ctrl-wheel travel makes one zoom step. A mouse notch (~100px) steps immediately; a
// trackpad pinch, which fires a stream of small deltas, ramps instead of shooting to either end.
const WHEEL_ZOOM_STEP = 40;

// Reading the clipboard (OSC 52 "?" report) is a paste-injection risk, so we never expose it —
// only writes are honored.
const clipboardProvider: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => writeToClipboard(text),
};

// xterm palettes that track the site theme. The dark one keeps xterm's default ANSI colors (tuned
// for a dark background); the light one remaps the 16 ANSI colors (GitHub-Light-ish) so output
// stays legible on white — the defaults wash out (bright white/yellow) on a light background.
const TERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: "#0a0a0a",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    selectionBackground: "#3f3f46",
  },
  light: {
    background: "#ffffff",
    foreground: "#24292e",
    cursor: "#24292e",
    cursorAccent: "#ffffff",
    selectionBackground: "#b3d7ff",
    black: "#24292e",
    red: "#d73a49",
    green: "#22863a",
    yellow: "#b08800",
    blue: "#0366d6",
    magenta: "#6f42c1",
    cyan: "#1b7c83",
    white: "#6a737d",
    brightBlack: "#959da5",
    brightRed: "#cb2431",
    brightGreen: "#28a745",
    brightYellow: "#dbab09",
    brightBlue: "#2188ff",
    brightMagenta: "#8a63d2",
    brightCyan: "#3192aa",
    brightWhite: "#24292e",
  },
};

// Minimal ANSI strip (CSI/OSC/other escapes), with CR collapsed to LF — mirrors the server's Vt.Strip
// (line-aware flavour) so we can pull a clean session name out of the terminal stream. Two CSI kinds
// carry text even though they paint no characters, and dropping them ruins the match: a cursor-forward
// stands in for the spaces the TUI skipped over ("Session color set to: red" goes out as five words
// joined by ESC[1C), and a reposition starts a screen row the way a CRLF would — which is what the
// line anchors below key on.
function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[([0-?]*)([ -/]*)([@-~])/g, (_all, params: string, _inter, final: string) => {
        if (/^[?<=>]/.test(params)) return ""; // private modes and queries never paint
        const p = (i: number) => {
          const v = parseInt(params.split(";")[i] ?? "", 10);
          return Number.isNaN(v) ? 1 : v;
        };
        if (final === "C" || final === "a") return " ".repeat(Math.min(Math.max(p(0), 1), 240));
        // Every reposition: CUU/CUD, CNL/CPL, CHA/HPA, VPA, CUP/HVP. Broken as \x1e rather than \n so
        // the detectors below can still tell a repaint (cursor jump) from output that just arrived
        // (CR/LF) — mirrors Vt.CursorBreak on the server.
        if ("ABEFG`dHf".includes(final)) return "\x1e";
        return "";
      })
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, "")
      .replace(/\r/g, "\n")
  );
}

// A real rename is the OUTPUT of a "/rename" command, not the phrase appearing in assistant prose
// (which used to mis-rename the session to a sentence fragment — even discussing this feature, or
// printing this detector's own regex source, did it). Two layout facts separate a real result from
// prose, and we require BOTH: (1) the "/rename" echo and the confirmation each START a line (prose
// embeds them mid-sentence); (2) the confirmation is a TUI command result, so it's prefixed by a
// non-ASCII tree marker "⎿"/"└" ([^\x00-\x7f]) that assistant markdown never emits — the load-bearing
// discriminator, since plain-ASCII prose can't produce it. Names can contain spaces AND non-ASCII text
// (this stream is decoded UTF-8, unlike the server's Latin1 bytes), so the name is a lazy run of
// anything printable; it stops at a control char, a 2+ space run, or the input prompt ">", which the TUI puts on
// the next line via cursor moves (the strip above now breaks the line there, but the guard still covers
// a move it doesn't classify, e.g. "main>").
// Trailing spaces trimmed. Mirrors the server sniffer (TerminalChannel.cs).
// Line-anchoring alone is no longer a guard: the strip above breaks lines on cursor moves, and an
// inline `code span` in rendered markdown is drawn between two of them — so a sentence mentioning
// "/rename foo" starts a line as convincingly as a real echo does. The two halves must therefore
// AGREE: the echoed argument is captured and back-referenced in the confirmation, no second command
// may fall between them (so the confirmation belongs to the echo directly above it), and the echo
// must END its line, which a real command line does and prose almost never does.
const RENAME_CONFIRM = /(?:^|[\r\n\x1e])[ \t]*[^\w\r\n\x1e]{0,12}\/rename[ \t]+(?<arg>[^\x00-\x1f]{1,300}?)[ \t]*(?=[\r\n\x1e])(?:(?!\/rename)[\s\S]){0,2000}?(?:^|(?<paint>[\r\n\x1e]))[ \t]*[^\w\r\n\x1e]{0,15}[^\x00-\x7f][^\w\r\n\x1e]{0,8}[ \t]*Session[ \t]*renamed[ \t]*to:[ \t]*\k<arg>(?=[\x00-\x1f]|[ \t]|$)/g;

// Same discriminators for `/color <name>`, including the echo/confirmation agreement. Case-insensitive
// because Claude lowercases the colour it echoes back; a bare "/color" (random colour) is deliberately
// not matched, having no argument to agree on. Mirrors the server sniffer.
const COLOR_CONFIRM = /(?:^|[\r\n\x1e])[ \t]*[^\w\r\n\x1e]{0,12}\/color[ \t]+(?<arg>[A-Za-z]{1,20})[ \t]*(?=[\r\n\x1e])(?:(?!\/color)[\s\S]){0,2000}?(?:^|(?<paint>[\r\n\x1e]))[ \t]*[^\w\r\n\x1e]{0,15}[^\x00-\x7f][^\w\r\n\x1e]{0,8}[ \t]*Session[ \t]*color[ \t]*set[ \t]*to:[ \t]*\k<arg>(?![A-Za-z])/gi;

// Was this confirmation drawn by a repaint (the line began with a cursor jump) rather than streamed
// after a CR/LF? A repainted block is the transcript being redrawn, so an older one must not re-apply
// its value over a newer one; a streamed one is the command's live result and always counts. No group
// at all means the match sat at the very start of the buffer, with nothing to judge by.
function isRepaint(m: RegExpMatchArray): boolean {
  const paint = m.groups?.paint;
  return !paint || paint === "\x1e";
}

// The cheap gate that decides whether a frame is worth running the full patterns over. Loose in the
// same places they are (the TUI can draw either phrase's word gaps as cursor moves), so the gate can
// never be the thing that swallows a confirmation.
const RENAME_PHRASE = /Session[ \t]*renamed[ \t]*to:/;
const COLOR_PHRASE = /Session[ \t]*color[ \t]*set[ \t]*to:/;

// File-link matcher for the terminal. Two forms:
//  1) a PATH with a separator (optional drive `C:\`, one or more `segment/`, then `name.ext`, any
//     extension) — resolved against the working dir and opened directly.
//  2) a BARE filename with a *known* extension (no directory) — searched for under the working dir
//     (there may be several). The extension whitelist keeps prose like "e.g." or "3.14" from lighting
//     up; paths in form 1 accept any extension since the separator already implies a real path.
// The `(?<!:\/\/)` guard avoids swallowing the domain of an http(s):// URL (the URL provider,
// registered first, keeps precedence there).
const FILE_LINK =
  /(?<!:\/\/)(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,12}|(?<![\w./\\-])[\w-]+\.(?:md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|cs|java|kt|go|rs|rb|php|py|pyi|c|cc|cpp|h|hpp|swift|sql|sh|bash|zsh|ps1|psm1|bat|cmd|dockerfile|gradle|properties|lock|sln|csproj|props|targets)(?![\w])/i;

// Resolve a path clicked in the terminal to an absolute server path. Absolute paths (POSIX, Windows
// drive, or UNC-ish leading separator) pass through; relative paths are joined onto the session's
// working directory. The server's /api/fs/file normalizes mixed separators and `..`, so a plain join
// is enough — no client-side path arithmetic needed.
function resolveTerminalPath(workingDir: string, matched: string): string {
  const isAbsolute = /^([A-Za-z]:[\\/]|[\\/])/.test(matched);
  if (isAbsolute) return matched;
  return workingDir.replace(/[\\/]+$/, "") + "/" + matched;
}

// Imperative handle so a sibling (the postponed-messages pool) can inject a whole message — text
// plus already-uploaded image paths — into the live PTY without owning the socket itself.
// After pasting an image path, Claude Code ingests it asynchronously (reads the file, swaps in an
// "[Image #N]" chip); submitting before that settles makes the Enter get swallowed and the message
// sits unsent in the input box. Wait this long between the image paste(s) and the submit.
const IMAGE_SETTLE_MS = 600;

// Backoff for automatically re-attaching after the terminal socket drops (a laptop sleeping, a phone
// backgrounding the tab, a proxy cutting an idle connection). Attempt N waits DELAYS[N]; once the
// list runs out we stop and leave the manual Reconnect button — a session whose PTY is gone fails
// the handshake with a 404, and retrying that forever would just spin.
// How long the measured grid has to stop changing before the session is told (see sendResize).
const RESIZE_SETTLE_MS = 150;
// The least time between two "someone is using this" messages (see `claim`).
const CLAIM_THROTTLE_MS = 1000;

const RECONNECT_DELAYS_MS = [300, 1000, 2000, 4000, 8000, 8000, 8000, 8000];

// Heartbeat for the terminal socket. A half-open connection — a phone losing signal, a NAT or proxy
// dropping the flow — never fires onclose: the socket still reads as OPEN while the terminal is
// silently dead, which is the case no amount of close-handling catches. A browser can't send a
// protocol-level ping, so we poll the server's control channel instead and treat a long silence
// (no pong, no PTY output) as a drop. Only ever enforced after one pong has proved the server
// answers these, so a server without the ping handler is left alone rather than falsely declared
// dead every idle window.
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEAD_MS = 45_000;

// Control frames arrive as text; PTY output is always binary, so a text frame is never terminal
// content. Returns the parsed frame, or null when it isn't one (then it's output after all).
type ControlFrame = { type: string; cols?: number; rows?: number };

function controlFrame(data: string): ControlFrame | null {
  if (!data.startsWith("{")) return null;
  try {
    const msg = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown } | null;
    if (typeof msg?.type !== "string") return null;
    return {
      type: msg.type,
      cols: typeof msg.cols === "number" ? msg.cols : undefined,
      rows: typeof msg.rows === "number" ? msg.rows : undefined,
    };
  } catch {
    return null; // not JSON — let xterm have it
  }
}

export interface TerminalPaneHandle {
  // True while the terminal socket is open and can accept input.
  isReady: () => boolean;
  // Send one message to Claude: the text then each image path (both as bracketed pastes so multi-line
  // content stays literal), followed by a single Enter to submit. Resolves false if the socket closed.
  sendMessage: (msg: { text: string; imagePaths: string[] }) => Promise<boolean>;
  // Put the keyboard in the terminal — for a group of the split pane taking focus.
  focus: () => void;
}

/**
 * Live terminal for a session: an xterm.js terminal wired to the ConPTY-backed WebSocket at
 * /hub/sessions/{id}/terminal. Output frames arrive as binary VT bytes; keystrokes and resizes
 * are sent back (binary input, JSON control). Mount one per session (key by session id).
 *
 * A shell tab is the same pane pointed at /hub/shells/{id}/terminal (see `socketPath`): the server
 * speaks one protocol for both, so everything here — scrollback replay, the heartbeat, reconnects,
 * touch scrolling, zoom, file links — comes along unchanged.
 */
export const TerminalPane = forwardRef<
  TerminalPaneHandle,
  {
    sessionId: string;
    // Which terminal to attach to. Defaults to this session's own; a shell tab passes its
    // /hub/shells/{id}/terminal path instead. The session id still comes along, because the things
    // built around the pane (file links, image upload) are about the session either way.
    socketPath?: string;
    // Whether a pasted image is uploaded into the session's folder and its path pasted in. On for
    // Claude, which reads images; off for a shell, where a path appearing at the prompt is noise.
    imagePaste?: boolean;
    // Whether something else floats over the pane's bottom-right corner (the Claude terminal's
    // postponed-pool buttons), so the jump-to-bottom button sits above it rather than under it.
    cornerTaken?: boolean;
    // The session's working directory, used to resolve a relative file path clicked in the terminal.
    workingDirectory: string;
    // Fired with the new name when Claude's "Session renamed to:" confirmation appears in this
    // terminal, so the app can update the session name immediately instead of waiting for a poll.
    onRenameDetected?: (name: string) => void;
    // Fired with the new color when Claude's "Session color set to:" confirmation appears (a /color
    // typed in the terminal), so the sessions list can recolor immediately instead of on the next poll.
    onColorDetected?: (color: string) => void;
    // Fired with an absolute server path when a full file path in the terminal is clicked, so the app
    // can open it in the main-area file viewer.
    onOpenFile?: (absolutePath: string) => void;
    // Fired with a bare filename (no directory) clicked in the terminal, so the app can search the
    // working directory for it and open it (or offer a picker when several match).
    onFindFile?: (name: string) => void;
  }
>(function TerminalPane(
  {
    sessionId,
    socketPath,
    imagePaste = true,
    cornerTaken = false,
    workingDirectory,
    onRenameDetected,
    onColorDetected,
    onOpenFile,
    onFindFile,
  },
  ref
) {
  const path = socketPath ?? `/hub/sessions/${sessionId}/terminal`;
  const hostRef = useRef<HTMLDivElement>(null);
  // Read by the paste handler rather than closed over by the terminal's effect: it flips as focus
  // moves between the groups of a split pane, and as an effect dependency every flip tore the
  // terminal down and built it again — a dropped socket for moving the mouse to a shell.
  const imagePasteRef = useRef(imagePaste);
  imagePasteRef.current = imagePaste;
  // Holds the live terminal socket so the imperative handle can write to it; set inside the socket
  // effect below and nulled on teardown. `null` means "not connected" → sendMessage returns false.
  const wsRef = useRef<WebSocket | null>(null);
  // The live xterm instance, so a failed image paste can write its own notice.
  const termRef = useRef<Terminal | null>(null);
  // Terminal zoom, shared by every session (one preferred reading size) and remembered across
  // reloads. Held in a ref too so a fresh terminal — a session switch, a reattach — is built at the
  // current size instead of flashing 100% first.
  const [zoom, setZoom] = usePersistentZoom("terminal");
  // Snapshot of the buffer as plain text while the selection overlay is open; null = closed. Taken
  // once on open rather than followed live: text that reflows under a finger cannot be selected.
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Move `delta` stops along ZOOM_LEVELS from wherever we are now, clamped at both ends. Reads the
  // live level through the ref so the wheel and key handlers can be registered once and still be
  // right — they never close over a stale zoom.
  const stepZoom = useCallback(
    (delta: number) => {
      const i = ZOOM_LEVELS.indexOf(zoomRef.current) + delta;
      setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]);
    },
    [setZoom]
  );
  // Refit + tell the PTY about the new grid. Owned by the socket effect (it needs the fit addon and
  // the socket); kept here so the zoom effect can trigger a resize the ResizeObserver never sees —
  // the pane's own box doesn't change when the font does.
  const refitRef = useRef<() => void>(() => {});
  // Ask the host to make the TUI redraw its whole frame. Same ownership story as refitRef — it needs
  // the socket — and exposed here for the toolbar's repaint button.
  const repaintRef = useRef<() => void>(() => {});
  // Tell the session someone is using it here (see `claim` in the socket effect). Same ownership
  // story again; exposed for sendMessage, whose typing happens in the composer, outside the pane.
  const claimRef = useRef<() => void>(() => {});
  // Whether the next socket to open was asked for by someone at this screen — opening the session,
  // coming back to the tab, the Reconnect button — and so should claim the session's size as it
  // attaches. An automatic retry after a drop must not: it happens with nobody there, and would take
  // the size away from whoever is actually using the session on another machine.
  const claimOnOpenRef = useRef(true);
  // True while the viewport sits above the live tail — gates the jump-to-bottom button.
  const [scrolledUp, setScrolledUp] = useState(false);
  // Spins the repaint button for a moment after a press. A repaint that had nothing to fix looks
  // like nothing happening, and without an acknowledgement the button just invites another press.
  const [repainting, setRepainting] = useState(false);
  const repaintTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(repaintTimerRef.current), []);
  // Socket state, driving the reconnect chip. "connecting" is the first attach — no chip then, the
  // terminal is just blank for a moment; the chip only appears once a live socket has dropped.
  const [connection, setConnection] = useState<"connecting" | "open" | "closed" | "reconnecting">(
    "connecting"
  );
  // Bumped to tear this terminal down and attach a fresh one, which is exactly what reloading the
  // page used to do. The server replays the session's scrollback on attach, so the new xterm comes
  // back with the current screen.
  const [generation, setGeneration] = useState(0);
  // How many automatic retries the current drop has spent; reset whenever a socket opens.
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const reattach = useCallback((manual: boolean) => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (manual) retryRef.current = 0; // a click earns a fresh budget of automatic retries
    setConnection("reconnecting");
    setGeneration((g) => g + 1);
  }, []);
  useImperativeHandle(
    ref,
    (): TerminalPaneHandle => ({
      isReady: () => wsRef.current?.readyState === WebSocket.OPEN,
      focus: () => termRef.current?.focus(),
      sendMessage: async ({ text, imagePaths }) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        claimRef.current();
        const enc = new TextEncoder();
        // Bracketed paste keeps any embedded newlines literal; the separate trailing \r is the one
        // submit — sending raw \n/\r inside the text would split one message into several prompts.
        if (text) ws.send(enc.encode(`\x1b[200~${text}\x1b[201~`));
        for (const p of imagePaths) ws.send(enc.encode(`\x1b[200~${p}\x1b[201~`));
        // Let Claude Code finish ingesting any pasted image before we submit, or the Enter is lost.
        if (imagePaths.length) await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS));
        const live = wsRef.current;
        if (!live || live.readyState !== WebSocket.OPEN) return false;
        live.send(enc.encode("\r"));
        return true;
      },
    }),
    []
  );
  // Kept in refs so the link/socket handlers always see the latest values without re-opening the socket.
  const onRenameRef = useRef(onRenameDetected);
  onRenameRef.current = onRenameDetected;
  const onColorRef = useRef(onColorDetected);
  onColorRef.current = onColorDetected;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onFindFileRef = useRef(onFindFile);
  onFindFileRef.current = onFindFile;
  const workingDirRef = useRef(workingDirectory);
  workingDirRef.current = workingDirectory;
  // Rolling tail of recent output (ANSI-stripped) so a confirmation split across frames still matches.
  // Shared by the rename and color detectors.
  const scanBufRef = useRef("");
  const lastNameRef = useRef<string | null>(null);
  const lastColorRef = useRef<string | null>(null);
  // A command result is not a one-off in the stream: the TUI redraws whatever is on screen on every
  // repaint, so an older "/color pink" block still in the visible transcript is re-emitted in full
  // long after a newer "/color cyan" — and applying it again is what made a session's colour flip
  // back and forth by itself. Nothing marks a block as a repaint, so we use the one fact that does:
  // a value this session has already been given cannot be news. First sighting wins. (Same guard
  // server-side, in TerminalChannel.) The cost is that re-picking a colour or name already used this
  // session won't register — cheap next to a colour that changes on its own.
  const appliedNamesRef = useRef(new Set<string>());
  const appliedColorsRef = useRef(new Set<string>());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: fontSizeFor(zoomRef.current),
      scrollback: 10000,
      theme: TERM_THEMES[getTheme()],
    });
    termRef.current = term;
    term.attachCustomKeyEventHandler((e) => zoomKeysRef.current(e));
    // Re-theme live when the site theme is toggled.
    const themeSub = subscribeTheme((t) => {
      term.options.theme = TERM_THEMES[t];
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Honor OSC 52 clipboard writes (how Claude Code copies), routing them to the browser clipboard.
    term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
    // Detect URLs and open them in a new tab. On desktop require Ctrl/Cmd-click so plain clicks stay
    // free for selection and the TUI; on touch (no modifier keys) a plain tap opens.
    const isTouch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (isTouch || event.ctrlKey || event.metaKey)
          window.open(uri, "_blank", "noopener,noreferrer");
      })
    );
    // Detect file paths and open them in the app's file viewer. WebLinksAddon can't be reused here —
    // it validates every match with `new URL()`, so non-URL paths are discarded — so we register a
    // custom link provider. It reconstructs each logical line (joining wrapped rows so a long path
    // spanning terminal rows stays a single link), matches FILE_PATH, and maps string indices back to
    // 1-based buffer cells. Same click gating as URLs; relative paths resolve against the working dir.
    const fileLinks = term.registerLinkProvider({
      provideLinks(bufferLine, cb) {
        const buf = term.buffer.active;
        const startRow = bufferLine - 1; // provideLinks is 1-based; getLine is 0-based
        const first = buf.getLine(startRow);
        // Skip wrapped continuation rows — each logical line is handled once at its first row.
        if (!first || first.isWrapped) return cb(undefined);

        const rows = [first.translateToString(false)]; // untrimmed → each row is exactly `cols` wide
        for (let i = startRow + 1; i < buf.length; i++) {
          const l = buf.getLine(i);
          if (!l || !l.isWrapped) break;
          rows.push(l.translateToString(false));
        }
        const cols = term.cols;
        const text = rows.join("");
        const cell = (idx: number) => ({ x: (idx % cols) + 1, y: startRow + Math.floor(idx / cols) + 1 });

        const links = [...text.matchAll(new RegExp(FILE_LINK.source, "gi"))].map((m) => {
          const matched = m[0];
          const idx = m.index ?? 0;
          return {
            text: matched,
            range: { start: cell(idx), end: cell(idx + matched.length) },
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent, uri: string) => {
              if (!(isTouch || event.ctrlKey || event.metaKey)) return;
              const t = uri.trim();
              // A separator means it's a real path (resolve + open); otherwise it's a bare filename
              // to search for under the working directory.
              if (/[\\/]/.test(t)) onOpenFileRef.current?.(resolveTerminalPath(workingDirRef.current, t));
              else onFindFileRef.current?.(t);
            },
          };
        });
        cb(links.length ? links : undefined);
      },
    });
    term.open(host);
    // Copy what you select, the way a terminal emulator does — no Ctrl-C, which in here belongs to
    // the program running in the terminal, and no right-click menu.
    //
    // On mouseup rather than xterm's own onSelectionChange, which fires on every cell the pointer
    // crosses: that would put a hundred half-selections through the clipboard on the way to the one
    // the user meant. Mouseup is also what makes the write legal — the Clipboard API only grants it
    // inside a user gesture, and a selection-change tick is not one.
    //
    // Listened for on the document, not the host: a drag that starts in the terminal very often ends
    // outside it (past the last row, over the sidebar), and a host-bound listener never hears that
    // mouseup, so exactly the selections that run to the end of the buffer would fail to copy.
    //
    // Nothing is copied when there is no selection, so a plain click doesn't wipe the clipboard, and
    // a drag the TUI is tracking for itself (mouse reporting on) never makes a selection here in the
    // first place. Touch is excluded: xterm's selection runs on mouse events iOS only synthesizes for
    // a tap, which is why that path has the Select-text overlay instead.
    const onMouseUp = () => {
      if (isTouch || !term.hasSelection()) return;
      const text = term.getSelection();
      if (text) void writeToClipboard(text);
    };
    document.addEventListener("mouseup", onMouseUp);
    // GPU renderer. The default DOM renderer rebuilds row elements on every scroll step, which is
    // what makes touch scrolling lag behind the finger on phones; WebGL repaints the whole grid in
    // one draw call. Must be loaded after open() (it needs the canvas parent). Mobile browsers drop
    // the GL context when the tab is backgrounded or memory is tight — dispose on loss so xterm
    // falls back to the DOM renderer instead of freezing on a dead canvas.
    // The addon version is pinned to the core's (0.18.x ↔ xterm 5.5.x): 0.19's teardown reads
    // `_core._store._isDisposed`, an internal that only exists in the 5.6 betas, so on 5.5 it threw
    // out of this effect's cleanup and blanked the app on every session switch.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null; // no WebGL available (old browser / blocked) — DOM renderer stays
    }
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }

    const token = getToken() ?? "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}${path}?access_token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    // Set by the cleanup below so a close we caused (unmount, session switch, our own re-attach)
    // isn't mistaken for a drop and answered with yet another reconnect.
    let closedByUs = false;
    // Liveness clock for the heartbeat: when anything last arrived from the server. Only consulted
    // once a pong has shown the server answers probes at all.
    let lastInbound = Date.now();
    let pongSeen = false;
    const ping = () => {
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* socket already going away — handleDrop covers it */
      }
    };
    wsRef.current = ws; // expose to the imperative handle (sendMessage)

    // What this box could show, and what the server settled on across every viewer of the session.
    // They part company while the session is open somewhere else as well: one pseudoconsole serves
    // every viewer, sized for whichever was used last, and the rest adapt — letterbox into the
    // difference when they are bigger, scale the frame down when they are smaller (see fitScale). The
    // grid follows the agreed size rather than our own, because that is the frame Claude is drawing —
    // a grid narrower than the frame wraps the last cell of every line onto the front of the next row,
    // and Ink, painting only the rows it believes changed, never takes those strays back. Zero means
    // not known yet (or a server too old to say), where our own fit stands in as it always did.
    // A drag fires the observer dozens of times a second; only the size it ends on is worth sending.
    let resizeTimer = 0;
    let desiredCols = 0;
    let desiredRows = 0;
    let agreedCols = 0;
    let agreedRows = 0;
    // Shrink the grid to fit when it is bigger than this box: the session is sized for another screen,
    // the one used last, and until someone uses this one the frame is shown whole rather than cropped.
    // A transform rather than a smaller font, so the box keeps measuring at the font it really wants
    // — that measurement is the size it asks for the moment it is used. xterm maps the pointer without
    // knowing about the transform, so a click lands a little off while scaled; the click is also what
    // claims the session, and the grid comes back to full size a moment later.
    const fitScale = () => {
      const el = term.element;
      if (!el) return;
      const scale =
        desiredCols > 0 && desiredRows > 0
          ? Math.min(1, desiredCols / term.cols, desiredRows / term.rows)
          : 1;
      // Bottom-left, where the host anchors the grid (justify-end): the prompt stays where it was.
      el.style.transformOrigin = "left bottom";
      el.style.transform = scale < 1 ? `scale(${scale})` : "";
    };
    const applyGrid = () => {
      const cols = agreedCols || desiredCols;
      const rows = agreedRows || desiredRows;
      if (cols <= 0 || rows <= 0) return;
      if (term.cols === cols && term.rows === rows) {
        fitScale(); // our own box may have changed around the same grid
        return;
      }
      const shrank = cols < term.cols;
      term.resize(cols, rows);
      fitScale();
      // What fit() does for itself after resizing, in public API: the renderer caches the grid it
      // last drew, and a cell it believes unchanged is not redrawn at its new place.
      term.refresh(0, term.rows - 1);
      // Spend the "ignore the next scroll event" flag xterm's viewport may have been left holding.
      //
      // It arms that flag and then re-pins the scrollbar to the buffer (`scrollTop = ydisp * rowHeight`)
      // to keep its own sync from looking like a scroll by the user. The flag is only spent when that
      // assignment actually fires a scroll event -- and after a resize the value it wants is regularly
      // clamped by the browser to the one already there, so no event comes and the flag sits armed.
      // The next wheel or scrollbar drag is then eaten: the bar slides, the terminal does not move,
      // and it takes a second gesture to scroll at all. Since the pane resizes for the sidebar, the
      // split divider, the postponed panel and the window itself, that first dead gesture is easy to
      // meet and reads as scrolling being unreliable.
      //
      // One synthetic scroll event spends it. With the flag down this is a no-op: the handler just
      // re-reads a position that already agrees with the buffer. Two frames out, because the re-pin
      // runs on xterm's own animation frame and has to have happened first.
      const spendIgnoredScroll = () =>
        host.querySelector(".xterm-viewport")?.dispatchEvent(new Event("scroll"));
      requestAnimationFrame(() => requestAnimationFrame(spendIgnoredScroll));
      // Narrowing is the one direction that can leave strays: output already on the wire when the
      // grid shrank was drawn for the old width, and it lands here too wide and wraps. The child has
      // no reason to draw those rows again — its own resize came and went before this frame arrived —
      // so ask for the redraw that clears them.
      if (shrank) requestRepaint();
    };

    const sendResize = () => {
      // Skip while the pane is hidden (e.g. the Files full view keeps us mounted but
      // display:none'd): measuring a 0-sized host would send a bogus 1x1 resize to the PTY.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      let dims;
      try {
        dims = fit.proposeDimensions();
      } catch {
        return;
      }
      if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return;
      desiredCols = dims.cols;
      desiredRows = dims.rows;
      applyGrid();
      // Local work is free and immediate; telling the session is not, so that part waits below.
      // Repaint xterm's own cells in case the renderer left them stale after being hidden.
      term.refresh(0, term.rows - 1);
      // A request, not a setting — the answer comes back as a `size` frame, which may differ.
      if (ws.readyState === WebSocket.OPEN)
        // Coalesced, because a drag is not one resize. Pulling the split divider across a session
        // measured 42 of them inside a single second, and the child answers every one by laying its
        // whole frame out again — at one width a table, at the next the same data as a list. A frame
        // taller than the screen cannot be erased once part of it has scrolled above the viewport, so
        // each of those redraws leaves its copy behind: one drag, a dozen copies of the same
        // paragraph down the scrollback. Only the size the drag ends on was ever real.
        //
        // Held here rather than in the pty host on purpose: coalescing the ASK means nothing
        // downstream ever sees the burst, so no part of the chain has to reconcile a size that was
        // asked for against the different one in force. Holding it at the far end instead put those
        // two out of step for long enough that an attaching viewer could be handed a screen drawn at
        // one width and told to lay it out at another.
        //
        // The box it was measured from rides along: a resize nobody asked for is worth explaining,
        // and from the server a box that changed size (the layout moved) and one that did not (the
        // cell did — a font, or a device-pixel-ratio shift) look nothing alike.
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            type: "resize",
            cols: desiredCols,
            rows: desiredRows,
            w: Math.round(host.clientWidth),
            h: Math.round(host.clientHeight),
          }));
        }, RESIZE_SETTLE_MS);
    };

    // Stop counting towards the session's size. One pseudoconsole serves every viewer and it runs at
    // the grid of the one used last, so a phone last used on a session and then put in a background
    // tab would keep the desktop pinned to phone width until someone touched the desktop. A tab that
    // is not on screen is not showing the session, and says so; it declares its size again the
    // moment it comes back.
    const withdrawSize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // At once, and cancelling anything a drag left pending: going away is not a size to settle on.
      window.clearTimeout(resizeTimer);
      desiredCols = 0;
      desiredRows = 0;
      ws.send(JSON.stringify({ type: "resize", cols: 0, rows: 0 }));
    };

    // Ask for a full repaint: the host nudges the width so Ink draws its whole frame again.
    //
    // Deliberately rare. A redraw is the child rewriting what is on screen, and it can only erase
    // the rows it still owns — anything that has scrolled above the viewport keeps its old copy, so
    // a repaint of a transcript taller than the screen leaves that copy behind for good. Attaching
    // no longer needs one (the server sends the screen, not the bytes that drew it), which leaves
    // two callers: the narrowing case below, where output already on the wire was drawn for a wider
    // grid and lands here wrapped, and the redraw button, where the user is telling us the screen is
    // wrong and a stale row is the thing being complained about.
    //
    // Named as an intent rather than performed from here — two resizes we do not want — because out
    // here a repaint is indistinguishable from Claude working: the activity heuristic reads any
    // output as a turn, so opening an idle session used to report it busy and then finished. The pty
    // host knows what the burst is and does not count it. Older hosts have no such control, so the
    // server nudges on their behalf — either way, one message from here.
    const requestRepaint = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      ws.send(JSON.stringify({ type: "repaint" }));
    };

    // Someone is using the session here, so size it for this screen. The session follows whichever
    // viewer was used last, and only a person counts: never a heartbeat, a reconnect nobody asked
    // for, or the replies xterm sends the child by itself — those come from every screen the session
    // is open on, used or not. At most once a second; a keystroke at a time would be all claims.
    let lastClaim = 0;
    const claim = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - lastClaim < CLAIM_THROTTLE_MS) return;
      lastClaim = now;
      ws.send(JSON.stringify({ type: "active" }));
    };
    claimRef.current = claim;

    ws.onopen = () => {
      retryRef.current = 0;
      lastInbound = Date.now();
      setConnection("open");
      // Opened by someone here: the size is theirs. The resize that follows (it settles first) is
      // what puts it into effect — the server counts this viewer once it has a size.
      if (claimOnOpenRef.current) {
        claimOnOpenRef.current = false;
        claim();
      }
      // The flex layout may still be settling on open; refit across a few frames so the size we
      // send matches what's actually displayed (otherwise Claude renders at a stale row count).
      sendResize();
      requestAnimationFrame(sendResize);
      setTimeout(sendResize, 150);
      // No repaint here any more. What the server sends on attach is a snapshot of the screen —
      // history, every visible row, the cursor, the modes — so there is nothing left unpainted for a
      // redraw to fill in. Asking for one anyway is what used to make the session's width flicker
      // (cols-1 and back) on every attach, and a TUI redrawing a transcript taller than the screen
      // cannot erase the copy that has scrolled above it: that is where the duplicated paragraphs in
      // the scrollback came from. The size still has to settle, so the refits stay.
      setTimeout(sendResize, 400);
    };
    const decoder = new TextDecoder();
    ws.onmessage = (e) => {
      lastInbound = Date.now(); // any frame proves the socket is still carrying traffic
      let text: string;
      if (typeof e.data === "string") {
        const control = controlFrame(e.data);
        if (control) {
          // The pong answering our heartbeat: it never belongs on screen, and seeing one is what
          // arms the silence check (this server speaks heartbeats).
          if (control.type === "pong") pongSeen = true;
          // The size the child is really being drawn at (see `agreedCols`). Take it as given: it is
          // the answer to our own resize, or word that another viewer has changed it.
          if (control.type === "size" && (control.cols ?? 0) > 0 && (control.rows ?? 0) > 0) {
            agreedCols = control.cols!;
            agreedRows = control.rows!;
            applyGrid();
          }
          return;
        }
        term.write(e.data);
        text = e.data;
      } else {
        const bytes = new Uint8Array(e.data);
        term.write(bytes);
        text = decoder.decode(bytes, { stream: true });
      }
      // Watch for Claude's "Session renamed to: <name>" confirmation and apply the new name directly.
      // Accumulate every frame (the confirmation's phrase and name can arrive in separate frames), and
      // require a following boundary char so the newest name — which the TUI ends with a box-drawing
      // char, not a newline — is captured cleanly instead of lagging a rename behind.
      scanBufRef.current = (scanBufRef.current + stripAnsi(text)).slice(-4096);
      if (RENAME_PHRASE.test(scanBufRef.current)) {
        let name: string | null = null;
        let repainted = true;
        for (const m of scanBufRef.current.matchAll(RENAME_CONFIRM)) {
          name = m.groups!.arg.trimEnd(); // last (most recent) confirmation wins; drop panel pad spaces
          repainted = isRepaint(m);
        }
        if (name && name !== lastNameRef.current && !(repainted && appliedNamesRef.current.has(name))) {
          lastNameRef.current = name;
          appliedNamesRef.current.add(name);
          onRenameRef.current?.(name);
        }
      }
      // Same detection for a `/color <name>` typed in the terminal.
      if (COLOR_PHRASE.test(scanBufRef.current)) {
        let color: string | null = null;
        let repainted = true;
        for (const m of scanBufRef.current.matchAll(COLOR_CONFIRM)) {
          color = m.groups!.arg.toLowerCase();
          repainted = isRepaint(m);
        }
        if (color && color !== lastColorRef.current && !(repainted && appliedColorsRef.current.has(color))) {
          lastColorRef.current = color;
          appliedColorsRef.current.add(color);
          onColorRef.current?.(color);
        }
      }
    };
    // A drop: the socket closed on us, or the heartbeat below caught it half-open. Runs once —
    // a closed socket that later fires onclose must not schedule a second reconnect.
    let dropped = false;
    const handleDrop = () => {
      if (closedByUs || dropped) return;
      dropped = true;
      term.write("\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n");
      setConnection("closed");
      const delay = RECONNECT_DELAYS_MS[retryRef.current];
      if (delay === undefined) return; // budget spent — the manual Reconnect button takes over
      retryRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        reattach(false);
      }, delay);
    };
    ws.onclose = handleDrop;

    const heartbeat = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (pongSeen && Date.now() - lastInbound > HEARTBEAT_DEAD_MS) {
        // Silent across three probes: the connection is half-open. close() on a dead socket can sit
        // in CLOSING until the OS gives up on the TCP connection, so drive the reconnect ourselves
        // instead of waiting for onclose to arrive.
        try {
          ws.close();
        } catch {
          /* nothing to close */
        }
        handleDrop();
        return;
      }
      ping();
    }, HEARTBEAT_INTERVAL_MS);

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(new TextEncoder().encode(d));
    });

    // Paste an image (e.g. a screenshot) into the terminal: upload it into the session's working
    // dir, then inject its path as a bracketed paste so Claude Code picks it up (like a drag-drop).
    // Non-image pastes fall through to xterm's normal text handling. Listens on document in the
    // capture phase so it fires before xterm processes the paste, regardless of focus target.
    const onPaste = async (e: ClipboardEvent) => {
      if (!imagePasteRef.current) return;
      // Leave alone any surface that attaches images itself — the postponed pool, the compose popup.
      // This listener is on document in the capture phase, so without the exemption it fires FIRST
      // and pastes the image into the live terminal as well as into the composer being written in,
      // which is a message going out that nobody asked to send. Marked with an attribute rather than
      // named per component so the next such surface inherits the exemption instead of the bug.
      if ((e.target as HTMLElement | null)?.closest?.("[data-owns-image-paste]")) return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      try {
        const { fullPath } = await uploadImageFile(sessionId, file);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(new TextEncoder().encode(`\x1b[200~${fullPath}\x1b[201~`));
      } catch {
        term.write("\r\n\x1b[31m[image paste failed]\x1b[0m\r\n");
      }
    };
    document.addEventListener("paste", onPaste, true);

    // Touch scrolling: xterm's built-in viewport touch handler only fires for touches that land on
    // the thin scrollbar viewport, but on mobile a drag lands on the screen overlay and never reaches
    // it — so scrollback is unreachable. Translate a one-finger vertical drag into scroll movement
    // ourselves. A tap (no meaningful move) falls through untouched, so tap-to-focus still works.
    //
    // Beyond the drag itself we add flick momentum: without it the content stops dead the instant the
    // finger lifts, which is the main reason this feels unlike a native scroll view. We track recent
    // pointer velocity, and on release keep scrolling with exponential decay until it dies out.
    const rowHeightOf = () =>
      // Guard both terms: a zero-height host (hidden pane) would otherwise divide to Infinity lines.
      host.clientHeight > 0 && term.rows > 0 ? host.clientHeight / term.rows : 18;

    // Apply `lines` of scroll, picking the mechanism the CURRENT buffer actually responds to.
    // Claude Code's TUI runs in the ALTERNATE screen buffer, which by definition has no scrollback:
    // there, `scrollLines` is a silent no-op and the only thing that moves the view is the app's own
    // scrolling, driven by arrow keys. xterm already implements exactly that translation in its wheel
    // handler (alt buffer + wheel → N cursor-key sequences, honoring DECCKM application-cursor mode),
    // so we hand it a synthetic wheel of the equivalent pixel delta rather than re-deriving the escape
    // sequences here. In the normal buffer (a plain shell) there IS scrollback, and scrollLines is the
    // direct path — no round trip through the PTY. Returns whether the view actually moved.
    const applyScroll = (lines: number, rowHeight: number): boolean => {
      if (term.buffer.active.type === "alternate") {
        const screen = host.querySelector(".xterm-screen");
        if (!screen) return false;
        // Untrusted events perform no default action, so this can't scroll the page — xterm's own
        // listener is the only thing that reacts to it.
        screen.dispatchEvent(
          new WheelEvent("wheel", { deltaY: lines * rowHeight, deltaMode: 0, bubbles: true, cancelable: true })
        );
        return true; // the app owns the scroll; we can't observe whether it hit an end
      }
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      return term.buffer.active.viewportY !== before;
    };
    let lastTouchY: number | null = null;
    let scrollAccum = 0; // sub-row remainder, carried across moves so slow drags still track 1:1
    let velocity = 0; // px per frame, signed like scrollAccum (positive = toward newer output)
    let lastMoveTs = 0;
    let momentumRaf = 0;
    const stopMomentum = () => {
      if (momentumRaf) cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
      velocity = 0;
    };
    const onTouchStart = (e: TouchEvent) => {
      stopMomentum(); // a new touch always grabs the content, mid-glide included
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
        scrollAccum = 0;
        lastMoveTs = e.timeStamp;
      } else {
        lastTouchY = null; // pinch/multi-touch: let the browser handle it
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || lastTouchY === null) return;
      const y = e.touches[0].clientY;
      const dy = lastTouchY - y; // dragging up (finger up) scrolls content up = toward newer
      scrollAccum += dy;
      lastTouchY = y;
      // Normalize to px-per-frame (~16.7ms) and smooth, so one jittery sample can't define the flick.
      const dt = Math.max(1, e.timeStamp - lastMoveTs);
      lastMoveTs = e.timeStamp;
      velocity = velocity * 0.7 + (dy / dt) * 16.7 * 0.3;
      const rowHeight = rowHeightOf();
      const lines = Math.trunc(scrollAccum / rowHeight);
      if (lines !== 0) {
        applyScroll(lines, rowHeight);
        scrollAccum -= lines * rowHeight;
      }
      // Own the gesture as soon as it reads as a vertical drag — even before a full row of travel —
      // so the page underneath never pans or pull-to-refreshes mid-scroll.
      if (Math.abs(scrollAccum) > 2 || lines !== 0) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      lastTouchY = null;
      // A stale sample (finger held still before lifting) must not fling; require a recent, fast move.
      if (e.timeStamp - lastMoveTs > 80 || Math.abs(velocity) < 1.5) {
        velocity = 0;
        return;
      }
      const step = () => {
        velocity *= 0.94; // ~0.5s glide; slower decay overshoots and feels slippery in a terminal
        if (Math.abs(velocity) < 0.4) return stopMomentum();
        scrollAccum += velocity;
        const rowHeight = rowHeightOf();
        const lines = Math.trunc(scrollAccum / rowHeight);
        if (lines !== 0) {
          const moved = applyScroll(lines, rowHeight);
          scrollAccum -= lines * rowHeight;
          if (!moved) return stopMomentum(); // hit top/bottom — don't keep spinning
        }
        momentumRaf = requestAnimationFrame(step);
      };
      momentumRaf = requestAnimationFrame(step);
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });
    host.addEventListener("touchcancel", stopMomentum, { passive: true });

    // Drive the jump-to-bottom button: it only makes sense while the viewport is off the live tail.
    // A few rows of slack keeps it from flickering on the last sliver of a drag.
    //
    // Read off the buffer rather than followed from one event, because no single event sees every
    // way the view moves. `onScroll` fires when output pushes the view along, but xterm suppresses
    // it for the scrolling a person does themselves -- dragging the scrollbar, or a wheel the
    // viewport handles -- which is precisely when the button is wanted. So the viewport's own scroll
    // event is watched too, and the buffer switch, which changes the answer without scrolling
    // anything at all.
    const readScroll = () => {
      const buf = term.buffer.active;
      // Nothing to jump to in the alternate buffer: a TUI like Claude's owns its whole screen, there
      // is no scrollback behind it, and xterm's scrollToBottom is a no-op there (the same reason
      // applyScroll hands that buffer a wheel instead). A button that cannot move the view is worse
      // than no button -- it reads as broken, because from where the user sits it is.
      setScrolledUp(buf.type === "normal" && buf.baseY - buf.viewportY > 2);
    };
    const scrollSub = term.onScroll(readScroll);
    const bufferSub = term.buffer.onBufferChange(readScroll);
    // After xterm's own listener, which is registered by term.open() above, so the buffer it reads
    // has already been moved to match the element.
    const viewport = host.querySelector(".xterm-viewport");
    viewport?.addEventListener("scroll", readScroll, { passive: true });
    readScroll();

    refitRef.current = sendResize;
    repaintRef.current = () => {
      // Re-measure and re-declare this grid before asking for the redraw. The button is pressed when
      // the screen shows characters Claude no longer has, and the way that happens is a grid and a
      // frame that disagree about their size — so saying again what we can show, and taking back
      // whatever the session settles on, is half the repair. The nudge is the other half.
      //
      // This is also the way back from a session still sized for another screen: the press is
      // someone using this one, so it claims the size, and asking again makes the terminal work out
      // afresh who is really watching.
      claim();
      sendResize();
      requestRepaint();
    };

    // Refit + notify the PTY whenever the pane resizes.
    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    // Using the terminal claims it. Listened for on the pane, not the page: the same session can sit
    // in two panes of one window, and a click in one is not a vote for the other's size. Focus covers
    // coming back to the window, which hands focus back to the terminal that had it. Capture, so a
    // key xterm swallows still counts.
    host.addEventListener("pointerdown", claim, true);
    host.addEventListener("keydown", claim, true);
    host.addEventListener("focusin", claim);

    // Backgrounding the tab throttles rAF/timers and pauses xterm's renderer; the ResizeObserver
    // stays silent because the size never changed, so nothing refits on return. Refit across a
    // couple frames whenever we become visible again (also covers OS-level tab/app switches).
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        withdrawSize();
        return;
      }
      // Coming back to the tab is someone at this screen, so the size follows them back.
      claimOnOpenRef.current = true;
      // A phone suspends the tab and the socket dies with it — often without the close event
      // landing until we're back. Re-attach right away instead of sitting out the backoff.
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reattach(true);
        return;
      }
      claimOnOpenRef.current = false;
      claim();
      // Coming back from a suspended tab is exactly when a socket turns out to be half-open, and
      // the liveness clock is stale from the time away. Probe now and allow one interval for the
      // answer, so a dead socket surfaces in ~15s rather than after the full silence window.
      lastInbound = Date.now() - (HEARTBEAT_DEAD_MS - HEARTBEAT_INTERVAL_MS);
      ping();
      // The socket stayed open across the tab switch, so xterm's buffer is intact — just refit and
      // repaint the existing cells.
      sendResize();
      requestAnimationFrame(sendResize);
      setTimeout(sendResize, 150);
      // One PTY serves every viewer of a session, so the same session open on a second machine may
      // have been driving its size while we were away. Re-asserting our own size above settles that:
      // if it changes the agreed grid the child redraws for it, and if it does not, the frame on
      // screen is already the one being drawn. We used to nudge the width here to force a redraw
      // regardless, which cost a duplicated copy of the transcript every time the frame was taller
      // than the screen — and there is nothing left for it to fix now that an attach starts from a
      // snapshot of the screen rather than a replay of the bytes that drew it.
    };
    document.addEventListener("visibilitychange", onVisible);

    // Back on the network after a drop: don't wait out the remaining backoff either.
    const onOnline = () => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) reattach(true);
    };
    window.addEventListener("online", onOnline);

    return () => {
      refitRef.current = () => {};
      repaintRef.current = () => {};
      claimRef.current = () => {};
      ro.disconnect();
      host.removeEventListener("pointerdown", claim, true);
      host.removeEventListener("keydown", claim, true);
      host.removeEventListener("focusin", claim);
      fileLinks.dispose();
      scrollSub.dispose();
      bufferSub.dispose();
      viewport?.removeEventListener("scroll", readScroll);
      stopMomentum();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", stopMomentum);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      clearInterval(heartbeat);
      // Safe unconditionally: a pending retry is always cleared before it bumps the generation, so
      // nothing scheduled can be lost here — this only kills a timer orphaned by unmount.
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("mouseup", onMouseUp);
      window.clearTimeout(resizeTimer);   // a size this terminal will never send now
      themeSub();
      dataSub.dispose();
      wsRef.current = null;
      closedByUs = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      termRef.current = null;
      // Hand the renderer back to the DOM one while the core is still alive, then dispose. Letting
      // term.dispose() unload the WebGL addon instead runs its teardown against a half-disposed
      // core, which throws — and a throw in an effect cleanup takes the whole React tree down with
      // it (white page). Both steps are guarded so a renderer hiccup can never escape unmount.
      try {
        webgl?.dispose();
      } catch {
        /* renderer already gone (context loss) */
      }
      webgl = null;
      try {
        term.dispose();
      } catch {
        /* nothing left to salvage at unmount */
      }
    };
  }, [sessionId, path, generation, reattach]);

  // Apply a zoom change to the live terminal. Only the font moves; the refit that follows works out
  // how many rows and columns now fit and tells Claude, so the TUI reflows to the new grid instead
  // of being cropped at the old one.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const size = fontSizeFor(zoom);
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    // Once now, once after the renderer has re-measured the character cell: fitting off the old cell
    // size would leave the grid a row or two out, and the PTY would be told a size nothing matches.
    refitRef.current();
    const raf = requestAnimationFrame(() => refitRef.current());
    return () => cancelAnimationFrame(raf);
  }, [zoom]);

  // Ctrl/⌘ with +, - or 0 zooms the terminal (0 resets), the same keys a desktop terminal uses.
  // Two things have to be talked out of these first: xterm, which would otherwise pass them to
  // Claude, and the browser, whose own zoom would take the whole app with it — so the handler
  // returns false (xterm stops) and calls preventDefault (the browser stops). Only while the
  // terminal has focus, since that is what "the terminal's zoom" means. Kept in a ref because the
  // terminal it attaches to is rebuilt on every session switch and reattach.
  const zoomKeysRef = useRef<(e: KeyboardEvent) => boolean>(() => true);
  zoomKeysRef.current = (e: KeyboardEvent) => {
    if (e.type !== "keydown" || e.altKey || !(e.ctrlKey || e.metaKey)) return true;
    // Match on both the character and the physical key: with a modifier down, layouts and the
    // numpad disagree about what `key` should be ("+" vs "=" vs "Add").
    const delta =
      e.key === "+" || e.key === "=" || e.code === "Equal" || e.code === "NumpadAdd"
        ? 1
        : e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract"
          ? -1
          : 0;
    const reset = e.key === "0" || e.code === "Digit0" || e.code === "Numpad0";
    if (!delta && !reset) return true;
    e.preventDefault();
    if (reset) setZoom(1);
    else stepZoom(delta);
    return false;
  };

  // Ctrl/⌘-wheel over the terminal zooms it, the way a desktop terminal does — without this the
  // browser would zoom the whole page instead, sidebar and all. Capture phase so xterm's own wheel
  // handler doesn't scroll the buffer on the way past.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let travel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      travel += e.deltaY;
      const steps = Math.trunc(travel / WHEEL_ZOOM_STEP);
      if (steps === 0) return;
      travel -= steps * WHEEL_ZOOM_STEP;
      // Wheel down (positive delta) zooms out, matching every other zoomable surface.
      stepZoom(-steps);
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => host.removeEventListener("wheel", onWheel, { capture: true });
  }, [stepZoom]);

  // Padding lives on the outer wrapper, not the host: FitAddon measures the host (the xterm's
  // parent) and only discounts padding on the .xterm element itself, so any padding here would make
  // it overcount rows and clip the last line. The host stays padding-free and edge-to-edge.
  //
  // The bottom is kept tight (the last TUI row sits at the pane's bottom edge) in two ways: barely
  // any bottom padding, and `justify-end` on the host. FitAddon can only fit whole rows, so up to one
  // row of height is always left over; xterm renders top-aligned, which parked that slack right under
  // the status line. Bottom-aligning moves it to the top edge, where it reads as breathing room under
  // the header instead of a gap in the middle of the layout.
  return (
    <div className="group relative h-full w-full bg-white px-2 pt-2 pb-0.5 dark:bg-[#0a0a0a]">
      <div
        ref={hostRef}
        className="flex h-full w-full flex-col justify-end overscroll-contain overflow-hidden"
      />
      {/* The pane's own controls, in one row so they cannot land on top of each other. Kept out of
          sight until the pointer is over the pane, so nothing is permanently parked on the TUI's
          top-right corner — and always visible on touch, where there is no hover to reveal them. */}
      <div className="absolute right-4 top-3 z-10 flex items-center gap-1.5">
        {/* The grid is drawn into a canvas, so there is nothing for a finger to select: no DOM text
            for the OS to grab, and xterm's own selection runs on mouse events that iOS only
            synthesizes for a tap. Rather than reimplement a selection UI badly, hand the buffer to
            the browser as text and let the platform's own one — magnifier, handles, Copy — do it. */}
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            const term = termRef.current;
            if (!term) return;
            setCopiedAll(false);
            setSelectionText(bufferText(term));
          }}
          title="Select text — opens the terminal's text so you can select and copy it"
          aria-label="Select text"
          className={cn(
            "size-8 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-opacity hover:text-foreground",
            "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        >
          <TextSelect className="size-4" />
        </Button>
        {/* Force a redraw. Claude's TUI paints differentially — only the rows it believes changed —
            so a grid that has drifted from its model (a second viewer driving the size, a frame that
            landed mid-resize) keeps showing characters the TUI has already dropped. They can't be
            backspaced over, because they aren't in the input any more: they're only on screen. The
            host answers this by nudging the PTY size, which is the one thing that makes Ink repaint
            the whole frame. Local refresh first, for a stale cell that never left the renderer. */}
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            repaintRef.current();
            setRepainting(true);
            window.clearTimeout(repaintTimerRef.current);
            repaintTimerRef.current = window.setTimeout(() => setRepainting(false), 600);
          }}
          title="Redraw — refit to this window and clear leftover characters Claude no longer has"
          aria-label="Redraw the terminal"
          className={cn(
            "size-8 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-opacity hover:text-foreground",
            "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        >
          <RefreshCw className={cn("size-4", repainting && "animate-spin")} />
        </Button>
        {/* Zoom for the terminal alone (the browser's own zoom takes the whole app with it). Pinned
            open once zoomed, since a non-default size should say so and offer the way back. */}
        <ZoomControls
          zoom={zoom}
          onChange={setZoom}
          className={cn(
            "static transition-opacity",
            zoom === 1 &&
              "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
          )}
        />
      </div>

      {/* Selection overlay: the buffer as real text, over the pane rather than beside it so the
          reading position is unchanged. It covers the host, which is what stands the pane's own
          touch-scroll handler down — those listeners are on the host, and nothing reaches it now,
          so a drag here scrolls and selects exactly the way it does on any other page. */}
      {selectionText !== null && (
        <div className="absolute inset-0 z-20 flex flex-col bg-background">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              A snapshot — select and copy, then close.
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Selecting ten thousand lines of scrollback by hand is not a thing anyone should be
                  asked to do on a phone, so the whole snapshot is one tap away. */}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await writeToClipboard(selectionText);
                  setCopiedAll(true);
                  setTimeout(() => setCopiedAll(false), 1500);
                }}
              >
                {copiedAll ? (
                  <Check className="size-4 text-emerald-500" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copiedAll ? "Copied" : "Copy all"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setSelectionText(null)}>
                <X className="size-4" />
                Close
              </Button>
            </div>
          </div>
          {/* Opened scrolled to the end: what you came to copy is nearly always the last thing that
              happened, and on a phone a thousand rows of scrollback is a long way back up. */}
          <pre
            ref={(el) => {
              if (el) el.scrollTop = el.scrollHeight;
            }}
            style={{ fontSize: fontSizeFor(zoom) }}
            className="min-h-0 flex-1 select-text overflow-auto overscroll-contain whitespace-pre px-3 py-2 font-mono leading-5"
          >
            {selectionText}
          </pre>
        </div>
      )}
      {/* The socket dropped (sleep, a backgrounded tab, a network blip). Automatic re-attach is
          already backing off behind this chip; the button is the escape hatch for when it gave up
          or you'd rather not wait — the same effect as the page reload people did by hand. */}
      {(connection === "closed" || connection === "reconnecting") && (
        <div className="absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <button
            type="button"
            onClick={() => {
              claimOnOpenRef.current = true;
              reattach(true);
            }}
            disabled={connection === "reconnecting"}
            title="Reattach this terminal to the session"
            className="flex items-center gap-2 rounded-full border bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-md backdrop-blur transition hover:text-foreground disabled:opacity-70"
          >
            <RefreshCw className={cn("size-4", connection === "reconnecting" && "animate-spin")} />
            {connection === "reconnecting" ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      )}
      {/* Scrolled off the live tail: one tap back to the bottom, instead of flicking through
          scrollback. Sits in the corner, clear of the centered reconnect chip — and, in Claude's
          terminal, stacked above the postponed pool's buttons, which SessionView floats there.

          z-10 like the controls above, and for the same reason: xterm's link layer is a canvas at
          z-index 2 over the whole screen area, so anything laid on the pane without a z-index of its
          own is under it. The canvas is transparent, so the button still LOOKS right — it just hands
          the click to the terminal. And since that canvas is only as wide as cols × cell, whether it
          reaches this corner depends on the leftover slack at the pane's right edge, which is why it
          worked often enough to look like the button was merely flaky. */}
      {scrolledUp && (
        <button
          type="button"
          onClick={() => termRef.current?.scrollToBottom()}
          title="Jump to the latest output"
          aria-label="Jump to the latest output"
          className={cn(
            "absolute right-4 z-10 rounded-full border bg-background/90 p-3 text-muted-foreground shadow-md backdrop-blur transition hover:text-foreground",
            cornerTaken ? "bottom-12" : "bottom-4"
          )}
        >
          <ArrowDown className="size-5" />
        </button>
      )}
    </div>
  );
});
