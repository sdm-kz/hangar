// The SPA talks to more than one node (plans/multi-node.md): a session's whole view sits inside a
// <NodeProvider>, and everything in it asks useApi() for its client, so a peer's session is served by
// that peer. A component that imports `api` — this node's client — straight from lib/api would quietly
// talk to the wrong machine the moment it is shown for a peer, and nothing else would notice. So that
// import is refused everywhere but in the files listed here, which are about this node and only this
// node: the app shell and its sidebar, signing in, updating, pairing.
//
// Run by `npm run build` (and so by scripts\build.ps1 and the deploy scripts); the web project has no
// linter for this to live in.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src", import.meta.url));
const API = join(src, "lib", "api");

// Allowed to use this node's `api` directly. Keep it short: adding a file here is a statement that it
// is never shown for another node's session.
const THIS_NODE_ONLY = new Set([
  "App.tsx", // picks the node itself: this one's api for its own, apiFor(node) for a peer's
  "components/Login.tsx",
  "components/NodesDialog.tsx",
  "components/ThemeDialog.tsx", // the themes are this page's own, from the node that served it
  "components/PreviewApp.tsx", // the standalone preview tab reads this machine's disk; never offered for a peer's file
  "lib/migrateRecents.ts",
  "lib/node.tsx", // where useApi() gets the client of the node it is told
  "lib/nodeStream.ts", // follows the node it is told
  "lib/push.ts",
]);

// The URL helpers are this node's too; inside a node's view they are methods of its client. apiFor and
// the token are how a view would pick a node — or this one — behind its NodeProvider's back.
const THIS_NODE_NAMES = new Set([
  "api",
  "apiFor",
  "getToken",
  "sessionFileUrl",
  "serverFileUrl",
  "remoteFileUrl",
  "previewFrameUrl",
  "sessionsStreamUrl",
]);

// Every static import or re-export (`import … from`, `export … from`), and every dynamic import().
const STATIC = /\b(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
// A request built by hand: it goes to whatever origin the page is on, which is always this node.
const RAW = /\b(?:fetch|new\s+WebSocket|new\s+EventSource)\s*\(\s*[`"']\//g;

const isApi = (file, spec) => {
  const target = spec.startsWith("@/") ? join(src, spec.slice(2)) : spec.startsWith(".") ? join(dirname(file), spec) : null;
  return target !== null && target.replace(/\.tsx?$/, "") === API;
};
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name)) {
      const rel = relative(src, full).split(sep).join("/");
      if (rel === "lib/api.ts" || THIS_NODE_ONLY.has(rel)) continue;
      const text = stripComments(readFileSync(full, "utf8"));
      for (const m of text.matchAll(STATIC)) {
        if (m[1] || !isApi(full, m[3])) continue; // types carry no node
        const clause = m[2];
        if (clause.includes("*")) {
          bad.push(`${rel}: imports all of lib/api — import what it needs, and get the client from useApi() (lib/node.tsx)`);
          continue;
        }
        const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
        const names = named
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith("type "))
          .map((n) => n.split(/\s+as\s+/)[0].trim());
        const wrong = names.filter((n) => THIS_NODE_NAMES.has(n));
        if (wrong.length) bad.push(`${rel}: imports ${wrong.join(", ")} from lib/api — use useApi() (lib/node.tsx)`);
      }
      for (const m of text.matchAll(DYNAMIC))
        if (isApi(full, m[1])) bad.push(`${rel}: imports lib/api dynamically — use useApi() (lib/node.tsx)`);
      if (RAW.test(text)) bad.push(`${rel}: builds a request to "/…" by hand — that is always this node; use useApi()`);
      RAW.lastIndex = 0;
    }
  }
};
walk(src);

if (bad.length) {
  console.error("Node scope check failed: these files would talk to this node whatever node they are shown for.");
  for (const line of bad) console.error("  " + line);
  console.error("If a file really is only ever about this node, add it to THIS_NODE_ONLY in web/scripts/check-node-scope.mjs.");
  process.exit(1);
}
