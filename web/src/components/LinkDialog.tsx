import { useEffect, useRef, useState } from "react";
import type { LinkProbe, SessionLink } from "@/types";
import { api } from "@/lib/api";
import { defaultLinkTitle, linkHost, MAX_LINKS, normalizeLinkUrl, suggestLinkTitle } from "@/lib/sessionLinks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkIcon } from "./LinkIcon";
import { AlertTriangle, Globe, Loader2, SquareArrowOutUpRight } from "lucide-react";

// How long after the last keystroke the URL is looked at. Long enough that typing a URL out by hand
// doesn't fire a request per character, short enough that a paste feels immediate.
const PROBE_DEBOUNCE_MS = 500;

/**
 * Add a web page to a session's tab bar, or edit one already there.
 *
 * While the URL is being typed the server is asked what is at the other end (see api.probeLink):
 * its title, so the tab names itself, and — the part that decides how this feature behaves at all —
 * whether the page allows itself to be shown in a frame. Sites that matter here often do not: Jira,
 * Confluence, GitHub and Google all send `X-Frame-Options` or a CSP `frame-ancestors` that shuts a
 * third-party frame out, and a browser obeys that by rendering nothing, with no error anyone can
 * catch. Finding out before the tab exists is what lets it say so plainly and open in a browser tab
 * instead, rather than presenting a blank rectangle.
 */
export function LinkDialog({
  edit,
  full,
  onSave,
  onClose,
}: {
  /** The link being edited, or undefined when adding a new one. */
  edit?: SessionLink;
  /** The session already holds as many links as it can. Only ever true when adding. */
  full?: boolean;
  onSave: (link: Omit<SessionLink, "id">) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(edit?.url ?? "");
  const [title, setTitle] = useState(edit?.title ?? "");
  const [embed, setEmbed] = useState(edit?.embed ?? true);
  const [probe, setProbe] = useState<LinkProbe | null>(null);
  const [probing, setProbing] = useState(false);
  // The title/embed choice stops following the probe once the user has set either by hand — the
  // page's own answer is a suggestion, and re-imposing it over an edit would be maddening.
  const titleTouched = useRef(!!edit);
  const embedTouched = useRef(!!edit);

  const normalized = normalizeLinkUrl(url);

  // Ask the server about the URL, on a debounce, and abandon the answer if the URL moved on. Kept
  // out of the submit path deliberately: what this returns changes what the dialog OFFERS, so it
  // has to have landed before the button is pressed.
  useEffect(() => {
    if (!normalized) {
      setProbe(null);
      setProbing(false);
      return;
    }
    let cancelled = false;
    setProbing(true);
    const t = window.setTimeout(() => {
      void api
        .probeLink(normalized)
        .then((res) => {
          if (cancelled) return;
          setProbe(res);
          if (!titleTouched.current) setTitle(suggestLinkTitle(res.url || normalized, res.title));
          // A page that refuses framing gets the browser-tab treatment by default. A page we could
          // not reach at all (embeddable null) is given the benefit of the doubt — the frame is the
          // point of the feature, and it may simply be behind a VPN this machine isn't on.
          if (!embedTouched.current) setEmbed(res.embeddable !== false);
        })
        .catch(() => !cancelled && setProbe(null))
        .finally(() => !cancelled && setProbing(false));
    }, PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [normalized]);

  function save() {
    if (!normalized) return;
    // The probe's URL is the one after redirects, which is what the frame should point at — a
    // shortener or an http→https bounce would otherwise reload on every open.
    const finalUrl = probe?.url && !probe.error ? probe.url : normalized;
    onSave({
      url: finalUrl,
      title: title.trim() || defaultLinkTitle(finalUrl),
      icon: probe?.icon ?? edit?.icon ?? undefined,
      embed,
      blockedBy: probe?.blockedBy ?? undefined,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="size-4" /> {edit ? "Edit web page" : "Link a web page"}
          </DialogTitle>
          <DialogDescription>
            Pins a page to this session as a tab — the issue it works from, the doc it follows. It
            shows up on every device looking at the session.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="space-y-2">
            <Label htmlFor="link-url">Address</Label>
            <Input
              id="link-url"
              value={url}
              autoFocus
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="jira.example.com/browse/AB-123"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="link-title">Name</Label>
            <Input
              id="link-title"
              value={title}
              onChange={(e) => {
                titleTouched.current = true;
                setTitle(e.target.value);
              }}
              placeholder={normalized ? defaultLinkTitle(normalized) : "Taken from the page"}
            />
          </div>

          <ProbeSummary url={normalized} probing={probing} probe={probe} icon={edit?.icon} />

          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={embed}
              onCheckedChange={(v) => {
                embedTouched.current = true;
                setEmbed(v === true);
              }}
              className="mt-0.5"
            />
            <span className="min-w-0 text-sm">
              Show the page in the tab
              <span className="block text-xs text-muted-foreground">
                Off, the tab is a bookmark: clicking it opens the page in a browser tab instead.
              </span>
            </span>
          </label>

          {full && (
            <p className="text-sm text-destructive">
              This session already has {MAX_LINKS} linked pages — close one of its tabs to make room.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!normalized || full}>
              {edit ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the server found at the URL: the page's identity, and the verdict on framing. The verdict is
 * the reason this panel exists — it is the one thing about the link a person cannot check for
 * themselves by looking at the address.
 */
function ProbeSummary({
  url,
  probing,
  probe,
  icon,
}: {
  url: string | null;
  probing: boolean;
  probe: LinkProbe | null;
  icon?: string;
}) {
  if (!url)
    return (
      <p className="text-xs text-muted-foreground">
        An http or https address. The scheme can be left off.
      </p>
    );

  if (probing && !probe)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Looking at {linkHost(url)}…
      </p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <LinkIcon src={probe?.icon ?? icon} className="size-4 shrink-0" />
        <span className="truncate font-mono text-muted-foreground" title={probe?.url ?? url}>
          {probe?.url ?? url}
        </span>
      </div>

      {probe?.error ? (
        <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            {probe.error} The link still works — it just could not be checked from the server, so
            whether it shows in the tab will only be clear once it is open.
          </span>
        </p>
      ) : probe?.embeddable === false ? (
        <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-500">
          <SquareArrowOutUpRight className="mt-px size-3.5 shrink-0" />
          <span>
            This site refuses to be shown inside another page
            {probe.blockedBy && <span className="font-mono"> ({probe.blockedBy})</span>}, so the tab
            opens it in a browser tab instead.
          </span>
        </p>
      ) : probe?.embeddable ? (
        <p className="text-muted-foreground">
          This page allows framing, so the tab can show it here.
          {" "}Pages that need you signed in may still ask again — a frame is a different context as
          far as the browser's cookie rules are concerned.
        </p>
      ) : null}
    </div>
  );
}
