// Runs in the session's folder. Input on stdin: { params, secrets, context }. Output: the data, as JSON.
import { execFileSync } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { params } = JSON.parse(raw);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Not a repo: git prints why on stderr and exits non-zero, and Hangar shows that as the widget's error.
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const log = git("log", `-${params.count}`, "--pretty=format:%h%x1f%an%x1f%ar%x1f%s");
const commits = log
  ? log.split("\n").map((line) => {
      const [hash, author, when, subject] = line.split("\x1f");
      return { hash, author, when, subject };
    })
  : [];

process.stdout.write(JSON.stringify({ branch, commits }));
