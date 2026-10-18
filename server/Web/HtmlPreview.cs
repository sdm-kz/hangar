using Hangar.Server.FileSystem;

namespace Hangar.Server.Web;

/// <summary>
/// The pieces of the ticketed HTML preview that aren't routing: what content type to serve a file
/// as, and the scroll bridge appended to the previewed document.
/// </summary>
public static class HtmlPreview
{
    /// <summary>
    /// Reserved path under a ticket, for the few things the preview serves that aren't files on
    /// disk. Checked before the path is resolved, so a real folder called <c>__cw</c> can't shadow
    /// it (and, the other way round, can't be reached through the preview — an acceptable trade for
    /// a name nothing uses).
    /// </summary>
    public const string ReservedPrefix = "__cw/";

    /// <summary>Where <see cref="ScrollBridge"/> is served, relative to the ticket root.</summary>
    public const string ScrollBridgePath = ReservedPrefix + "scroll-bridge.js";

    public static bool IsHtml(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is ".html" or ".htm";

    /// <summary>
    /// Whether a path resolved inside a ticket's root may actually be served. Applied on top of
    /// <see cref="SessionFileBrowser.ResolveSafe"/>, which answers a different and weaker question.
    /// </summary>
    /// <remarks>
    /// <para><b>Reparse points.</b> ResolveSafe is pure string arithmetic — <c>Path.GetFullPath</c>
    /// does not follow junctions or symlinks — so a link planted inside the root canonicalises to an
    /// in-root path, passes the prefix check, and then reads whatever it points at. <c>mklink /J</c>
    /// needs no elevation and a checkout with <c>core.symlinks=true</c> can lay one down, so this is
    /// reachable by anyone who can write the previewed folder, which is exactly the agent whose
    /// output is being previewed. Anywhere else in the app that would only hand a token holder what
    /// they could already read through <c>/api/fs/file</c>; here the credential belongs to the
    /// previewed page itself, so the same link turns a folder ticket into a whole-disk read. Links
    /// are refused outright rather than resolved-and-rechecked: a legitimate preview has no use for
    /// one, and refusing needs no second opinion about what the final target really was.</para>
    /// <para><b>Dotted and hidden entries.</b> A ticket covers the root and everything under it —
    /// it has to, or <c>./img/logo.png</c> would not load. But a page previewed at the top of a repo
    /// would then have unauthenticated read of <c>.git/config</c>, <c>.env</c> and
    /// <c>.claude/settings.json</c>, and it can <c>fetch()</c> them and post them anywhere. Skipping
    /// what the file tree already declines to show (see SessionFileBrowser's hidden/system filter)
    /// keeps the asset case working and takes the secrets out of reach.</para>
    /// </remarks>
    public static bool IsServable(string root, string full)
    {
        var stop = Path.GetFullPath(root);
        for (var at = full; !string.Equals(at, stop, StringComparison.OrdinalIgnoreCase);)
        {
            var name = Path.GetFileName(at);
            if (name.Length == 0) return false;         // walked past the root without meeting it
            if (name[0] == '.') return false;
            if (IsLinkOrHidden(at)) return false;

            var parent = Path.GetDirectoryName(at);
            if (string.IsNullOrEmpty(parent)) return false;
            at = parent;
        }
        return true;
    }

    // Deliberately treats an unreadable entry as unservable: the attribute read only fails for
    // something we are in no position to vouch for, and this is the one call standing between a
    // previewed page and the rest of the disk.
    private static bool IsLinkOrHidden(string path)
    {
        try
        {
            var a = File.GetAttributes(path);
            return a.HasFlag(FileAttributes.ReparsePoint)
                || a.HasFlag(FileAttributes.Hidden)
                || a.HasFlag(FileAttributes.System);
        }
        catch { return true; }
    }

    /// <summary>
    /// Content type for a file served into a preview. Deliberately NOT
    /// <see cref="SessionFileBrowser.ContentType"/>'s job: that one answers for
    /// <c>/api/sessions/{id}/fs/raw</c>, where HTML, CSS and JS falling through to
    /// <c>application/octet-stream</c> is the point — those bytes are served at this app's own
    /// origin with a bearer token in the URL, and a browser that rendered them there would be
    /// running a previewed page's script as us. Here the document is sandboxed into an opaque
    /// origin (see the CSP in Program.cs), so it is safe to say what things actually are — and
    /// necessary, since a stylesheet typed as octet-stream is simply ignored.
    /// </summary>
    /// <remarks>
    /// <para>The text types all carry <c>charset=utf-8</c>, which is a decision and not just a
    /// default: <b>previews are served as UTF-8, whatever the file says.</b> An HTTP charset
    /// outranks the document's own <c>&lt;meta charset&gt;</c>, so a correctly-declared
    /// windows-1251 page renders as mojibake here. That is the deliberate trade — everything this
    /// app writes is UTF-8, and a UTF-8 page that omits <c>&lt;meta charset&gt;</c> (which a
    /// hand-written one very often does) is the common case by a wide margin; left to the browser's
    /// guess it comes out as mojibake the moment it isn't ASCII.</para>
    /// <para>The exception is a document with a UTF-16 byte-order mark, which <see cref="IsUtf16"/>
    /// spots and the preview endpoint then serves verbatim — see there for why.</para>
    /// </remarks>
    public static string ContentType(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" or ".htm" => "text/html; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".js" or ".mjs" or ".cjs" => "text/javascript; charset=utf-8",
            ".json" or ".map" => "application/json; charset=utf-8",
            ".xml" => "application/xml; charset=utf-8",
            ".txt" or ".md" => "text/plain; charset=utf-8",
            ".csv" => "text/csv; charset=utf-8",
            ".woff" => "font/woff",
            ".woff2" => "font/woff2",
            ".ttf" => "font/ttf",
            ".otf" => "font/otf",
            ".eot" => "application/vnd.ms-fontobject",
            ".wasm" => "application/wasm",
            ".mp3" => "audio/mpeg",
            ".m4a" => "audio/mp4",
            ".wav" => "audio/wav",
            ".ogg" or ".oga" => "audio/ogg",
            // Images, video and PDF are already spelled out for the raw endpoint, and an unknown
            // extension lands on octet-stream there just as it should here.
            _ => SessionFileBrowser.ContentType(path),
        };

    /// <summary>
    /// Appended to a previewed HTML document. A trailing <c>&lt;script src&gt;</c> is all the
    /// injection this needs: the parser relocates it into the body, so the document itself is never
    /// rewritten. A page carrying its own script-blocking CSP won't run it and loses scroll memory;
    /// nothing else about the preview is affected.
    /// </summary>
    public static string ScrollBridgeTag(string ticket) =>
        $"\n<script src=\"/api/preview/{ticket}/{ScrollBridgePath}\"></script>\n";

    /// <summary>
    /// Whether a document opens with a UTF-16 byte-order mark. Such a file is left alone entirely —
    /// served as its own bytes, with no charset stamped on it and no scroll bridge appended.
    /// </summary>
    /// <remarks>
    /// Both of the things this preview normally does would wreck it, and neither failure is subtle.
    /// A BOM is the highest-priority signal in the HTML encoding sniffing algorithm, so a UTF-16
    /// page renders correctly in any browser on its own — until an HTTP <c>charset=utf-8</c>
    /// overrides the BOM, or ~70 ASCII bytes of script tag land on the end and get paired into
    /// UTF-16 code units, trailing a run of CJK gibberish after <c>&lt;/html&gt;</c>. Rare enough to
    /// be worth nothing more than stepping around.
    /// </remarks>
    public static bool IsUtf16(ReadOnlySpan<byte> start) =>
        start.Length >= 2
        && ((start[0] == 0xFF && start[1] == 0xFE) || (start[0] == 0xFE && start[1] == 0xFF));

    /// <summary>
    /// Scroll bridge for the sandboxed HTML preview. The frame runs without
    /// <c>allow-same-origin</c>, so its document has an opaque origin and nothing outside can read
    /// or set its scrollTop — the frame has to report its own position and be told where to go back
    /// to. It lives here, served as a file, rather than in the viewer that consumes it: the frame
    /// is loaded by URL now, so the client no longer holds the document's bytes and has nothing to
    /// append to.
    /// <para>The frame keeps quiet until it has been given a position: the scroll events a document
    /// fires while it is still laying out are all zero, and reporting those would erase the offset
    /// we are about to restore. And it does not scroll until the document has finished loading —
    /// images sized, webfonts swapped — because an offset only means the same thing in the layout it
    /// was written in, and a document reaches its full height long before it stops moving.</para>
    /// <para>And it stays quiet until somebody touches it. Restoring the offset is not the end of
    /// the page moving: images and webfonts above the viewport are still arriving, and as they size
    /// themselves the browser's scroll anchoring slides scrollTop to keep the same content in front
    /// of the reader — firing a scroll event that looks exactly like a person scrolling. Reported,
    /// it was saved as the new position, so every reload of a page with images came back a little
    /// further down than the last: 10800 became 10850, then 10900, drifting a few pixels a time and
    /// never settling. This is the one signal that separates the two, and it is the reason the
    /// preview only remembers where a <em>reader</em> left off.</para>
    /// <para>Every message names the document it came from (<c>cwPath</c>). The frame can navigate
    /// now — a link to a sibling page inside the ticket loads another document, served with another
    /// copy of this script — and the listener outside identifies the frame, not the document: a
    /// WindowProxy survives navigation, so <c>e.source</c> still matches. Without the path, the
    /// second page's scroll offset would be filed under the first page's name, and reopening the
    /// first would jump to an offset that belongs to something else.</para>
    /// </summary>
    public const string ScrollBridge = """
(function () {
  var w = window;
  if (w.parent === w) return;
  var want = null, deadline = 0, queued = 0;
  var here = w.location.pathname;
  // Whether a person has touched this document yet. Nothing is reported before they have, because
  // until then the only thing moving the page is the page itself finishing loading -- see below.
  var touched = false;
  ["wheel", "touchstart", "keydown", "pointerdown"].forEach(function (type) {
    w.addEventListener(type, function () { touched = true; }, { passive: true, capture: true });
  });
  var maxScroll = function () {
    var d = document.documentElement, b = document.body;
    return Math.max(0, Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0) - w.innerHeight);
  };
  var apply = function () {
    if (want === null) return;
    var max = maxScroll();
    if (max < want && Date.now() < deadline) { w.setTimeout(apply, 120); return; }
    w.scrollTo(0, Math.min(want, max));
    want = null;
  };
  // An offset only means the same thing in the same layout, so the restore waits for the layout it
  // was recorded in: every image sized, every webfont swapped in. "Tall enough to scroll there" is
  // not the same question and is true far too early -- the document reaches its full height while
  // the images above the fold are still blank boxes, and scrolling then lands on whatever text
  // happens to be at that pixel, which is not the text that was there when the offset was written.
  var whenLoaded = function (go) {
    var done = false;
    var once = function () { if (!done) { done = true; go(); } };
    var wait = [];
    if (document.readyState !== "complete")
      wait.push(new Promise(function (r) { w.addEventListener("load", r, { once: true }); }));
    // Fonts resize every line they touch, so a swap moves the page as surely as an image does.
    if (document.fonts && document.fonts.ready) wait.push(document.fonts.ready);
    Promise.all(wait).then(once, once);
    // A resource that never arrives must not hold the restore forever; late is better than never.
    w.setTimeout(once, 5000);
  };
  w.addEventListener("message", function (e) {
    if (!e.data || typeof e.data.cwScrollTo !== "number") return;
    want = e.data.cwScrollTo;
    whenLoaded(function () { deadline = Date.now() + 3000; apply(); });
  });
  w.addEventListener("scroll", function () {
    if (!touched) return;                // the page settling, not a person reading
    if (want !== null || queued) return; // still restoring, or a report is already pending
    queued = w.requestAnimationFrame(function () {
      queued = 0;
      w.parent.postMessage({ cwScroll: w.scrollY || 0, cwPath: here }, "*");
    });
  }, { passive: true });
  var ready = function () { w.parent.postMessage({ cwScrollReady: true, cwPath: here }, "*"); };
  // Twice: the frame can finish parsing before the listener out there is attached, and once more
  // after load costs nothing — a second ready for a document already placed is ignored.
  ready();
  w.addEventListener("load", ready);
})();
""";
}
