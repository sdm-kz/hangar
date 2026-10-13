// Finding file paths in a line of terminal output, so they can be underlined and opened.
//
// Three rules, most specific first; where two find overlapping text, the earlier rule's match wins:
//
//  1) A QUOTED path ("…", '…' or `…`) with a separator in it is taken whole, quotes left out, spaces
//     and all. A program printing a path that has spaces in it nearly always quotes it, and inside
//     quotes there is no doubt where the path ends.
//  2) A DRIVE-ROOTED Windows path (C:\…) may have spaces in its folder and file names too: it starts
//     at the drive letter and ends at the first file extension that is followed by a space,
//     punctuation or the end of the line -- so "C:\Program Files\PostgreSQL\16\bin\psql.exe -X" is
//     one link, and the full stop after "…\report.html." is not part of it.
//  3) Everything else, as before: a path with a separator whose names have no spaces (relative,
//     POSIX, or a drive path), or a bare filename with a known extension. An unquoted POSIX path with
//     spaces stays out of reach: "/home/me/My Docs/x.txt" in a sentence can't be told from prose.
//
// Names are letters and digits of any script (\p{L}, \p{N}, hence the `u` flag), not just ASCII \w,
// so a path through "Документы" or to "Отчёт.docx" is a link like any other.

/** Rule 1: a quoted path. Group 2 is the path itself. */
const QUOTED_PATH = /(["'`])((?:[A-Za-z]:)?[\\/]?(?:[^"'`\\/\r\n]+[\\/])+[^"'`\\/\r\n]+\.[A-Za-z0-9]{1,12})\1/gu;

/**
 * Rule 2: a drive-rooted Windows path that may contain spaces. Names exclude what Windows forbids in
 * a name (and quotes), so a second path on the line ("…\a.txt and D:\b.txt") can't be swallowed into
 * the first: its drive colon stops it. The separator is the one the path starts with, all the way
 * along, so prose after it that happens to hold a slash ("…\report.docx and web/src/App.tsx") isn't
 * read as more folders. No name starts with a space, so "saved to C:\out\ and see notes.txt" is not a
 * file called " and see notes.txt". The file name is the shortest run that ends in an extension and a
 * boundary.
 */
const DRIVE_PATH =
  /(?<![\p{L}\p{N}_])[A-Za-z]:([\\/])(?:[^\s\\/:*?"<>|\r\n`'][^\\/:*?"<>|\r\n`']*\1)*[^\s\\/:*?"<>|\r\n`'][^\\/:*?"<>|\r\n`']*?\.[A-Za-z0-9]{1,12}(?=$|[\s"'`,;)\]]|[.,;:!?](?:\s|$))/gu;

/**
 * Rule 3. The `(?<!:\/\/)` guard keeps it off the domain of an http(s):// URL (the URL provider,
 * registered first, keeps precedence there). The extension whitelist on a bare filename keeps prose
 * like "e.g." or "3.14" from lighting up; a path with a separator accepts any extension, since the
 * separator already says it is a path.
 */
const PLAIN_PATH =
  /(?<!:\/\/)(?:[A-Za-z]:)?[\\/]?(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+\.[A-Za-z0-9]{1,12}|(?<![\p{L}\p{N}_./\\-])[\p{L}\p{N}_-]+\.(?:md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|cs|java|kt|go|rs|rb|php|py|pyi|c|cc|cpp|h|hpp|swift|sql|sh|bash|zsh|ps1|psm1|bat|cmd|dockerfile|gradle|properties|lock|sln|csproj|props|targets)(?![\p{L}\p{N}_])/giu;

/** One path found in a line: where it starts (a string index) and the path as written. */
export interface FoundPath {
  index: number;
  text: string;
}

/** Every file path in `text`, left to right, none overlapping another. */
export function findFilePaths(text: string): FoundPath[] {
  const found: FoundPath[] = [];
  const overlaps = (a: FoundPath) =>
    found.some((b) => a.index < b.index + b.text.length && b.index < a.index + a.text.length);
  const take = (p: FoundPath) => {
    if (p.text.trim() && !overlaps(p)) found.push(p);
  };

  for (const m of text.matchAll(QUOTED_PATH)) {
    const inner = m[2];
    take({ index: (m.index ?? 0) + 1, text: inner });
  }
  for (const m of text.matchAll(DRIVE_PATH)) take({ index: m.index ?? 0, text: m[0] });
  for (const m of text.matchAll(PLAIN_PATH)) take({ index: m.index ?? 0, text: m[0] });

  return found.sort((a, b) => a.index - b.index);
}
