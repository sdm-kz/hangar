// The app's own clipboard for files: what was copied (or cut) in one file panel, waiting to be pasted
// into another. It has to be the app's rather than the system's — the files are on the server
// machine or on a remote host, never in this browser — and it has to span panels, which is the point:
// copy on the remote host, paste into the session's folder; copy in one SSH tab, paste into another.
//
// Kept in localStorage as well as in memory, so a copy survives a reload and reaches the app's other
// tabs in this browser (the `storage` event); it never leaves the browser, since what it names only
// means something to the server it was copied from.
import { useEffect, useState } from "react";
import type { TransferSide } from "@/types";
import { homeNodeId, nodeOfBase } from "./node";

export interface ClipItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FileClip {
  mode: "copy" | "cut";
  /**
   * The node the items were copied on, as its API base ("" for the one this page came from). Paths and
   * session ids only mean something there: a paste on another node names it — see {@link clipSourceFor}.
   * Absent in a clip saved before nodes: this node's.
   */
  base?: string;
  source: TransferSide;
  /** What to call the source in a tooltip: the host, or the session's folder. */
  label: string;
  items: ClipItem[];
}

const KEY = "hangar.fileClipboard";

let current: FileClip | null = read();
const listeners = new Set<(c: FileClip | null) => void>();

function read(): FileClip | null {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as FileClip) : null;
    return v && Array.isArray(v.items) && v.items.length > 0 && v.source ? v : null;
  } catch {
    return null;
  }
}

function publish(next: FileClip | null) {
  current = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage disabled — the clipboard still works within this tab */
  }
  for (const l of listeners) l(next);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = read();
    for (const l of listeners) l(current);
  });
}

export function getFileClip(): FileClip | null {
  return current;
}

export function setFileClip(clip: FileClip | null) {
  publish(clip && clip.items.length > 0 ? clip : null);
}

/** After a cut is pasted the items have moved; a second paste would find nothing. */
export function clearFileClip() {
  publish(null);
}

/**
 * The source of a paste as the node with API base `base` — the one the panel is on — has to be told it: as
 * copied, when that is where the files are; with the node they are on, when they were copied on another
 * (plans/multi-node.md, phase 6). That node reads them through its pairing with the other, so it must be
 * paired with it — the server says so when it isn't. Or why it can't be pasted there at all.
 */
export function clipSourceFor(clip: FileClip, base: string): { source: TransferSide } | { error: string } {
  const from = clip.base ?? "";
  if (from === base) return { source: clip.source };
  if (clip.source.kind !== "session")
    return { error: "Those are on an SSH connection of another machine. Paste them on that machine." };
  // A peer reads them from the node they are on with its own pairing — never from a third on this one's
  // say-so (one hop, as everywhere between nodes; the server refuses it too).
  if (from && base)
    return { error: "Those were copied on another paired machine. Paste them on this machine, or on that one." };
  // Named by id, as the node the paste runs on knows it: this page's own node by its id, a peer by its.
  const node = nodeOfBase(from) ?? homeNodeId();
  if (!node) return { error: "This machine's id isn't known yet. Try again in a moment." };
  return { source: { ...clip.source, node } };
}

/** Whether two ends of a paste are the same panel's filesystem. */
export function sameSide(a: TransferSide, b: TransferSide): boolean {
  if (a.kind === "remote" && b.kind === "remote") return a.tab === b.tab;
  if (a.kind === "session" && b.kind === "session") return a.sessionId === b.sessionId && (a.dir ?? "") === (b.dir ?? "");
  return false;
}

export function useFileClip(): FileClip | null {
  const [clip, setClip] = useState(current);
  useEffect(() => {
    listeners.add(setClip);
    setClip(current);
    return () => void listeners.delete(setClip);
  }, []);
  return clip;
}

// A remote panel hears about a change made from another panel — a move out of its folder, a paste
// into it — and re-lists what it has open. Same page only; the server is the source of truth anyway.
export const REMOTE_CHANGED_EVENT = "hangar:remote-changed";
export interface RemoteChange {
  tab: string;
  /** Paths moved away from that tab — a preview still showing one of them must let it go. */
  gone?: string[];
}
export function announceRemoteChange(tab: string, gone?: string[]) {
  window.dispatchEvent(new CustomEvent<RemoteChange>(REMOTE_CHANGED_EVENT, { detail: { tab, gone } }));
}

/** Whether a keypress should be left to the browser: there is text selected to copy. */
export function hasTextSelection(): boolean {
  return !!window.getSelection()?.toString();
}

/** "3 items" / "notes.md" — how a clip is named on a Paste button's tooltip. */
export function describeClip(clip: FileClip): string {
  const what = clip.items.length === 1 ? clip.items[0].name : `${clip.items.length} items`;
  return `${clip.mode === "cut" ? "Move" : "Paste"} ${what} from ${clip.label}`;
}
