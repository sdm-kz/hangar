import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLink } from "@/types";
import { linkHost, linkTabLabel } from "@/lib/sessionLinks";
import { writeToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LinkIcon } from "./LinkIcon";
import { Check, Copy, Loader2, Pencil, RotateCw, SquareArrowOutUpRight } from "lucide-react";

// How long a frame is given before the pane offers a way out. A page that has not painted by now is
// usually one the browser is quietly refusing to draw, and the whole failure mode of this feature is
// a rectangle that says nothing about why it is empty.
const SLOW_MS = 6000;

/**
 * A web page pinned to a session, filling the pane.
 *
 * What the page can be depends on the site, not on us. A page that allows framing is shown here; a
 * page that does not — most of the SaaS worth linking to, Jira and GitHub included — cannot be shown
 * by any means a browser permits, so the pane becomes a card with the page's identity and the way
 * out. Either way the toolbar keeps "open in a browser tab" one click away, because a frame that
 * comes up wrong (a login the site declines to render in a frame, a third-party cookie the browser
 * dropped) looks exactly like one that is still loading.
 */
export function WebLinkView({ link, onEdit }: { link: SessionLink; onEdit: () => void }) {
  // Bumped to remount the frame, which is what reloading a cross-origin page amounts to: its
  // location is not ours to touch.
  const [reloadToken, setReloadToken] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setLoaded(false);
    setSlow(false);
  }, [link.url, link.embed, reloadToken]);

  useEffect(() => {
    if (loaded || !link.embed) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [loaded, link.embed, link.url, reloadToken]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const open = useCallback(() => {
    // noopener/noreferrer: the page is being handed a window, and it has no business reaching back
    // into this one through window.opener.
    window.open(link.url, "_blank", "noopener,noreferrer");
  }, [link.url]);

  const copy = useCallback(() => {
    void writeToClipboard(link.url);
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [link.url]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar. The address is shown in full because a framed page has no address bar of its own —
          there is otherwise nothing on screen saying where you are. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <LinkIcon src={link.icon} className="size-4 shrink-0 rounded-[2px]" />
        <span className="shrink-0 truncate text-sm font-medium">{linkTabLabel(link)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={link.url}>
          {link.url}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton onClick={copy} title="Copy the address">
            {copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-500" /> : <Copy className="size-3.5" />}
          </ToolbarButton>
          {link.embed && (
            <ToolbarButton onClick={() => setReloadToken((t) => t + 1)} title="Reload the page">
              <RotateCw className="size-3.5" />
            </ToolbarButton>
          )}
          <ToolbarButton onClick={onEdit} title="Edit this link">
            <Pencil className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton onClick={open} title="Open in a browser tab">
            <SquareArrowOutUpRight className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>

      {link.embed ? (
        <div className="relative min-h-0 flex-1">
          <iframe
            key={`${link.url}#${reloadToken}`}
            src={link.url}
            title={linkTabLabel(link)}
            onLoad={() => setLoaded(true)}
            referrerPolicy="no-referrer-when-downgrade"
            // allow-same-origin keeps the page's own cookies and storage, without which anything
            // that needs you signed in is useless. What the sandbox is actually here for is what it
            // leaves out: with no allow-top-navigation, a framed page cannot navigate this app away
            // from under itself.
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-storage-access-by-user-activation"
            allow="clipboard-write; fullscreen"
            className="size-full border-0 bg-white"
          />
          {!loaded && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading {linkHost(link.url)}…
              </span>
            </div>
          )}
          {slow && (
            // Sits over the frame rather than replacing it: the page may yet paint, and taking it
            // down to say so would throw away whatever progress it had made.
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-background/95 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
              <span className="min-w-0 flex-1">
                Nothing has appeared. {linkHost(link.url)} may be refusing to be shown inside another
                page, or waiting on a sign-in it will only do in a tab of its own.
              </span>
              <Button size="sm" variant="outline" onClick={open}>
                <SquareArrowOutUpRight className="size-3.5" /> Open in a browser tab
              </Button>
            </div>
          )}
        </div>
      ) : (
        <BookmarkCard link={link} onOpen={open} />
      )}
    </div>
  );
}

/**
 * The pane for a link that is not shown here — either because the site refuses to be framed, or
 * because the user asked for it to open outside. It is still this session's link, so the card names
 * the page, says why it is a card and not a page, and gets out of the way in one click.
 */
function BookmarkCard({ link, onOpen }: { link: SessionLink; onOpen: () => void }) {
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => openRef.current?.focus(), [link.id]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <LinkIcon src={link.icon} className="size-10 rounded" />
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-lg font-semibold">{linkTabLabel(link)}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{link.url}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          {link.blockedBy ? (
            <>
              {linkHost(link.url)} does not allow itself to be shown inside another page
              <span className="block font-mono text-xs">({link.blockedBy})</span>
            </>
          ) : (
            <>This link is set to open outside the app.</>
          )}
        </p>
        <Button ref={openRef} onClick={onOpen}>
          <SquareArrowOutUpRight className="size-4" /> Open {linkHost(link.url)}
        </Button>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn("rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {children}
    </button>
  );
}
