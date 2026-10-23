import type { CSSProperties, ReactNode } from "react";
import { Monitor } from "lucide-react";

/**
 * A machine's mark, by the OS it runs ("windows", "macos", "linux", as /api/node and the stream name it):
 * the Windows panes, the Apple, a penguin. Drawn in currentColor so the machine's colour tints it, as it
 * did the plain monitor still shown for a machine whose OS isn't known (one on an older build).
 */
export function OsIcon({ os, className, style }: { os?: string | null; className?: string; style?: CSSProperties }) {
  const glyph = os ? GLYPHS[os] : undefined;
  if (!glyph) return <Monitor className={className} style={style} />;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden="true">
      {glyph}
    </svg>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  windows: <path d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7l-7.5-1zM11.5 12.5H21V21l-9.5-1.4z" />,
  macos: (
    <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
  ),
  // A penguin: the body with its belly and eyes cut out, and its feet in front.
  linux: (
    <>
      <path
        fillRule="evenodd"
        d="M4.5 12.5a7.5 10 0 1 0 15 0a7.5 10 0 1 0-15 0zM7 15.5a5 6.2 0 1 0 10 0a5 6.2 0 1 0-10 0zM8.1 7.2a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM12.9 7.2a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0z"
      />
      <path d="M5.3 22.2a3 1.5 0 1 0 6 0a3 1.5 0 1 0-6 0zM12.7 22.2a3 1.5 0 1 0 6 0a3 1.5 0 1 0-6 0z" />
    </>
  ),
};
