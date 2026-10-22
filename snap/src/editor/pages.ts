import { api, type EditorInit } from "@/lib/tauri";
import { emptyHistory, type Doc, type History } from "./model";
import { FIT, type View } from "./view";

/** As many pictures as the server takes in one message. */
export const MAX_PAGES = 10;

/**
 * One capture in an editor, with its drawing. The page on show keeps its drawing and view in the
 * editor's own state while it is; what is here for it is how it was when last left.
 */
export interface Page {
  id: string;
  init: EditorInit;
  image: HTMLImageElement;
  /** The blob: URL the image was loaded from — this page's own origin, so the canvas stays exportable. */
  url: string;
  history: History;
  view: View;
  /** A small picture of it for the strip, drawing included as of when it was last drawn from. */
  thumb: string;
  /** Its flattened PNG as it was left, for sending, and the drawing that was; null until it has been left. */
  flat: { doc: Doc; png: Promise<Uint8Array> } | null;
}

/** Fetch capture `id` from the app and decode it. Rejects with "pending" while a spare editor's capture
 *  hasn't arrived yet. */
export async function loadPage(id: string): Promise<Page> {
  const [init, png] = await Promise.all([api.editorInit(id), api.capturePng(id)]);
  const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load the capture."));
      img.src = url;
    });
    return { id, init, image, url, history: emptyHistory(), view: FIT, thumb: thumbnail(image), flat: null };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** The capture as it came, undrawn on: what a page that was never left sends. */
export async function rawPng(page: Page): Promise<Uint8Array> {
  const res = await fetch(page.url);
  return new Uint8Array(await res.arrayBuffer());
}

/** Device pixels the strip's thumbnails are drawn within: twice what they show at, for sharp ones on
 *  a scaled screen. */
const THUMB = { width: 192, height: 96 };

export function thumbnail(source: HTMLImageElement | HTMLCanvasElement): string {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const scale = Math.min(1, THUMB.width / w, THUMB.height / h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** `items` with the one at `from` moved to `to`. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** The page to show once `index` is gone: the one after it, or before it when it was the last. */
export function neighbourOf<T>(items: T[], index: number): T | null {
  return items[index + 1] ?? items[index - 1] ?? null;
}
