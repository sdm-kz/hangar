/**
 * Carrying a session's work to another machine (plans/multi-node.md, phase 6): the same repo sits at another
 * path there — `C:\Git\app` here, `/Users/me/git/app` on a Mac — and these find it.
 */

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

const windowsStyle = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

/**
 * The folder among `candidates` (the folders known on the other machine) that ends the way `source` does,
 * the most trailing names in common winning; `source` itself when it is there. Null when none shares even
 * the last name. Names are compared without regard to case, as one of the two may be Windows.
 */
export function matchFolder(source: string, candidates: Iterable<string>): string | null {
  const want = segments(source).map((s) => s.toLowerCase());
  if (want.length === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c === source) return c;
    const have = segments(c).map((s) => s.toLowerCase());
    let n = 0;
    while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
    // A longer match, or as long a match with less in front of it (the repo rather than a folder inside it).
    if (n > bestScore || (n === bestScore && n > 0 && best && segments(c).length < segments(best).length)) {
      best = c;
      bestScore = n;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Whether a memory's text names paths of the other kind of machine than `targetDir`'s — Windows paths
 * carried to a Mac, or Unix home paths to Windows: worth a look before it is copied, since it is a note
 * about the machine it was written on.
 */
export function mentionsOtherPaths(content: string, targetDir: string): boolean {
  return windowsStyle(targetDir) ? /(^|[\s`'"(])\/(Users|home)\//m.test(content) : /\b[A-Za-z]:\\/.test(content);
}
