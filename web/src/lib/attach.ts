// Files attached to a message — dropped on a message box, or picked with its attach button. An image goes
// with the message as an image, as a pasted one does. Any other file is saved beside the pasted images,
// in the session's .hangar/uploads/, and its path is written into the message for Claude to read.
import { useRef, useState, type DragEvent } from "react";
import type { Api } from "@/lib/api";
import type { PostponedImage } from "@/lib/postponed";
import { uploadImageFile } from "@/lib/upload";

export interface Attached {
  images: PostponedImage[];
  /** Full paths of the other files, to name in the message. */
  paths: string[];
  /** Files that didn't upload. */
  failed: number;
}

/** Upload what was dropped or picked, into the session's working directory. */
export async function uploadAttachments(api: Api, sessionId: string, files: File[]): Promise<Attached> {
  const out: Attached = { images: [], paths: [], failed: 0 };
  const others = files.filter((f) => !f.type.startsWith("image/"));
  for (const f of files.filter((f) => f.type.startsWith("image/"))) {
    try {
      const { path, fullPath } = await uploadImageFile(api, sessionId, f);
      out.images.push({ path, fullPath });
    } catch {
      out.failed++;
    }
  }
  if (others.length) {
    try {
      const { files: saved } = await api.uploadSessionAttachments(sessionId, others);
      out.paths.push(...saved.map((s) => s.fullPath));
      out.failed += others.length - saved.length;
    } catch {
      out.failed += others.length;
    }
  }
  return out;
}

/** What an upload that went wrong says, or null if it all went. */
export function attachError(a: Attached): string | null {
  if (!a.failed) return null;
  return a.failed === 1 ? "A file didn't upload." : `${a.failed} files didn't upload.`;
}

/**
 * `paths` written into `text` where the caret of `el` is (the end without one), set apart by spaces and
 * quoted where they hold one. Returns the new text and where the caret goes after them.
 */
export function insertPaths(
  text: string,
  el: HTMLTextAreaElement | null,
  paths: string[]
): { text: string; caret: number } {
  const at = Math.min(el?.selectionEnd ?? text.length, text.length);
  const words = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const added = lead + words + trail;
  return { text: before + added + after, caret: at + added.length };
}

/**
 * Put the caret of `el` at `caret()` once the new text is in it. A getter: the place is worked out in a
 * state updater, which React runs when it renders, not when the update is asked for.
 */
export function placeCaret(el: HTMLTextAreaElement | null, caret: () => number) {
  requestAnimationFrame(() => {
    if (el) el.selectionStart = el.selectionEnd = caret();
  });
}

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Make an element take files dragged onto it. `over` is true while some are held over it, for the box to
 * say it will take them. Only a drag of files counts: text or a tab dragged across is left alone.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  // Entering a child fires dragenter on it before dragleave on the parent: count, so crossing between
  // them doesn't flicker the cue off.
  const depth = useRef(0);
  const latest = useRef(onFiles);
  latest.current = onFiles;
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) latest.current(files);
    },
  };
  return { over, dropProps };
}

/**
 * Files dropped anywhere that doesn't take them are not opened by the browser in place of the app, which
 * would throw away whatever was being written. Call once; returns the undo.
 */
export function guardFileDrops(): () => void {
  const stop = (e: globalThis.DragEvent) => {
    if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", stop);
  window.addEventListener("drop", stop);
  return () => {
    window.removeEventListener("dragover", stop);
    window.removeEventListener("drop", stop);
  };
}
