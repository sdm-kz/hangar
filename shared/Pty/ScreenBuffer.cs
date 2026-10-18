namespace Hangar.Pty;

/// <summary>
/// One terminal screen: a grid of cells, a cursor, scroll margins, and — for the normal buffer —
/// the lines that have scrolled off the top. Everything a VT sequence can do to the visible screen
/// happens here; deciding <i>which</i> sequence did it is <see cref="ScreenModel"/>'s job.
/// </summary>
/// <remarks>
/// Not thread-safe: both callers already hold a lock around the byte stream that drives it.
///
/// <para>Scrolled-off lines are kept <b>serialized</b> rather than as cells. History is immutable —
/// nothing can ever paint into it again — so a line costs one small string instead of <c>cols</c>
/// cells, which is what lets the scrollback be thousands of lines deep for less memory than the
/// 512 KB byte ring it replaces. It also means history is not reflowed when the grid resizes, the
/// same bargain tmux makes: what scrolled off was drawn at the width it was drawn at, and re-wrapping
/// it moves the ground under whatever the reader is looking at.</para>
/// </remarks>
public sealed class ScreenBuffer
{
    /// <summary>
    /// How many combining marks one cell will take. Terminals keep a handful; the point of the cap
    /// is that a run of them cannot grow a single cell without bound (and re-copy it on every one).
    /// </summary>
    private const int MaxCombiningChars = 8;

    /// <summary>
    /// A ceiling on the whole scrollback, in characters, for the sessions where the line limit is not
    /// the binding one. Roughly four megabytes of text per buffer at the worst, against a few hundred
    /// kilobytes for ordinary output.
    /// </summary>
    private const int MaxHistoryChars = 2_000_000;

    /// <summary>A line that has scrolled off the top, already rendered as VT text.</summary>
    /// <param name="Text">The line's cells as SGR runs — no trailing blanks, no line break.</param>
    /// <param name="Wrapped">
    /// True when the line filled the width and ran on into the next one. Kept so the snapshot can
    /// let the terminal wrap it again instead of writing a hard break, which would split one logical
    /// line in two — and the browser reconstructs file paths and selections from logical lines.
    /// </param>
    /// <param name="Cols">
    /// The width the line was rendered at. <paramref name="Wrapped"/> only means anything at that
    /// width: a line that ran on into the next one at 120 columns does not reach the edge of a
    /// 90-column screen, and letting it run on there would start the line below it halfway across a
    /// row — which shifts every row after it, the screen included.
    /// </param>
    public readonly record struct HistoryLine(string Text, bool Wrapped, int Cols);

    private Cell[][] _rows;
    private bool[] _wrapped;               // per row: did it run on into the row below?
    private readonly Queue<HistoryLine> _history = new();
    private readonly int _historyLimit;
    private int _historyChars;             // running total of the history text, for MaxHistoryChars

    public int Cols { get; private set; }
    public int Rows { get; private set; }
    public int CursorX { get; private set; }
    public int CursorY { get; private set; }

    /// <summary>
    /// DEC's deferred wrap. Writing into the last column leaves the cursor <i>on</i> it with this
    /// set, and only the next character moves to the row below. A terminal that wraps eagerly puts a
    /// blank line after every line that exactly fills the width, which is most lines of a TUI frame.
    /// </summary>
    private bool _pendingWrap;

    // Scroll region, inclusive, 0-based. The whole screen unless DECSTBM says otherwise.
    private int _marginTop;
    private int _marginBottom;

    private int _savedX, _savedY;
    private Pen _savedPen = Pen.Default;

    /// <summary>The pen the next character is written with (SGR state).</summary>
    public Pen Pen { get; set; } = Pen.Default;

    /// <summary>
    /// DECAWM. With it off the cursor stays on the last column and each further character overwrites
    /// it, instead of the line running on into the next row. Tracked rather than assumed because the
    /// snapshot restores the mode to the viewer's terminal: a screen that wraps where the browser
    /// does not (or the other way about) disagrees with it about every long line from then on.
    /// </summary>
    public bool AutoWrap { get; set; } = true;

