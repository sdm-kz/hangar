/** Several PNGs as one IPC body: each after its length in 4 bytes, little-endian. `split_images` in
 *  lib.rs takes them apart. */
export function packImages(pngs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pngs.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const png of pngs) {
    view.setUint32(at, png.length, true);
    out.set(png, at + 4);
    at += 4 + png.length;
  }
  return out;
}
