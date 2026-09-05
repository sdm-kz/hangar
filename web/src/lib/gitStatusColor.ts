// Colour for a file's git status letter, shared by everything that lists changed files: the tree,
// the changes view, the commit history and the session's file tabs.
export const STATUS_COLOR: Record<string, string> = {
  M: "text-amber-500",
  A: "text-emerald-500",
  U: "text-emerald-500",
  D: "text-red-500",
  R: "text-sky-500",
};
