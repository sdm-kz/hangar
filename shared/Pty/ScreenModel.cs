using System.Text;

namespace ClaudeWeb.Pty;

/// <summary>
/// A terminal, as far as the bytes are concerned: it consumes the child's VT output and keeps the
/// screen those bytes describe — the grid, the scrollback above it, the cursor, the pen and the
/// modes — so a viewer attaching later can be handed <see cref="Snapshot"/>: the sequences that
/// reproduce that screen from nothing.
/// </summary>
/// <remarks>
/// <para><b>Why this exists.</b> It replaces a ring of the last 512 KB of raw output, which was
/// replayed verbatim to each attaching viewer. Raw bytes cannot be replayed: they are not a
/// description of a screen, they are the <i>edits</i> that produced one, and an edit only means
/// anything against the screen and the grid it was made against. A repaint that says "up nine rows,
/// draw this" repeats its nine rows when it is replayed somewhere the cursor is elsewhere; bytes
/// drawn at 120 columns wrap differently at 118; and an erase cannot reach content that has already
/// scrolled out of the viewport. The result was the same paragraph stacked several times down the
/// scrollback — the bug this class was written to end. A screen model collapses every one of those
/// edits into the cell it landed on, so what a new viewer gets is a screen, not a tape.</para>
///
/// <para><b>Not an emulator for its own sake.</b> It covers what a ConPTY on this machine actually
/// emits and what Ink draws with — absolute cursor moves, erases, SGR (including 24-bit colour),
/// scroll regions, the alternate screen and the handful of DEC private modes that change how a
/// terminal behaves for the user. Queries are deliberately not answered: the terminal at the other
/// end is the browser's, and it answers for itself.</para>
///
/// <para>Not thread-safe; both callers drive it from inside the lock they already hold.</para>
/// </remarks>
public sealed class ScreenModel
{
    /// <summary>
    /// How many scrolled-off lines to keep. Lines, not bytes: the old ring spent its 512 KB on
    /// repaints of a screen already in it, so a session could have minutes of history or three
    /// screens depending on how busy the TUI had been. This is the same bound the browser's xterm
    /// keeps, and history lines are stored rendered (see <see cref="ScreenBuffer"/>), so a deep
    /// scrollback costs less than the ring it replaces.
    /// </summary>
    public const int DefaultHistoryLines = 3000;

    private ScreenBuffer _normal;
    private ScreenBuffer _alt;
    private bool _altActive;

    /// <summary>The buffer the child is drawing into right now.</summary>
    private ScreenBuffer Screen => _altActive ? _alt : _normal;

    // DEC private modes worth restoring to a viewer. Anything not in here is consumed and dropped:
    // a mode the browser's terminal does not act on is noise in the snapshot, and one we do not
    // understand is not ours to assert. Value is the mode's current state.
    private readonly Dictionary<int, bool> _decModes = new();

    // The private modes that change what the user sees or what their keyboard and mouse send, and
    // so have to be part of the screen a viewer is handed.
    private static readonly int[] RestorableDecModes =
    [
        1,      // DECCKM — application cursor keys: what the arrow keys send
        7,      // autowrap
        25,     // cursor visible
        66,     // application keypad (DECNKM)
        1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, // mouse reporting and its encodings
        2004,   // bracketed paste
        2026,   // synchronised output
        2031,   // colour-scheme change notifications
    ];

    /// <summary>ESC, as a character — see the DECSC note in <see cref="Snapshot"/>.</summary>
    private const char EscChar = (char)0x1b;

    private bool _appKeypad;
    private int _lastRune = -1;   // for REP
    private int _lastWidth = 1;

    // ---- parser state ---------------------------------------------------------------------------

    private enum State { Ground, Esc, EscIntermediate, Csi, Osc, StringSeq }

    private State _state = State.Ground;
    private readonly StringBuilder _paramBuf = new();
    private char _csiPrefix;              // ?, >, <, = — the private-parameter marker
    private bool _oscEsc;                 // saw ESC inside a string: the next \ ends it

    // A multi-byte character can straddle a read; hold the partial sequence until the rest arrives.
    private readonly byte[] _utf8 = new byte[4];
    private int _utf8Len;
    private int _utf8Need;

    private readonly int _historyLines;

