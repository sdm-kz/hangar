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
  yaml: "yaml",
  yml: "yaml",
};

/** Returns the highlight.js language for a filename, or null if unsupported. */
export function highlightLanguage(name: string): string | null {
  return EXT_LANG[fileExt(name)] ?? null;
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