    /// <summary>Whether the cursor is sitting on the last column with its wrap still pending.</summary>
    public bool PendingWrap => _pendingWrap;

    /// <summary>The scroll region, inclusive — the whole screen unless DECSTBM narrowed it.</summary>
    public int MarginTop => _marginTop;

    /// <summary>The foot of the scroll region (see <see cref="MarginTop"/>).</summary>
    public int MarginBottom => _marginBottom;

    /// <summary>Where DECSC last put the cursor, for a snapshot that has to carry it across.</summary>
    public (int X, int Y) SavedCursor => (_savedX, _savedY);

    public ScreenBuffer(int cols, int rows, int historyLimit)
    {
        Cols = Math.Max(1, cols);
        Rows = Math.Max(1, rows);
        _historyLimit = Math.Max(0, historyLimit);
        _rows = new Cell[Rows][];
        _wrapped = new bool[Rows];
        for (var y = 0; y < Rows; y++) _rows[y] = NewRow();
        _marginBottom = Rows - 1;
    }

    /// <summary>The lines that have scrolled off the top, oldest first.</summary>
    public IReadOnlyCollection<HistoryLine> History => _history;

    private Cell[] NewRow()
    {
        var row = new Cell[Cols];
        Array.Fill(row, Cell.Empty);
        return row;
    }

    /// <summary>A blank cell in the current pen's background — what an erase leaves behind.</summary>
    private Cell Blank() => new(' ', null, new Pen(-1, Pen.Bg, 0));

    /// <summary>
    /// Writing over either half of a double-width character destroys the other half: no terminal can
    /// draw half a glyph, so what is left becomes a blank. Called for the cell about to be written,
    /// which the caller overwrites straight after.
    /// </summary>
    /// <remarks>
    /// Not a nicety. A row whose orphaned half is left in place holds more display columns than the
    /// grid has, and the snapshot of such a row is a line too long for the terminal it is sent to —
    /// which wraps it, and pushes every row below it down by one. A TUI redrawing over an emoji is
    /// all it takes.
    /// </remarks>
    private static void BreakPair(Cell[] row, int x)
    {
        if (x > 0 && row[x].IsWideTail) row[x - 1] = Cell.Empty;            // writing onto the tail
        if (x + 1 < row.Length && row[x + 1].IsWideTail) row[x + 1] = Cell.Empty; // onto the head
    }

    /// <summary>
    /// The same repair across a whole row, for the edits that move cells around rather than write
    /// one: a shift can tear a pair apart anywhere in the row, and these are rare enough to afford
    /// the walk.
    /// </summary>
    private static void BreakPairs(Cell[] row)
    {
        for (var x = 0; x < row.Length; x++)
        {
            if (row[x].IsWideTail)
            {
                // A tail whose head is gone, or was never beside it.
                if (x == 0 || CharWidth.Of(row[x - 1].Rune) != 2) row[x] = Cell.Empty;
            }
            else if (row[x].Rune > 0 && CharWidth.Of(row[x].Rune) == 2)
            {
                // A head whose tail is gone.
                if (x + 1 >= row.Length || !row[x + 1].IsWideTail) row[x] = Cell.Empty;
            }
        }
    }

    // ---- cursor ---------------------------------------------------------------------------------

    public void MoveTo(int x, int y)
    {
        CursorX = Math.Clamp(x, 0, Cols - 1);
        CursorY = Math.Clamp(y, 0, Rows - 1);
        _pendingWrap = false;
    }

    public void MoveBy(int dx, int dy) => MoveTo(CursorX + dx, CursorY + dy);

    public void CarriageReturn()
    {
        CursorX = 0;
        _pendingWrap = false;
    }

    public void SaveCursor()
    {
        _savedX = CursorX;
        _savedY = CursorY;
        _savedPen = Pen;
    }

    public void RestoreCursor()
    {
        MoveTo(_savedX, _savedY);
        Pen = _savedPen;
    }

