/**
 * Every keyboard shortcut worth knowing, for Settings → Shortcuts and its search. A list kept by hand: the
 * handlers live with the components they belong to, so a shortcut added or changed there is added or
 * changed here too.
 *
 * A chord is a list of keys. `mod` is Ctrl, or ⌘ on a Mac — what the handlers check as
 * `e.ctrlKey || e.metaKey` — while `ctrl` is Ctrl on every platform (the tray's capture hotkeys).
 */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export type Key = "mod" | "ctrl" | "shift" | "alt" | (string & {});

export interface Shortcut {
  id: string;
  /** Alternatives, any of which does it: [["mod", "="], ["mod", "wheel"]]. */
  keys: Key[][];
  does: string;
  /** Said under the action where it matters: when it applies, what it needs. */
  note?: string;
  keywords?: string[];
}

export interface ShortcutGroup {
  id: string;
  title: string;
  /** Where these work, said once under the group's heading. */
  where?: string;
  shortcuts: Shortcut[];
}

const MAC_NAMES: Record<string, string> = { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥", Enter: "↩" };
const PC_NAMES: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };

/** One key as this platform names it. */
export const keyName = (k: Key) => (IS_MAC ? MAC_NAMES : PC_NAMES)[k] ?? k;

/**
 * A chord as text, for tooltips and the search results: "Ctrl+Shift+S", or "⌘⇧S" on a Mac — where a
 * mouse action after the modifiers is spelled "⌘-click".
 */
export const chordText = (chord: Key[]) =>
  IS_MAC
    ? chord.map((k, i) => (i > 0 && (k === "click" || k === "wheel") ? `-${k}` : keyName(k))).join("")
    : chord.map(keyName).join("+");