    public ScreenModel(int cols, int rows, int historyLines = DefaultHistoryLines)
    {
        _historyLines = historyLines;
        _normal = new ScreenBuffer(cols, rows, historyLines);
        _alt = new ScreenBuffer(cols, rows, historyLimit: 0); // the alternate screen has no history
    }

    public int Cols => Screen.Cols;
    public int Rows => Screen.Rows;

    /// <summary>The visible screen as plain text, one line per row.</summary>
    public string ScreenText() => Screen.PlainText();

    /// <summary>
    /// Whether the child has a DEC private mode switched on — one of those kept for the snapshot
    /// (<see cref="RestorableDecModes"/>); any other reads as off.
    /// </summary>
    public bool IsDecModeSet(int mode) => _decModes.TryGetValue(mode, out var on) && on;

    /// <summary>Move both buffers to a new grid (the pseudoconsole has been resized).</summary>
    public void Resize(int cols, int rows)
    {
        _normal.Resize(cols, rows);
        _alt.Resize(cols, rows);
    }

    // ---- input ----------------------------------------------------------------------------------

    /// <summary>Feed the child's output through the terminal.</summary>
    public void Write(ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes) Step(b);
    }

    private void Step(byte b)
    {
        switch (_state)
        {
            case State.Ground:
                Ground(b);
                break;

            case State.Esc:
                Esc(b);
                break;

            case State.EscIntermediate:
                // A charset designation or the like: one more byte, then back to normal. Nothing we
                // keep — the stream is UTF-8 and stays UTF-8.
                _state = State.Ground;
                break;

            case State.Csi:
                Csi(b);
                break;

            case State.Osc:
            case State.StringSeq:
                StringByte(b);
                break;
        }
    }

    private void Ground(byte b)
    {
        // An incomplete UTF-8 character claims the continuation bytes that follow it.
        if (_utf8Need > 0)
        {
            if ((b & 0xC0) == 0x80)
            {
                _utf8[_utf8Len++] = b;
                if (_utf8Len == _utf8Need) FlushUtf8();
                return;
            }
            DropUtf8();     // malformed: abandon the partial character and read this byte afresh
        }

        if (b < 0x20)
        {
            switch (b)
            {
                case 0x08: Screen.MoveBy(-1, 0); break;
                case 0x09: Screen.Tab(); break;
                case 0x0A or 0x0B or 0x0C: Screen.LineFeed(); break;
                case 0x0D: Screen.CarriageReturn(); break;
                case 0x1B: _state = State.Esc; break;
                // BEL and the rest paint nothing.
            }
            return;
        }

        if (b == 0x7F) return; // DEL

        if (b < 0x80) { PutRune(b); return; }

        // The start of a multi-byte character: how many bytes it claims.
        _utf8Need = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
        if (_utf8Need == 0) return; // a stray continuation byte: nothing to do with it
        _utf8[0] = b;
        _utf8Len = 1;
    }

    private void FlushUtf8()
    {
        var s = Encoding.UTF8.GetString(_utf8, 0, _utf8Len);
        DropUtf8();
        foreach (var rune in s.EnumerateRunes()) PutRune(rune.Value);
    }

    private void DropUtf8()
    {
        _utf8Len = 0;
        _utf8Need = 0;
    }

    private void PutRune(int rune)
    {
        // The C1 controls, dropped rather than stored. A cell holding one would be written back out
        // by the snapshot, and a terminal reading UTF-8 still acts on them — U+009B is CSI, U+009D is
        // OSC — so a child that prints one would be handing the sequence to every viewer that
        // attaches later, out of what was only ever meant to be text on a screen.
        if (rune is >= 0x80 and <= 0x9F) return;

        var width = CharWidth.Of(rune);
        Screen.Put(rune, width);
        _lastRune = rune;
        _lastWidth = width;
    }

    private void Esc(byte b)
    {
        _state = State.Ground;
        switch ((char)b)
        {
            case (char)0x1b:
                _state = State.Esc;   // ESC ESC: the first one is abandoned, the second starts over
                break;

            case '[':
                _paramBuf.Clear();
                _csiPrefix = '\0';
                _state = State.Csi;
                break;

            case ']':
                _paramBuf.Clear();
                _oscEsc = false;
                _state = State.Osc;
                break;

            // DCS / SOS / PM / APC: a string we consume and drop, like the OSCs.
            case 'P' or 'X' or '^' or '_':
                _oscEsc = false;
                _state = State.StringSeq;
                break;

            case '7': Screen.SaveCursor(); break;
            case '8': Screen.RestoreCursor(); break;
            case 'D': Screen.LineFeed(); break;
            case 'E': Screen.CarriageReturn(); Screen.LineFeed(); break;
            case 'M': Screen.ReverseIndex(); break;
            case 'c': Reset(); break;
            case '=': _appKeypad = true; break;
            case '>': _appKeypad = false; break;

            // Charset selects and DECALN take one more byte.
            case '(' or ')' or '*' or '+' or '%' or '#':
                _state = State.EscIntermediate;
                break;
        }
    }

    private void Reset()
    {
        var cols = Screen.Cols;
        var rows = Screen.Rows;
        _normal = new ScreenBuffer(cols, rows, _historyLines);
        _alt = new ScreenBuffer(cols, rows, historyLimit: 0);
        _altActive = false;
        _decModes.Clear();
        _appKeypad = false;
    }

    private void StringByte(byte b)
    {
        // OSC ends at BEL or ST (ESC \); the payload is dropped either way. That includes OSC 52,
        // which is a clipboard write — replaying one at a viewer that has just attached would put
        // whatever the session once copied onto that person's clipboard, unasked.
        if (_oscEsc)
        {
            _oscEsc = false;
            _state = State.Ground;
            if (b != (byte)'\\') Step(b); // ESC started something else; let it be read properly
            return;
        }
        if (b == 0x07) { _state = State.Ground; return; }
        if (b == 0x1B) { _oscEsc = true; return; }
    }

    private void Csi(byte b)
    {
        // Parameter bytes (digits, ; and :) and the private markers that may lead them.
        if (b is >= 0x30 and <= 0x3F)
        {
            if (_paramBuf.Length == 0 && b is (byte)'?' or (byte)'>' or (byte)'<' or (byte)'=')
                _csiPrefix = (char)b;
            else if (_paramBuf.Length < 128)
                _paramBuf.Append((char)b);
            return;
        }
        // Intermediates (space through /) ride along and change nothing we implement.
        if (b is >= 0x20 and <= 0x2F) return;
        // An escape inside a sequence abandons it and starts a new one, which is what every terminal
        // does — two writers interleaving on one pty, or a program killed mid-sequence, otherwise
        // leaves the sequence that follows to be printed as text.
        if (b == 0x1B) { _state = State.Esc; return; }
        if (b is < 0x40 or > 0x7E) { _state = State.Ground; return; }

        _state = State.Ground;
        Dispatch((char)b, ParseParams());
    }

    /// <summary>
    /// The CSI parameters. Each one is its colon-separated parts — <c>38:2:0:170:255</c> is one
    /// parameter of five parts, and SGR reads it exactly as it reads the five-semicolon form.
    /// </summary>
    private List<int[]> ParseParams()
    {
        var result = new List<int[]>();
        if (_paramBuf.Length == 0) return result;
        foreach (var part in _paramBuf.ToString().Split(';'))
        {
            var bits = part.Split(':');
            var vals = new int[bits.Length];
            for (var i = 0; i < bits.Length; i++)
                vals[i] = int.TryParse(bits[i], out var v) ? v : 0;
            result.Add(vals);
        }
        return result;
    }

    private static int At(List<int[]> ps, int i, int fallback)
    {
        if (i >= ps.Count || ps[i].Length == 0) return fallback;
        var v = ps[i][0];
        return v == 0 ? fallback : v;
    }

    private static int Raw(List<int[]> ps, int i) => i < ps.Count && ps[i].Length > 0 ? ps[i][0] : 0;

    private void Dispatch(char final, List<int[]> ps)
    {
        if (_csiPrefix == '?')
        {
            if (final is 'h' or 'l') SetDecModes(ps, final == 'h');
            return; // every other private form is a query or a report; not ours to answer
        }
        if (_csiPrefix != '\0') return; // > and < forms are queries too

        var screen = Screen;
        switch (final)
        {
            case '@': screen.InsertChars(At(ps, 0, 1)); break;
            case 'A': screen.MoveBy(0, -At(ps, 0, 1)); break;
            case 'B': case 'e': screen.MoveBy(0, At(ps, 0, 1)); break;
            case 'C': case 'a': screen.MoveBy(At(ps, 0, 1), 0); break;
            case 'D': screen.MoveBy(-At(ps, 0, 1), 0); break;
            case 'E': screen.MoveTo(0, screen.CursorY + At(ps, 0, 1)); break;
            case 'F': screen.MoveTo(0, screen.CursorY - At(ps, 0, 1)); break;
            case 'G': case '`': screen.MoveTo(At(ps, 0, 1) - 1, screen.CursorY); break;
            case 'H': case 'f': screen.MoveTo(At(ps, 1, 1) - 1, At(ps, 0, 1) - 1); break;
            case 'I': for (var i = 0; i < At(ps, 0, 1); i++) screen.Tab(); break;
            case 'J': screen.EraseInDisplay(Raw(ps, 0)); break;
            case 'K': screen.EraseInLine(Raw(ps, 0)); break;
            case 'L': screen.InsertLines(At(ps, 0, 1)); break;
            case 'M': screen.DeleteLines(At(ps, 0, 1)); break;
            case 'P': screen.DeleteChars(At(ps, 0, 1)); break;
            case 'S': screen.ScrollUp(At(ps, 0, 1)); break;
            case 'T': screen.ScrollDown(At(ps, 0, 1)); break;
            case 'X': screen.EraseChars(At(ps, 0, 1)); break;
            case 'Z': screen.MoveTo(Math.Max(0, (screen.CursorX - 1) / 8 * 8), screen.CursorY); break;
            case 'b': Repeat(At(ps, 0, 1)); break;
            case 'd': screen.MoveTo(screen.CursorX, At(ps, 0, 1) - 1); break;
            case 'm': Sgr(ps); break;
            case 'r': screen.SetMargins(At(ps, 0, 1) - 1, At(ps, 1, screen.Rows) - 1); break;
            case 's': screen.SaveCursor(); break;
            case 'u': screen.RestoreCursor(); break;
            // h/l without the private marker are ANSI modes (insert mode and friends); n is a status
            // report, g clears tab stops, t is a window operation. None of them belong to us.
        }
    }

    /// <summary>REP: the last character printed again, n times.</summary>
    private void Repeat(int n)
    {
        if (_lastRune < 0) return;
        for (var i = 0; i < Math.Min(n, Screen.Cols * 2); i++) Screen.Put(_lastRune, _lastWidth);
    }

    private void SetDecModes(List<int[]> ps, bool set)
    {
        foreach (var p in ps)
        {
            if (p.Length == 0) continue;
            var mode = p[0];
            switch (mode)
            {
                // The alternate screen. 1049 also saves/restores the cursor and clears the alt buffer
                // on the way in, which is what makes a full-screen program leave no trace behind.
                case 1049 or 1047 or 47:
                    if (set)
                    {
                        if (!_altActive)
                        {
                            if (mode == 1049) _normal.SaveCursor();
                            _alt = new ScreenBuffer(_normal.Cols, _normal.Rows, historyLimit: 0);
                            _altActive = true;
                        }
                    }
                    else if (_altActive)
                    {
                        _altActive = false;
                        if (mode == 1049) _normal.RestoreCursor();
                    }
                    break;

                // DECAWM has to be obeyed, not merely remembered: the snapshot restores it to the
                // viewer's terminal, so a screen that wraps where the browser does not would disagree
                // with it about every line that reaches the edge.
                case 7:
                    _normal.AutoWrap = set;
                    _alt.AutoWrap = set;
                    _decModes[7] = set;
                    break;

                default:
                    if (Array.IndexOf(RestorableDecModes, mode) >= 0) _decModes[mode] = set;
                    break;
            }
        }
    }

    private void Sgr(List<int[]> ps)
    {
        if (ps.Count == 0) { Screen.Pen = Pen.Default; return; }
        var pen = Screen.Pen;

        for (var i = 0; i < ps.Count; i++)
        {
            var p = ps[i];
            var code = p.Length > 0 ? p[0] : 0;
            switch (code)
            {
                case 0: pen = Pen.Default; break;
                case 1: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Bold) }; break;
                case 2: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Dim) }; break;
                case 3: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Italic) }; break;
                case 4: pen = p.Length > 1 && p[1] == 0
                    ? pen with { Flags = (ushort)(pen.Flags & ~Pen.Underline) }
                    : pen with { Flags = (ushort)(pen.Flags | Pen.Underline) }; break;
                case 5 or 6: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Blink) }; break;
                case 7: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Inverse) }; break;
                case 8: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Invisible) }; break;
                case 9: pen = pen with { Flags = (ushort)(pen.Flags | Pen.Strike) }; break;
                case 21 or 22: pen = pen with { Flags = (ushort)(pen.Flags & ~(Pen.Bold | Pen.Dim)) }; break;
                case 23: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Italic) }; break;
                case 24: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Underline) }; break;
                case 25: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Blink) }; break;
                case 27: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Inverse) }; break;
                case 28: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Invisible) }; break;
                case 29: pen = pen with { Flags = (ushort)(pen.Flags & ~Pen.Strike) }; break;
                case >= 30 and <= 37: pen = pen with { Fg = code - 30 }; break;
                case 38: pen = pen with { Fg = ExtendedColor(ps, p, ref i) }; break;
                case 39: pen = pen with { Fg = -1 }; break;
                case >= 40 and <= 47: pen = pen with { Bg = code - 40 }; break;
                case 48: pen = pen with { Bg = ExtendedColor(ps, p, ref i) }; break;
                case 49: pen = pen with { Bg = -1 }; break;
                // Underline colour. Nothing here draws it, but its arguments have to be consumed or
                // they are read as attributes of their own — a 58;2;r;g;b would set dim and then
                // reset the pen, losing whatever the child had asked for.
                case 58: ExtendedColor(ps, p, ref i); break;
                case 59: break;
                case >= 90 and <= 97: pen = pen with { Fg = code - 90 + 8 }; break;
                case >= 100 and <= 107: pen = pen with { Bg = code - 100 + 8 }; break;
            }
        }
        Screen.Pen = pen;
    }

    /// <summary>
    /// The colour after a 38 or 48, in either spelling: <c>38;5;n</c> / <c>38;2;r;g;b</c> spread over
    /// the parameters that follow, or <c>38:5:n</c> / <c>38:2:r:g:b</c> packed into this one.
    /// </summary>
    private static int ExtendedColor(List<int[]> ps, int[] self, ref int i)
    {
        if (self.Length > 1)
        {
            // Colon form. The 2:r:g:b spelling has an optional colour-space id in front of r.
            if (self[1] == 5 && self.Length > 2) return self[2] & 0xFF;
            if (self[1] == 2 && self.Length >= 5)
            {
                var off = self.Length >= 6 ? 3 : 2;
                return Pen.TrueColor | (self[off] & 0xFF) << 16 | (self[off + 1] & 0xFF) << 8 | (self[off + 2] & 0xFF);
            }
            return -1;
        }

        var kind = Raw(ps, i + 1);
        if (kind == 5 && i + 2 < ps.Count)
        {
            i += 2;
            return Raw(ps, i) & 0xFF;
        }
        if (kind == 2 && i + 4 < ps.Count)
        {
            var r = Raw(ps, i + 2) & 0xFF;
            var g = Raw(ps, i + 3) & 0xFF;
            var b = Raw(ps, i + 4) & 0xFF;
            i += 4;
            return Pen.TrueColor | r << 16 | g << 8 | b;
        }
        i = ps.Count; // malformed: swallow the rest rather than read a colour part as an attribute
        return -1;
    }

    // ---- output ---------------------------------------------------------------------------------

    /// <summary>
    /// The screen as VT bytes: everything a terminal needs to arrive at this state from a clean one.
    /// History first, then the visible rows, then the cursor, the modes and the pen — so what the
    /// viewer ends up with is what the child believes it has drawn, and the next live byte lands in
    /// the same place it would have landed for a viewer that had been attached all along.
    /// </summary>
    public byte[] Snapshot()
    {
        var sb = new StringBuilder();

        // Start from a known screen: leave the alternate buffer, reset the pen, clear the grid and
        // the terminal's own scrollback. Harmless on a fresh terminal, and the difference between a
        // reattach and a doubled screen on one that has content.
        sb.Append("\x1b[?1049l\x1b[m\x1b[H\x1b[2J\x1b[3J");

        AppendBuffer(sb, _normal, withHistory: true);

        if (_altActive)
        {
            // Park the cursor where the normal buffer left it BEFORE switching: ?1049h is what saves
            // it, and what ?1049l restores when the full-screen program exits. Saving the row the
            // history replay happened to end on would drop the shell back onto the wrong line.
            AppendCursor(sb, _normal);
            sb.Append("\x1b[?1049h\x1b[H\x1b[2J");
            AppendBuffer(sb, _alt, withHistory: false);
        }

        var screen = Screen;

        // What DECSC would give back. Set by moving there, saving, and moving on — the only way to
        // put a saved position into a terminal that has not been through the same moves.
        var (savedX, savedY) = screen.SavedCursor;
        if (savedX != 0 || savedY != 0)
        {
            sb.Append("\x1b[m");
            AppendCursorAt(sb, savedX, savedY);
            // DECSC. Written with a char constant because the two-character C# escape for ESC
            // followed by a digit is read as one character (up to four hex digits after the x).
            sb.Append(EscChar).Append('7');
        }

        // The scroll region, before the cursor: DECSTBM homes the cursor, so setting it afterwards
        // would undo the position we are about to restore.
        if (screen.MarginTop != 0 || screen.MarginBottom != screen.Rows - 1)
            sb.Append("\x1b[").Append(screen.MarginTop + 1).Append(';').Append(screen.MarginBottom + 1).Append('r');

        foreach (var mode in RestorableDecModes)
            if (_decModes.TryGetValue(mode, out var on))
                sb.Append("\x1b[?").Append(mode).Append(on ? 'h' : 'l');
        sb.Append(_appKeypad ? "\x1b=" : "\x1b>");

        // The cursor, and then the pen: the child's next byte is written with both. A deferred wrap
        // cannot be expressed as a position — the cursor sits ON the last column with the wrap owed —
        // so that one is restored by drawing the character again, which leaves the terminal owing the
        // same wrap. Without it the next character overwrites the last column instead of starting the
        // row below, on every line that exactly fills the width.
        if (screen.PendingWrap)
        {
            var (text, x) = screen.CursorCell();
            AppendCursorAt(sb, x, screen.CursorY);
            sb.Append(text);
        }
        else AppendCursor(sb, screen);

        if (screen.Pen != Pen.Default) screen.Pen.AppendSgr(sb);
        else sb.Append("\x1b[m");

        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static void AppendCursor(StringBuilder sb, ScreenBuffer buffer) =>
        AppendCursorAt(sb, buffer.CursorX, buffer.CursorY);

    private static void AppendCursorAt(StringBuilder sb, int x, int y) =>
        sb.Append("\x1b[").Append(y + 1).Append(';').Append(x + 1).Append('H');

    /// <summary>
    /// Write a buffer's lines. A line that wrapped is written without a break so the terminal wraps
    /// it again — a hard break there would split one logical line, and the browser builds file links
    /// and selections out of logical lines.
    /// </summary>
    private static void AppendBuffer(StringBuilder sb, ScreenBuffer buffer, bool withHistory)
    {
        var lines = new List<(string Text, bool Wrapped)>(buffer.Rows + (withHistory ? buffer.History.Count : 0));
        if (withHistory)
            foreach (var line in buffer.History)
                // A line only runs on into the next one at the width it was drawn at. History is not
                // reflowed, so after a resize an old wrapped line no longer reaches the edge, and
                // letting it run on would start the line below it halfway across a row — an offset
                // every line after it then inherits.
                lines.Add((line.Text, line.Wrapped && line.Cols == buffer.Cols));
        for (var y = 0; y < buffer.Rows; y++)
            lines.Add((buffer.RenderRow(y), buffer.IsWrapped(y)));

        for (var i = 0; i < lines.Count; i++)
        {
            sb.Append(lines[i].Text);
            // No break after the last line: it would scroll the screen by one and put the whole frame
            // a row higher than the child has it.
            if (i == lines.Count - 1) break;
            // A wrap joins two lines only when there is something on the far side of it. An erase can
            // leave a row marked as running on into a row that is now empty, and joining there
            // swallows the empty row — lifting every line below it by one.
            if (lines[i].Wrapped && lines[i + 1].Text.Length > 0) continue;
            sb.Append("\r\n");
        }
    }
}