    public void SetMargins(int top, int bottom)
    {
        top = Math.Clamp(top, 0, Rows - 1);
        bottom = Math.Clamp(bottom, 0, Rows - 1);
        if (top >= bottom) { top = 0; bottom = Rows - 1; }
        _marginTop = top;
        _marginBottom = bottom;
        // DECSTBM homes the cursor to the top of the PAGE, not of the region it just set — origin
        // mode is what would make those the same thing, and nothing here sets it. A TUI's first line
        // after declaring its scroll region otherwise lands a row low.
        MoveTo(0, 0);
    }

    public void Tab()
    {
        var next = Math.Min(Cols - 1, (CursorX / 8 + 1) * 8);
        MoveTo(next, CursorY);
    }

    // ---- writing --------------------------------------------------------------------------------

    /// <summary>Put one character at the cursor, advancing it (and wrapping) as a terminal would.</summary>
    /// <param name="width">0 for a combining mark, 2 for a double-width character, otherwise 1.</param>
    public void Put(int rune, int width)
    {
        if (width == 0)
        {
            // A combining mark belongs to the cell before the cursor, not to one of its own.
            var x = _pendingWrap ? CursorX : CursorX - 1;
            if (x < 0 || x >= Cols) return;
            // On a double-width character that cell is the tail, which carries nothing and is skipped
            // when the row is rendered — the mark belongs on the half that holds the character.
            if (_rows[CursorY][x].IsWideTail && x > 0) x--;
            ref var prev = ref _rows[CursorY][x];
            // A cell takes a few marks, not an unbounded run of them. Without a cap a stream of
            // combining characters grows one string forever, re-copying it on every append — and
            // then freezes the whole thing into a history line when the row scrolls away.
            if (prev.Extra is { Length: >= MaxCombiningChars }) return;
            prev = prev with { Extra = (prev.Extra ?? "") + char.ConvertFromUtf32(rune) };
            return;
        }

        if (_pendingWrap && !AutoWrap)
        {
            // Wrapping is off: the cursor stays where it is and this character overwrites the last
            // column, which is what the mode means.
            _pendingWrap = false;
        }
        else if (_pendingWrap)
        {
            _wrapped[CursorY] = true;   // this row ran on into the next: one logical line
            NextLine();
            CursorX = 0;
            _pendingWrap = false;
        }

        // A grid one column wide cannot hold a double-width character at all. Dropping it is what a
        // terminal does, and it keeps the row's columns honest — the alternative is a glyph the grid
        // has no room for, which every later measurement then has to work around.
        if (width == 2 && Cols < 2) return;

        // A double-width character that will not fit is pushed to the next row whole, as every
        // terminal does — half of one is not a character.
        if (width == 2 && CursorX == Cols - 1)
        {
            if (!AutoWrap) return;  // no room for it here, and with wrapping off nowhere to put it
            _rows[CursorY][CursorX] = Blank();
            _wrapped[CursorY] = true;
            NextLine();
            CursorX = 0;
        }

        var target = _rows[CursorY];
        BreakPair(target, CursorX);
        target[CursorX] = new Cell(rune, null, Pen);
        if (width == 2 && CursorX + 1 < Cols)
        {
            BreakPair(target, CursorX + 1);
            target[CursorX + 1] = Cell.WideTail;
        }

        if (CursorX + width >= Cols)
        {
            CursorX = Cols - 1;
            _pendingWrap = true;    // deferred: the wrap happens when the NEXT character arrives
        }
        else CursorX += width;
    }

    /// <summary>Line feed: down one row, scrolling the region when already at its foot.</summary>
    public void LineFeed()
    {
        _pendingWrap = false;
        NextLine();
    }

    private void NextLine()
    {
        if (CursorY == _marginBottom) ScrollUp(1);
        else if (CursorY < Rows - 1) CursorY++;
    }

