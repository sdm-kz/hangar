using System.Globalization;

namespace Hangar.Pty;

/// <summary>
/// How many cells a character occupies — the one thing a terminal has to agree with its emulator
/// about, because every column after it depends on the answer. This is wcwidth's rule: combining
/// marks and the invisible formatting characters take none, East Asian Wide and Fullwidth (and the
/// emoji that behave like them) take two, everything else takes one.
/// </summary>
/// <remarks>
/// Ranges rather than a generated table: the table would be tens of kilobytes to settle arguments
/// about characters a terminal session will not contain, and the ranges below are the ones the
/// Unicode standard itself lists as Wide or Fullwidth. Combining marks are asked of
/// <see cref="CharUnicodeInfo"/>, whose data ships with the runtime and is unaffected by the
/// invariant-globalization switch the pty host builds with.
/// </remarks>
public static class CharWidth
{
    public static int Of(int rune)
    {
        if (rune < 0x80) return rune is >= 0x20 and < 0x7F ? 1 : 0; // ASCII, controls excluded
        if (IsZeroWidth(rune)) return 0;
        return IsWide(rune) ? 2 : 1;
    }

    private static bool IsZeroWidth(int rune)
    {
        // The zero-width and directional formatting characters, then the variation selectors.
        if (rune is 0x200B or 0x200C or 0x200D or 0x200E or 0x200F or 0x2060 or 0xFEFF) return true;
        if (rune is >= 0x202A and <= 0x202E) return true;
        if (rune is >= 0xFE00 and <= 0xFE0F) return true;
        if (rune is >= 0xE0100 and <= 0xE01EF) return true;
        if (rune > 0xFFFF) return false; // no combining marks we need beyond the BMP

        var category = CharUnicodeInfo.GetUnicodeCategory((char)rune);
        return category is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark;
    }

    private static bool IsWide(int rune) => rune switch
    {
        >= 0x1100 and <= 0x115F => true,    // Hangul Jamo initial consonants
        0x2329 or 0x232A => true,           // angle brackets
        >= 0x2E80 and <= 0x303E => true,    // CJK radicals, Kangxi, CJK symbols
        >= 0x3041 and <= 0x33FF => true,    // kana, Bopomofo, compatibility
        >= 0x3400 and <= 0x4DBF => true,    // CJK extension A
        >= 0x4E00 and <= 0x9FFF => true,    // CJK unified ideographs
        >= 0xA000 and <= 0xA4CF => true,    // Yi
        >= 0xA960 and <= 0xA97F => true,    // Hangul Jamo extended A
        >= 0xAC00 and <= 0xD7A3 => true,    // Hangul syllables
        >= 0xF900 and <= 0xFAFF => true,    // CJK compatibility ideographs
        >= 0xFE10 and <= 0xFE19 => true,    // vertical forms
        >= 0xFE30 and <= 0xFE6F => true,    // CJK compatibility forms
        >= 0xFF00 and <= 0xFF60 => true,    // fullwidth forms
        >= 0xFFE0 and <= 0xFFE6 => true,    // fullwidth signs
        >= 0x1F300 and <= 0x1F64F => true,  // pictographs and emoticons
        >= 0x1F680 and <= 0x1F6FF => true,  // transport and map symbols
        >= 0x1F900 and <= 0x1F9FF => true,  // supplemental symbols and pictographs
        >= 0x1FA70 and <= 0x1FAFF => true,  // symbols and pictographs extended A
        >= 0x20000 and <= 0x3FFFD => true,  // CJK extensions B and beyond
        _ => false,
    };
}
