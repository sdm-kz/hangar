import type { Api } from "@/lib/api";

export function readAsDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

// Read an image File, strip the data-URL prefix, and upload it into the session's working dir.
// Returns the session-relative and absolute paths. Shared by the paste handlers and the attach
// buttons so every image entry point goes through one code path. `api` is the session's node's.
export async function uploadImageFile(api: Api, sessionId: string, file: File) {
  const ext = file.type.split("/")[1] || "png";
  const dataUrl = await readAsDataURL(file);
  const b64 = dataUrl.split(",", 2)[1] ?? "";
  return api.uploadSessionImage(sessionId, b64, ext);
}