    /// <summary>Reverse index: up one row, scrolling the region back when already at its head.</summary>
    public void ReverseIndex()
    {
        _pendingWrap = false;
        if (CursorY == _marginTop) ScrollDown(1);
        else if (CursorY > 0) CursorY--;
    }

    /// <summary>
    /// Scroll the region up by <paramref name="n"/> lines. Only a region that starts at the top of
    /// the screen feeds the scrollback: a line pushed out of a smaller region was never history, it
    /// was a TUI scrolling a pane of its own.
    /// </summary>
    public void ScrollUp(int n)
    {
        n = Math.Clamp(n, 0, _marginBottom - _marginTop + 1);
        var keepsHistory = _marginTop == 0 && _historyLimit > 0;
        for (var i = 0; i < n; i++)
        {
            if (keepsHistory) PushHistory(_rows[_marginTop], _wrapped[_marginTop]);
            for (var y = _marginTop; y < _marginBottom; y++)
            {
                _rows[y] = _rows[y + 1];
                _wrapped[y] = _wrapped[y + 1];
            }
            _rows[_marginBottom] = NewRow();
            _wrapped[_marginBottom] = false;
        }
    }

    public void ScrollDown(int n)
    {
        n = Math.Clamp(n, 0, _marginBottom - _marginTop + 1);
        for (var i = 0; i < n; i++)
        {
            for (var y = _marginBottom; y > _marginTop; y--)
            {
                _rows[y] = _rows[y - 1];
                _wrapped[y] = _wrapped[y - 1];
            }
            _rows[_marginTop] = NewRow();
            _wrapped[_marginTop] = false;
        }
    }

    private void PushHistory(Cell[] row, bool wrapped)
    {
        var line = new HistoryLine(RenderRow(row, wrapped), wrapped, row.Length);
        _history.Enqueue(line);
        _historyChars += line.Text.Length;
        // Bounded by both counts. A line is normally its text and a few escapes, so the line limit is
        // what bites — but a child that colours every character (a gradient bar, `lolcat`) writes rows
        // of several hundred escape bytes each, and three thousand of those is tens of megabytes held
        // per session for days. Whichever limit is reached first, the oldest lines go.
        while (_history.Count > _historyLimit || (_historyChars > MaxHistoryChars && _history.Count > 1))
            _historyChars -= _history.Dequeue().Text.Length;
    }

    // ---- erasing and editing --------------------------------------------------------------------

    /// <summary>ED: 0 = cursor to end of screen, 1 = start to cursor, 2 = all, 3 = the scrollback.</summary>
    public void EraseInDisplay(int mode)
    {
        switch (mode)
        {
            case 0:
                EraseInLine(0);
                for (var y = CursorY + 1; y < Rows; y++) ClearRow(y);
                break;
            case 1:
                EraseInLine(1);
                for (var y = 0; y < CursorY; y++) ClearRow(y);
                break;
            case 2:
                for (var y = 0; y < Rows; y++) ClearRow(y);
                break;
            case 3:
                _history.Clear();
                _historyChars = 0;
                break;
        }
        _pendingWrap = false;
    }

    /// <summary>EL: 0 = cursor to end of line, 1 = start of line to cursor, 2 = the whole line.</summary>
    public void EraseInLine(int mode)
    {
        var row = _rows[CursorY];
        var (from, to) = mode switch
        {
            1 => (0, CursorX),
            2 => (0, Cols - 1),
            _ => (CursorX, Cols - 1),
        };
        for (var x = from; x <= to && x < Cols; x++) row[x] = Blank();
        BreakPairs(row);
        if (to >= Cols - 1) _wrapped[CursorY] = false;
        _pendingWrap = false;
    }

    /// <summary>ECH: blank n cells from the cursor, moving nothing.</summary>
    public void EraseChars(int n)
    {
        var row = _rows[CursorY];
        for (var i = 0; i < n && CursorX + i < Cols; i++) row[CursorX + i] = Blank();
        BreakPairs(row);
        _pendingWrap = false;
    }

