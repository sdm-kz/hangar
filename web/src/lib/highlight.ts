// Syntax highlighting for the file preview. We use highlight.js' core build and
// register only the languages we care about, keeping the bundle small.
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import csharp from "highlight.js/lib/languages/csharp";
import powershell from "highlight.js/lib/languages/powershell";
import dos from "highlight.js/lib/languages/dos";
import sql from "highlight.js/lib/languages/sql";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import less from "highlight.js/lib/languages/less";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import swift from "highlight.js/lib/languages/swift";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import objectivec from "highlight.js/lib/languages/objectivec";
import scala from "highlight.js/lib/languages/scala";
import dart from "highlight.js/lib/languages/dart";
import lua from "highlight.js/lib/languages/lua";
import perl from "highlight.js/lib/languages/perl";
import r from "highlight.js/lib/languages/r";
import elixir from "highlight.js/lib/languages/elixir";
import haskell from "highlight.js/lib/languages/haskell";
import markdown from "highlight.js/lib/languages/markdown";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";
import { fileExt } from "./fileKind";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("less", less);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("objectivec", objectivec);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("r", r);
hljs.registerLanguage("elixir", elixir);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("makefile", makefile);

// Map file extensions to registered highlight.js language names.
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  cs: "csharp",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "dos",
  cmd: "dos",
  sql: "sql",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  xml: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  nuspec: "xml",
  html: "xml",
  htm: "xml",
  cshtml: "xml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  pyw: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  gemfile: "ruby",
  rake: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  m: "objectivec",
  mm: "objectivec",
  scala: "scala",
  sc: "scala",
  dart: "dart",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  md: "markdown",
  markdown: "markdown",
  ini: "ini",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
};

// Well-known extensionless filenames (fileExt returns "" for these).
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** Returns the highlight.js language for a filename, or null if unsupported. */
export function highlightLanguage(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  return NAME_LANG[base] ?? EXT_LANG[fileExt(name)] ?? null;
}

/** Highlights code for the given filename. Returns HTML, or null if the language is unsupported. */
export function highlightCode(name: string, code: string): string | null {
  const lang = highlightLanguage(name);
  if (!lang) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** A run of characters in one line of code, with the highlight classes that apply to it. */
export interface CodeToken {
  text: string;
  /** highlight.js classes, outermost first — nested, because the theme has rules like
   *  `.hljs-meta .hljs-string` that only match a token sitting inside another. */
  classes: string[];
}

/** The five entities highlight.js produces when it escapes the code it was given. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function decode(text: string): string {
  return text.includes("&") ? text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENTITIES[e] ?? e) : text;
}

/**
 * The same highlighting, as tokens, one array per line — for anything that draws a file a line at a
 * time rather than as one block: a diff, or a listing with numbers down the side.
 *
 * Highlighting each line on its own would be the obvious way and is wrong: a block comment, a
 * multi-line string or a heredoc means nothing to a parser shown only one line of it, so every line
 * after the one that opens it comes back as code. So the whole text is highlighted once and the
 * result is cut up, carrying the classes open at the end of one line into the start of the next.
 *
 * Tokens rather than the HTML highlight.js hands back, even though the HTML would be less work: the
 * code highlighted here comes from whoever opened the pull request, and tokens go through React as
 * text, which escapes them. There is no HTML string anywhere on the path, so there is no question of
 * whether something along it forgot to escape.
 *
 * Null when the language is unknown, which is the caller's cue to draw plain text.
 */
export function highlightLines(name: string, code: string): CodeToken[][] | null {
  const html = highlightCode(name, code);
  if (html === null) return null;

  const lines: CodeToken[][] = [];
  let line: CodeToken[] = [];
  // The classes in effect, outermost first. highlight.js emits only <span> and </span>, so a stack
  // of class names is the whole of the state a line boundary has to carry.
  const classes: string[] = [];

  const take = (raw: string) => {
    // A newline inside a run ends the line; the classes stay, which is what carries a block comment
    // across into the lines below it.
    const parts = decode(raw).split("\n");
    parts.forEach((part, n) => {
      if (n > 0) {
        lines.push(line);
        line = [];
      }
      if (part) line.push({ text: part, classes: [...classes] });
    });
  };

  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        take(html.slice(i)); // malformed tail — keep it as text rather than lose it
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) classes.pop();
      else classes.push(/class="([^"]*)"/.exec(tag)?.[1] ?? "");
      i = end + 1;
    } else {
      const next = html.indexOf("<", i);
      const stop = next === -1 ? html.length : next;
      take(html.slice(i, stop));
      i = stop;
    }
  }
  lines.push(line);
  return lines;
}