/** `chordText` for keys written out in place: `title={`Send (${chord("mod", "Enter")})`}`. */
export const chord = (...keys: Key[]) => chordText(keys);

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: "anywhere",
    title: "Anywhere",
    shortcuts: [
      { id: "search", keys: [["mod", "shift", "F"]], does: "Search sessions", keywords: ["find", "jump"] },
      { id: "settings", keys: [["mod", "shift", "S"]], does: "Open Settings", keywords: ["preferences", "options"] },
      {
        id: "help",
        keys: [["?"]],
        does: "Show these shortcuts",
        note: "Outside a text box and the terminal",
        keywords: ["help", "keyboard", "hotkeys"],
      },
      { id: "session-tab", keys: [["mod", "click"]], does: "Open a session in a new browser tab", note: "In the sessions list; a middle-click too" },
    ],
  },
  {
    id: "panes",
    title: "Split panes",
    where: "On a wide screen, with the focus out of text boxes (the terminal is fine).",
    shortcuts: [
      { id: "split-right", keys: [["alt", "\\"]], does: "Split the tab to the right", keywords: ["layout", "group"] },
      { id: "split-down", keys: [["alt", "-"]], does: "Split the tab downwards", keywords: ["layout", "group"] },
      { id: "focus-group", keys: [["alt", "1…4"]], does: "Go to pane group 1 to 4", keywords: ["layout", "switch"] },
      { id: "maximize", keys: [["alt", "Z"]], does: "Maximize or restore the pane group", keywords: ["zoom", "layout", "fullscreen"] },
      { id: "move-tab", keys: [["alt", "shift", "←↑→↓"]], does: "Move the tab to the next group that way", keywords: ["layout"] },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    shortcuts: [
      { id: "terminal-zoom", keys: [["mod", "="], ["mod", "-"], ["mod", "wheel"]], does: "Make the text bigger or smaller", keywords: ["zoom", "font", "size"] },
      { id: "terminal-zoom-reset", keys: [["mod", "0"]], does: "Text back to its usual size", keywords: ["zoom", "reset", "font"] },
      { id: "terminal-link", keys: [["mod", "click"]], does: "Open a link, or a file path in the viewer", note: "A tap does it on a touch screen", keywords: ["url"] },
    ],
  },
  {
    id: "chat",
    title: "Chat",
    shortcuts: [
      { id: "chat-find", keys: [["mod", "F"]], does: "Find in the conversation", keywords: ["search"] },
      { id: "chat-find-next", keys: [["Enter"], ["↓"]], does: "Next match", note: "In the find box" },
      { id: "chat-find-prev", keys: [["shift", "Enter"], ["↑"]], does: "Previous match", note: "In the find box" },
      { id: "chat-zoom", keys: [["mod", "="], ["mod", "-"], ["mod", "wheel"]], does: "Make the chat bigger or smaller", keywords: ["zoom", "font", "size"] },
      { id: "chat-zoom-reset", keys: [["mod", "0"]], does: "Chat back to its usual size", keywords: ["zoom", "reset"] },
    ],
  },
  {
    id: "message",
    title: "Message box",
    where: "Under the chat, and in the postponed messages and the full-size Compose window where noted.",
    shortcuts: [
      { id: "send", keys: [["Enter"]], does: "Send", note: "On a touch screen Enter is a new line", keywords: ["submit", "message"] },
      { id: "newline", keys: [["shift", "Enter"]], does: "New line" },
      {
        id: "postpone",
        keys: [["mod", "shift", "Enter"]],
        does: "Postpone the message instead of sending it",
        note: "Holding the keys turns Send into Postpone",
        keywords: ["later", "queue", "stash"],
      },
      { id: "slash", keys: [["/"]], does: "Suggest slash commands", note: "Anywhere in the text", keywords: ["command", "autocomplete"] },
      { id: "slash-pick", keys: [["↑"], ["↓"]], does: "Choose a suggested command" },
      { id: "slash-take", keys: [["Tab"], ["Enter"]], does: "Take the suggested command" },
      { id: "slash-close", keys: [["Esc"]], does: "Close the suggestions" },
      { id: "compose-send", keys: [["mod", "Enter"]], does: "Send, in the Compose window", note: "Enter is a new line there" },
      { id: "compose-postpone", keys: [["mod", "shift", "Enter"]], does: "Postpone, or save the postponed message being edited, in the Compose window" },
      { id: "pool-stash", keys: [["Enter"]], does: "Add to the postponed messages, in their box", keywords: ["stash", "queue"] },
      { id: "pool-newline", keys: [["shift", "Enter"], ["mod", "J"]], does: "New line, in the postponed messages' box" },
    ],
  },
  {
    id: "search",
    title: "Session search",
    shortcuts: [
      { id: "search-next", keys: [["↓"], ["Tab"]], does: "Next result" },
      { id: "search-prev", keys: [["↑"], ["shift", "Tab"]], does: "Previous result" },
      { id: "search-open", keys: [["Enter"]], does: "Open the session" },
    ],
  },
  {
    id: "files",
    title: "Files",
    where: "In the file trees: the Files tab, the files sidebar and another machine's files.",
    shortcuts: [
      { id: "tree-move", keys: [["↑"], ["↓"], ["Home"], ["End"]], does: "Move through the tree" },
      { id: "tree-open", keys: [["→"], ["←"]], does: "Open or close a folder, or go to its parent" },
      { id: "tree-enter", keys: [["Enter"]], does: "Open the file, or open or close the folder" },
      { id: "tree-copy", keys: [["mod", "C"], ["mod", "X"]], does: "Copy or cut the marked files", keywords: ["clipboard"] },
      { id: "tree-paste", keys: [["mod", "V"]], does: "Paste the files copied or cut", keywords: ["clipboard"] },
      { id: "tree-range", keys: [["shift", "click"]], does: "Mark a range of files", note: "With marking on", keywords: ["select"] },
      { id: "tree-pin", keys: [["mod", "click"]], does: "Open a file in a tab of its own", keywords: ["pin"] },
      { id: "tree-clear", keys: [["Esc"]], does: "Unmark everything", keywords: ["select"] },
      { id: "tree-delete", keys: [["Delete"]], does: "Delete the marked files", note: "On another machine's files" },
      { id: "tree-rename", keys: [["F2"]], does: "Rename", note: "On another machine's files" },
    ],
  },
  {
    id: "viewer",
    title: "File viewer and code",
    where: "In an open file, a commit, and a pull request's changes.",
    shortcuts: [
      { id: "goto-line", keys: [["mod", "G"]], does: "Go to a line", keywords: ["jump", "number"] },
      { id: "viewer-exit", keys: [["Esc"]], does: "Leave the full-page view" },
      { id: "mark-name", keys: [["click"]], does: "Mark every place a name is used", note: "On a name in code", keywords: ["highlight", "occurrences"] },
      { id: "declaration", keys: [["mod", "click"]], does: "Go to where a name is declared", keywords: ["definition", "jump"] },
      { id: "next-use", keys: [["F3"], ["shift", "F3"]], does: "Next or previous place it is used", note: "While names are marked", keywords: ["occurrence"] },
      { id: "clear-marks", keys: [["Esc"]], does: "Clear the marks" },
    ],
  },
  {
    id: "images",
    title: "Images",
    where: "In an image opened full size.",
    shortcuts: [
      { id: "image-step", keys: [["←"], ["→"]], does: "Previous or next image", keywords: ["gallery"] },
      { id: "image-zoom", keys: [["+"], ["-"]], does: "Zoom in or out" },
      { id: "image-fit", keys: [["0"]], does: "Fit the image to the page", keywords: ["zoom"] },
      { id: "image-copy", keys: [["mod", "C"]], does: "Copy the image", keywords: ["clipboard"] },
      { id: "image-close", keys: [["Esc"]], does: "Close" },
    ],
  },
  {
    id: "review",
    title: "Pull request review",
    shortcuts: [
      { id: "comment-send", keys: [["mod", "Enter"]], does: "Send the comment to the session now", note: "In a comment on a line" },
      { id: "comment-review", keys: [["mod", "shift", "Enter"]], does: "Add the comment to the review" },
      { id: "comment-close", keys: [["Esc"]], does: "Close the comment" },
      { id: "review-send", keys: [["mod", "Enter"]], does: "Send the review", note: "In the review" },
      { id: "review-save", keys: [["mod", "S"]], does: "Save the review for later", note: "In the review" },
    ],
  },
  {
    id: "tray",
    title: "Tray app",
    where: "The desktop tray app. Its capture hotkeys are the defaults; change them in its Settings.",
    shortcuts: [
      { id: "capture-region", keys: [["ctrl", "shift", "1"]], does: "Capture a region", keywords: ["screenshot"] },
      { id: "capture-window", keys: [["ctrl", "shift", "2"]], does: "Capture a window", keywords: ["screenshot"] },
      { id: "capture-screen", keys: [["ctrl", "shift", "3"]], does: "Capture the full screen", keywords: ["screenshot"] },
      { id: "capture-freeform", keys: [["ctrl", "shift", "4"]], does: "Capture a freeform shape", keywords: ["screenshot"] },
      { id: "editor-send", keys: [["mod", "Enter"]], does: "Send the capture with its message", note: "In the screenshot editor" },
      { id: "editor-postpone", keys: [["mod", "shift", "Enter"]], does: "Postpone it to the session's postponed messages" },
      { id: "editor-add", keys: [["mod", "shift", "N"]], does: "Add another capture to the message" },
      { id: "editor-target", keys: [["alt", "↑"], ["alt", "↓"]], does: "Send to another session", note: "From the message box" },
      { id: "editor-undo", keys: [["mod", "Z"], ["mod", "shift", "Z"]], does: "Undo or redo" },
      { id: "editor-save", keys: [["mod", "C"], ["mod", "S"]], does: "Copy or save the image" },
    ],
  },
];