    /// <summary>ICH: open n cells at the cursor, pushing the rest of the line right.</summary>
    public void InsertChars(int n)
    {
        var row = _rows[CursorY];
        n = Math.Clamp(n, 0, Cols - CursorX);
        for (var x = Cols - 1; x >= CursorX + n; x--) row[x] = row[x - n];
        for (var x = CursorX; x < CursorX + n; x++) row[x] = Blank();
        BreakPairs(row);
        _pendingWrap = false;
    }

    /// <summary>DCH: remove n cells at the cursor, pulling the rest of the line left.</summary>
    public void DeleteChars(int n)
    {
        var row = _rows[CursorY];
        n = Math.Clamp(n, 0, Cols - CursorX);
        for (var x = CursorX; x < Cols; x++) row[x] = x + n < Cols ? row[x + n] : Blank();
        BreakPairs(row);
        _pendingWrap = false;
    }

    /// <summary>IL: open n rows at the cursor, within the scroll region.</summary>
    public void InsertLines(int n)
    {
        if (CursorY < _marginTop || CursorY > _marginBottom) return;
        n = Math.Clamp(n, 0, _marginBottom - CursorY + 1);
        for (var i = 0; i < n; i++)
        {
            for (var y = _marginBottom; y > CursorY; y--)
            {
                _rows[y] = _rows[y - 1];
                _wrapped[y] = _wrapped[y - 1];
            }
            _rows[CursorY] = NewRow();
            _wrapped[CursorY] = false;
        }
        CursorX = 0;
        _pendingWrap = false;
    }

    /// <summary>DL: remove n rows at the cursor, within the scroll region.</summary>
    public void DeleteLines(int n)
    {
        if (CursorY < _marginTop || CursorY > _marginBottom) return;
        n = Math.Clamp(n, 0, _marginBottom - CursorY + 1);
        for (var i = 0; i < n; i++)
        {
            for (var y = CursorY; y < _marginBottom; y++)
            {
                _rows[y] = _rows[y + 1];
                _wrapped[y] = _wrapped[y + 1];
            }
            _rows[_marginBottom] = NewRow();
            _wrapped[_marginBottom] = false;
        }
        CursorX = 0;
        _pendingWrap = false;
    }

    private void ClearRow(int y)
    {
        var row = _rows[y];
        for (var x = 0; x < Cols; x++) row[x] = Blank();
        _wrapped[y] = false;
    }

    // ---- resize ---------------------------------------------------------------------------------

    /// <summary>
    /// Move to a new grid. Rows are anchored to the bottom — a shorter screen loses rows off the top,
    /// into the history, which is where a terminal takes them from — and the content itself is not
    /// reflowed: the child redraws its whole frame on the SIGWINCH that follows, and re-wrapping what
    /// is on screen in the meantime only invents a second version of a frame about to be replaced.
    /// </summary>
    public void Resize(int cols, int rows)
    {
        cols = Math.Max(1, cols);
        rows = Math.Max(1, rows);
        if (cols == Cols && rows == Rows) return;

        var old = _rows;
        var oldWrapped = _wrapped;
        var oldRows = Rows;
        var oldCols = Cols;
        var drop = Math.Max(0, oldRows - rows);

        // Take the empty part of the screen first. A shorter grid has to lose rows somewhere, and a
        // terminal gives up the blank ones below the cursor before it pushes text into the history —
        // otherwise shrinking a screen with three lines on it and twenty spare rows files all three
        // away and leaves the viewer looking at nothing.
        if (drop > 0)
        {
            var lastUsed = CursorY;
            for (var y = oldRows - 1; y > lastUsed; y--)
            {
                if (Array.TrueForAll(old[y], c => c.IsBlank && c.Pen == Pen.Default)) continue;
                lastUsed = y;
                break;
            }
            drop -= Math.Min(drop, oldRows - 1 - lastUsed);
        }

        Cols = cols;
        Rows = rows;
        _rows = new Cell[rows][];
        _wrapped = new bool[rows];
        for (var i = 0; i < drop && _historyLimit > 0; i++) PushHistory(old[i], oldWrapped[i]);
        for (var y = 0; y < rows; y++)
        {
            var src = y + drop;
            if (src >= oldRows) { _rows[y] = NewRow(); continue; }
            var row = NewRow();
            Array.Copy(old[src], row, Math.Min(oldCols, cols));
            // Narrowing can cut a double-width character in half at the new right edge, and the half
            // that survives is a glyph the row has no room for.
            BreakPairs(row);
            _rows[y] = row;
            // A row only still runs on into the next one at the width it wrapped at. Any other width
            // and it no longer reaches the edge, so the row below it is a line of its own again —
            // keeping the join there would start that line halfway across a row.
            _wrapped[y] = oldWrapped[src] && cols == oldCols;
        }

        _marginTop = 0;
        _marginBottom = rows - 1;
        CursorX = Math.Clamp(CursorX, 0, cols - 1);
        CursorY = Math.Clamp(CursorY - drop, 0, rows - 1);
        _pendingWrap = false;
    }

