import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type RefObject,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent, Root, RootContent } from "hast";
import { Loader2, TableOfContents, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTheme, subscribeTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Shared markdown renderer for file previews (FileBrowser + ServerFileViewer): GFM plus inline
 * rendering of ```mermaid fenced blocks as diagrams. Failed diagrams fall back to the source
 * code block with the parser error underneath.
 *
 * Headings get GitHub-style id slugs and clicking one puts `#slug` in the URL, so a section can
 * be deep-linked and survives a reload: on mount this component scrolls to the section named by
 * the current hash.
 */
export function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Restore the section named by the URL hash once the content is in the DOM. The layout keeps
  // shifting for a bit after that (mermaid diagrams and images pop in above the target), so
  // re-anchor a few times — unless the user starts scrolling themselves, which cancels the rest.
  useEffect(() => {
    const raw = window.location.hash.slice(1);
    if (!raw) return;
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const events = ["wheel", "touchmove", "keydown", "mousedown"] as const;
    events.forEach((ev) => window.addEventListener(ev, cancel, { passive: true }));
    const timers = [0, 250, 800, 2000].map((ms) =>
      window.setTimeout(() => {
        if (cancelled) return;
        ref.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView();
      }, ms)
    );
    return () => {
      timers.forEach(clearTimeout);
      events.forEach((ev) => window.removeEventListener(ev, cancel));
    };
  }, [text]);

  return (
    <div ref={ref}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHeadingIds]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

type TocEntry = { id: string; label: string; level: number; el: HTMLElement };

// Whether the TOC panel is open; a preference, so it sticks across files and reloads.
const TOC_OPEN_KEY = "claudeweb.mdTocOpen";

/**
 * Floating table-of-contents overlay for a rendered-markdown preview. Position it inside a
 * `relative` ancestor; `containerRef` is the scrollable element holding the `<Markdown>` output.
 * It scans the rendered headings (which already carry their slug ids), so its entries always match
 * what deep links address. Clicking an entry anchors the URL hash and scrolls to the section;
 * while scrolling, the section currently at the top of the view is highlighted.
 */
export function MarkdownToc({
  containerRef,
  text,
  className,
}: {
  containerRef: RefObject<HTMLElement | null>;
  /** The markdown source — only used as a signal to rescan when the document changes. */
  text: string;
  className?: string;
}) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(TOC_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(TOC_OPEN_KEY, o ? "0" : "1");
      } catch {
        /* preference only */
      }
      return !o;
    });
  };

  // Collect the rendered headings once the markdown is in the DOM (they render synchronously,
  // unlike mermaid diagrams, so one pass after each text change is enough).
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const heads = Array.from(
      root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")
    );
    setEntries(
      heads.map((el) => {
        // The visible text minus the trailing "#" self-link the headings carry.
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelector('a[title="Link to this section"]')?.remove();
        return {
          id: el.id,
          label: clone.textContent?.trim() || el.id,
          level: Number(el.tagName[1]),
          el,
        };
      })
    );
  }, [containerRef, text]);

  // Scroll spy: the active section is the last heading at or above the top of the container
  // (with a little slack so a just-anchored heading counts as its own section).
  useEffect(() => {
    const root = containerRef.current;
    if (!root || entries.length === 0) {
      setActiveId(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = root.getBoundingClientRect().top + 24;
      let current = entries[0].id;
      for (const e of entries) {
        if (e.el.getBoundingClientRect().top <= top) current = e.id;
        else break;
      }
      setActiveId(current);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    // Late layout shifts (mermaid diagrams, images, zoom changes) move the headings without a
    // scroll event — watch the content's size so the highlight stays honest.
    const ro = new ResizeObserver(schedule);
    if (root.firstElementChild) ro.observe(root.firstElementChild);
    return () => {
      root.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [containerRef, entries]);

  // Keep the highlighted entry visible inside the (scrollable) panel as reading progresses.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  if (entries.length === 0) return null;
  const minLevel = Math.min(...entries.map((e) => e.level));

  return (
    <div className={cn("absolute right-3 top-3 z-10 flex flex-col items-end", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 rounded-md border bg-background/90 shadow-sm backdrop-blur"
        title={open ? "Hide table of contents" : "Table of contents"}
        onClick={toggle}
      >
        {open ? <X className="size-4" /> : <TableOfContents className="size-4" />}
      </Button>
      {open && (
        <nav
          ref={listRef}
          className="mt-2 max-h-[min(24rem,60vh)] w-60 max-w-[70vw] overflow-y-auto rounded-md border bg-background/95 py-1 shadow-md backdrop-blur"
        >
          {entries.map((e) => (
            <button
              key={e.id}
              data-active={e.id === activeId || undefined}
              title={e.label}
              onClick={() => anchorTo(e.id, e.el)}
              className={cn(
                "block w-full truncate px-2.5 py-1 text-left text-xs hover:bg-accent",
                e.id === activeId ? "bg-accent font-medium text-foreground" : "text-muted-foreground"
              )}
              style={{ paddingLeft: `${0.625 + (e.level - minLevel) * 0.75}rem` }}
            >
              {e.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** GitHub-flavoured slug for a heading: lowercase, punctuation stripped, spaces → hyphens. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

// rehype plugin: give every h1–h6 an id slug derived from its text, deduped GitHub-style with
// -1, -2, … suffixes, so the URL hash and in-document #links can address sections.
function rehypeHeadingIds() {
  return (tree: Root) => {
    const used = new Map<string, number>();
    const visit = (node: Root | RootContent) => {
      if (node.type !== "root" && node.type !== "element") return;
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName)) {
        const base = slugify(hastText(node)) || "section";
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        node.properties = { ...node.properties, id: n === 0 ? base : `${base}-${n}` };
      }
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

/** Put `#id` in the URL without a history entry, and scroll the section into view. */
// globalThis.Element: the DOM type — the bare name is shadowed by hast's Element import above.
function anchorTo(id: string, heading: globalThis.Element | null) {
  window.history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  heading?.scrollIntoView();
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function heading(Tag: HeadingTag) {
  return function Heading({ node, children, ...props }: ComponentProps<HeadingTag> & ExtraProps) {
    const id = typeof node?.properties?.id === "string" ? node.properties.id : undefined;
    const onClick = (e: MouseEvent<HTMLElement>) => {
      if (!id) return;
      if ((e.target as HTMLElement).closest("a")) return; // let real links inside headings be links
      if (!window.getSelection()?.isCollapsed) return; // don't hijack a text selection
      anchorTo(id, e.currentTarget);
    };
    return (
      <Tag {...props} id={id} className="group scroll-mt-4" onClick={onClick}>
        {children}
        {id && (
          <a
            href={`#${encodeURIComponent(id)}`}
            title="Link to this section"
            className="ml-2 font-normal text-muted-foreground no-underline opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              anchorTo(id, e.currentTarget.closest("h1,h2,h3,h4,h5,h6"));
            }}
          >
            #
          </a>
        )}
      </Tag>
    );
  };
}

const components: Components = {
  pre({ node, children, ...props }) {
    const code = mermaidSource(node);
    if (code !== null) return <MermaidDiagram code={code} />;
    return <pre {...props}>{children}</pre>;
  },
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
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
