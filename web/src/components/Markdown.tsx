import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type RefObject,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { PluggableList } from "unified";
import { Loader2 } from "lucide-react";
import { getTheme, subscribeTheme } from "@/lib/theme";
import { mdAssetUrl } from "@/lib/mdAssets";
import { useApi } from "@/lib/node";
import { useHtml } from "@/lib/useHtml";
import { TocPanel, type TocItem } from "./TocPanel";

/**
 * Shared markdown renderer for file previews (FileBrowser + ServerFileViewer): GFM plus inline
 * rendering of ```mermaid fenced blocks as diagrams. Failed diagrams fall back to the source
 * code block with the parser error underneath.
 *
 * Headings get GitHub-style id slugs and clicking one puts `#slug` in the URL, so a section can
 * be deep-linked and survives a reload: on mount this component scrolls to the section named by
 * the current hash.
 *
 * Pass `docPath` (the document's absolute path on the server) to make its own images render —
 * without it, a relative `![](img/x.png)` resolves against the app's URL and 404s.
 */
// GitHub's sanitize schema minus the `user-content-` id clamp: documents place explicit
// `<a id="…"></a>` anchors and link to them as `[§2.4](#s-2-4)`, so ids must survive verbatim
// for those in-document links to resolve. Previews show the user's own local files, so DOM
// clobbering via ids is not a concern here.
const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id"],
  },
};

export function Markdown({
  text,
  docPath,
  assetUrl,
}: {
  text: string;
  docPath?: string;
  /** Where a file the document references is fetched from; the file API of the view's node by default. */
  assetUrl?: (path: string) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const api = useApi();
  const toUrl = assetUrl ?? api.serverFileUrl;

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

  // Make the browser back/forward buttons work across in-document link jumps. A click on a
  // `#hash` link is a native history push, but the content scrolls inside an inner container,
  // which the browser doesn't restore on Back — so before the click navigates, stash the
  // container's position on the entry being left, and on popstate either restore that exact
  // position (Back) or scroll to the hash target (Forward / no saved position).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: globalThis.MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.('a[href^="#"]');
      if (!a || !root.contains(a)) return;
      const sp = scrollParentOf(root);
      window.history.replaceState({ mdScroll: sp.scrollTop }, "", window.location.href);
    };
    const onPop = (e: PopStateEvent) => {
      const saved = (e.state as { mdScroll?: unknown } | null)?.mdScroll;
      if (typeof saved === "number") {
        scrollParentOf(root).scrollTop = saved;
        return;
      }
      const raw = window.location.hash.slice(1);
      if (!raw) return;
      try {
        root.querySelector(`#${CSS.escape(decodeURIComponent(raw))}`)?.scrollIntoView();
      } catch {
        /* malformed hash */
      }
    };
    root.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => {
      root.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPop);
    };
  }, [text]);

  // Order matters: parse raw HTML first (so its <img> tags are elements too), point image sources
  // at the file API, then sanitize, then add heading ids (after sanitize so they aren't stripped).
  const rehypePlugins = useMemo(
    () =>
      [
        rehypeRaw,
        [rehypeAssetUrls, { docPath, assetUrl: toUrl }],
        [rehypeSanitize, sanitizeSchema],
        rehypeHeadingIds,
      ] as PluggableList,
    [docPath, toUrl]
  );

  return (
    <div ref={ref}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Whether the TOC panel is open; a preference, so it sticks across files and reloads.
const TOC_OPEN_KEY = "hangar.mdTocOpen";

/**
 * Table of contents for a rendered-markdown preview. It scans the rendered headings (which already
 * carry their slug ids), so its entries always match what deep links address; clicking one anchors
 * the URL hash and scrolls to the section. The panel itself is {@link TocPanel}.
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
  const [entries, setEntries] = useState<TocItem[]>([]);

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

  return (
    <TocPanel
      containerRef={containerRef}
      entries={entries}
      onSelect={(e) => anchorTo(e.id, e.el)}
      storageKey={TOC_OPEN_KEY}
      className={className}
    />
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

/**
 * rehype plugin: rewrite the document's own images (a relative or local-absolute src) to the raw
 * file API, so they load from the server's disk instead of 404-ing against the app's own URL.
 *
 * Runs *before* rehype-sanitize on purpose: a Windows absolute src ("G:\pics\x.png") looks like an
 * unknown URL protocol to the sanitizer, which would strip it before we ever got to see it. What
 * this produces is a same-origin relative URL, which sanitize is happy with.
 */
function rehypeAssetUrls({ docPath, assetUrl }: { docPath?: string; assetUrl: (path: string) => string }) {
  return (tree: Root) => {
    if (!docPath) return;
    const visit = (node: Root | RootContent) => {
      if (node.type !== "root" && node.type !== "element") return;
      if (node.type === "element" && node.tagName === "img") {
        const src = node.properties?.src;
        if (typeof src === "string") {
          const url = mdAssetUrl(src, docPath, assetUrl);
          if (url) node.properties = { ...node.properties, src: url };
        }
      }
      node.children.forEach(visit);
    };
    visit(tree);
  };
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

/** The nearest scrollable ancestor — the container the preview's content actually scrolls in. */
function scrollParentOf(el: HTMLElement): globalThis.Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return document.scrollingElement ?? document.documentElement;
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
  const html = useHtml(svg ?? ""); // the diagram is only rendered once svg is non-null

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
  // Injected through useHtml so a re-render doesn't re-parse the whole diagram.
  return (
    <div
      className="my-4 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={html}
    />
  );
}