    // ---- rendering ------------------------------------------------------------------------------

    /// <summary>One row as VT text: SGR runs, trailing blanks trimmed, no line break.</summary>
    public string RenderRow(int y) => RenderRow(_rows[y], _wrapped[y]);

    /// <summary>
    /// The character under the cursor and the column it starts at — what a snapshot re-draws to leave
    /// the viewer's terminal in a deferred wrap, which a plain cursor move cannot express.
    /// </summary>
    public (string Text, int X) CursorCell()
    {
        var x = CursorX;
        var row = _rows[CursorY];
        if (row[x].IsWideTail && x > 0) x--;   // draw the character, not the half of it
        var cell = row[x];
        var sb = new System.Text.StringBuilder();
        if (cell.Pen != Pen.Default) cell.Pen.AppendSgr(sb);
        sb.Append(cell.Rune <= 0 ? " " : char.ConvertFromUtf32(cell.Rune));
        if (cell.Extra is not null) sb.Append(cell.Extra);
        if (cell.Pen != Pen.Default) sb.Append("\x1b[m");
        return (sb.ToString(), x);
    }

    /// <summary>Whether row <paramref name="y"/> runs on into the row below (one logical line).</summary>
    public bool IsWrapped(int y) => _wrapped[y];

    /// <summary>One cell of the visible grid, pen and all — for a scanner that needs more than the text.</summary>
    public Cell CellAt(int x, int y) => _rows[y][x];

    // A wrapped line keeps its trailing blanks: it only wraps again at the far end of the row, and
    // trimming a space off the edge would glue it to the line below instead.
    private static string RenderRow(Cell[] row, bool full)
    {
        var last = row.Length - 1;
        if (!full)
        {
            last = -1;
            for (var x = row.Length - 1; x >= 0; x--)
            {
                // A trailing run of blanks is only droppable while it carries no colour: a blank
                // cell with a background set is a visible block, not empty space.
                if (row[x].IsBlank && row[x].Pen == Pen.Default) continue;
                last = x;
                break;
            }
            if (last < 0) return "";
        }

        var sb = new System.Text.StringBuilder();
        var pen = Pen.Default;
        var columns = 0;
        for (var x = 0; x <= last; x++)
        {
            var cell = row[x];
            if (cell.IsWideTail) continue; // the right half of a double-width character
            // The row must never render wider than the grid it belongs to, whatever state the cells
            // are in: a line one column too long wraps at the far end and pushes the rest of the
            // screen down. BreakPair keeps that from arising; this makes it impossible.
            var width = cell.Rune <= 0 ? 1 : CharWidth.Of(cell.Rune);
            if (columns + width > row.Length) break;
            columns += width;
            if (cell.Pen != pen)
            {
                cell.Pen.AppendSgr(sb);
                pen = cell.Pen;
            }
            sb.Append(cell.Rune <= 0 ? " " : char.ConvertFromUtf32(cell.Rune));
            if (cell.Extra is not null) sb.Append(cell.Extra);
        }
        if (pen != Pen.Default) sb.Append("\x1b[m");
        return sb.ToString();
    }

