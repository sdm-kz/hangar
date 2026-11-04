/**
 * Joining a session-relative path onto the folder it lives in, in the separator that folder is
 * written with.
 *
 * The browser has no idea what the server runs; what it has is the working directory the server
 * handed it, and that is already in the server's own form -- "C:\Git\app" or "/srv/app". So the
 * separator is read off the root rather than guessed, and the relative half (always forward slashes
 * over the wire) is converted to match. A path is copied to be pasted somewhere -- a terminal, an
 * editor, a chat -- and half of one in each convention is a path nobody can use.
 */
export function nativePath(root: string, rel: string): string {
  const base = root.replace(/[/\\]+$/, "");
  if (!base) return rel;
  // A drive letter or a backslash anywhere says Windows; a UNC root ("\\host\share") says it twice.
  const windows = /\\/.test(base) || /^[A-Za-z]:/.test(base);
  const sep = windows ? "\\" : "/";
  // The root needs it as much as the tail: a worktree's comes from git, which writes Windows paths
  // with forward slashes ("C:/Git/app-worktrees/feature"). Only flipped, not collapsed, so a UNC
  // root keeps its leading pair.
  const head = windows ? base.replace(/\//g, "\\") : base;
  const tail = rel.replace(/^[/\\]+/, "").replace(/[/\\]+/g, sep);
  return tail ? `${head}${sep}${tail}` : head;
}
