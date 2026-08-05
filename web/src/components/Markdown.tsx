import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { Loader2 } from "lucide-react";
import { getTheme, subscribeTheme } from "@/lib/theme";

/**
 * Shared markdown renderer for file previews (FileBrowser + ServerFileViewer): GFM plus inline
 * rendering of ```mermaid fenced blocks as diagrams. Failed diagrams fall back to the source
 * code block with the parser error underneath.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

const components: Components = {
  pre({ node, children, ...props }) {
    const code = mermaidSource(node);
    if (code !== null) return <MermaidDiagram code={code} />;
    return <pre {...props}>{children}</pre>;
  },
};

/** If this <pre> wraps a ```mermaid fence, return the fence's source text; otherwise null. */
function mermaidSource(node: Element | undefined): string | null {
  const child = node?.children?.[0];
  if (!child || child.type !== "element" || child.tagName !== "code") return null;
  const cls = child.properties?.className;
  const classes = Array.isArray(cls) ? cls : [cls];
  if (!classes.includes("language-mermaid")) return null;
  return hastText(child);
}

function hastText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(hastText).join("");
  return "";
}

// Monotonic ids because mermaid.render requires a unique element id per call.
let mermaidSeq = 0;

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(getTheme());

  useEffect(() => subscribeTheme(setTheme), []);

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      const id = `mermaid-${++mermaidSeq}`;
      try {
        // Dynamic import keeps mermaid (~1.5 MB) out of the main bundle until a diagram appears.
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        // Validate first: parse() throws without side effects, whereas a failed render() leaves
        // its error "bomb" SVG appended to document.body.
        await mermaid.parse(code);
        const { svg } = await mermaid.render(id, code);
        if (alive) setSvg(svg);
      } catch (e) {
        // A failed render can still orphan its temp/error elements — drop them.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (alive) {
          setSvg(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, theme]);

  if (error) {
    return (
      <div>
        <pre>
          <code>{code}</code>
        </pre>
        <p className="text-xs text-destructive">Mermaid: {error}</p>
      </div>
    );
  }
  if (svg === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Rendering diagram…
      </div>
    );
  }
  // Safe to inject: mermaid at securityLevel "strict" sanitizes labels/links with its bundled
  // DOMPurify before emitting this SVG (same trust model as the highlight.js output elsewhere).
  return (
    <div
      className="my-4 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