    /// <summary>The screen as plain text, one line per row — what a text scanner reads.</summary>
    public string PlainText()
    {
        var sb = new System.Text.StringBuilder();
        for (var y = 0; y < Rows; y++)
        {
            var row = _rows[y];
            for (var x = 0; x < Cols; x++)
            {
                var cell = row[x];
                if (cell.IsWideTail) continue;
                sb.Append(cell.Rune <= 0 ? " " : char.ConvertFromUtf32(cell.Rune));
                if (cell.Extra is not null) sb.Append(cell.Extra);
            }
            sb.Append('\n');
        }
        return sb.ToString();
    }
}

/// <summary>One cell: its character, any combining marks that landed on it, and its pen.</summary>
/// <param name="Rune">The code point, 0 for a blank cell, -1 for a double-width character's tail.</param>
/// <param name="Extra">Combining marks appended to it, if any.</param>
/// <param name="Pen">The colours and attributes it was drawn with.</param>
public readonly record struct Cell(int Rune, string? Extra, Pen Pen)
{
    public static readonly Cell Empty = new(0, null, Pen.Default);

    /// <summary>The right half of a double-width character; it holds no character of its own.</summary>
    public static readonly Cell WideTail = new(-1, null, Pen.Default);

    public bool IsWideTail => Rune == -1;
    public bool IsBlank => Rune is 0 or ' ' && Extra is null;
}

/// <summary>
/// The colours and attributes text is drawn with. A colour is -1 for "the terminal's default",
/// 0-255 for a palette index, or <see cref="TrueColor"/> | 0xRRGGBB for a 24-bit one.
/// </summary>
public readonly record struct Pen(int Fg, int Bg, ushort Flags)
{
    public const int TrueColor = 1 << 24;

    public const ushort Bold = 1;
    public const ushort Dim = 2;
    public const ushort Italic = 4;
    public const ushort Underline = 8;
    public const ushort Blink = 16;
    public const ushort Inverse = 32;
    public const ushort Invisible = 64;
    public const ushort Strike = 128;

    public static readonly Pen Default = new(-1, -1, 0);

    /// <summary>
    /// Write this pen as one SGR sequence, opening with a reset. Absolute rather than differential
    /// on purpose: every row of a snapshot is rendered from the default pen, so there is no earlier
    /// state to be differential against — and a snapshot has to stand on its own.
    /// </summary>
    public void AppendSgr(System.Text.StringBuilder sb)
    {
        sb.Append("\x1b[0");
        if ((Flags & Bold) != 0) sb.Append(";1");
        if ((Flags & Dim) != 0) sb.Append(";2");
        if ((Flags & Italic) != 0) sb.Append(";3");
        if ((Flags & Underline) != 0) sb.Append(";4");
        if ((Flags & Blink) != 0) sb.Append(";5");
        if ((Flags & Inverse) != 0) sb.Append(";7");
        if ((Flags & Invisible) != 0) sb.Append(";8");
        if ((Flags & Strike) != 0) sb.Append(";9");
        AppendColor(sb, Fg, background: false);
        AppendColor(sb, Bg, background: true);
        sb.Append('m');
    }

    private static void AppendColor(System.Text.StringBuilder sb, int color, bool background)
    {
        if (color < 0) return;
        if ((color & TrueColor) != 0)
        {
            var rgb = color & 0xFFFFFF;
            sb.Append(background ? ";48;2;" : ";38;2;")
              .Append((rgb >> 16) & 0xFF).Append(';')
              .Append((rgb >> 8) & 0xFF).Append(';')
              .Append(rgb & 0xFF);
            return;
        }
        if (color < 8) sb.Append(';').Append((background ? 40 : 30) + color);
        else if (color < 16) sb.Append(';').Append((background ? 100 : 90) + color - 8);
        else sb.Append(background ? ";48;5;" : ";38;5;").Append(color);
    }
}
