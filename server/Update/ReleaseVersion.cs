using System.Text.RegularExpressions;

namespace Hangar.Server.Update;

/// <summary>
/// A release's version as its tag spells it ("v1.2.3", "v1.2.3-rc.1"), ordered the semver way: a
/// prerelease comes before its release, and its identifiers compare numerically where they are numbers.
/// Build metadata ("+abc") is accepted and ignored, as semver says.
/// </summary>
public sealed partial record ReleaseVersion(int Major, int Minor, int Patch, string[] Prerelease) : IComparable<ReleaseVersion>
{
    [GeneratedRegex(@"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")]
    private static partial Regex Pattern();

    public static ReleaseVersion? TryParse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var m = Pattern().Match(text.Trim());
        if (!m.Success) return null;
        if (!int.TryParse(m.Groups[1].Value, out var major) || !int.TryParse(m.Groups[2].Value, out var minor)
            || !int.TryParse(m.Groups[3].Value, out var patch))
            return null;
        var pre = m.Groups[4].Success ? m.Groups[4].Value.Split('.') : [];
        return new ReleaseVersion(major, minor, patch, pre);
    }

    public int CompareTo(ReleaseVersion? other)
    {
        if (other is null) return 1;
        var c = Major.CompareTo(other.Major);
        if (c == 0) c = Minor.CompareTo(other.Minor);
        if (c == 0) c = Patch.CompareTo(other.Patch);
        if (c != 0) return c;
        // A release is newer than any of its prereleases.
        if (Prerelease.Length == 0) return other.Prerelease.Length == 0 ? 0 : 1;
        if (other.Prerelease.Length == 0) return -1;
        for (var i = 0; i < Math.Min(Prerelease.Length, other.Prerelease.Length); i++)
        {
            var a = Prerelease[i];
            var b = other.Prerelease[i];
            var aNum = int.TryParse(a, out var an);
            var bNum = int.TryParse(b, out var bn);
            c = (aNum, bNum) switch
            {
                (true, true) => an.CompareTo(bn),
                (true, false) => -1, // numbers come before words
                (false, true) => 1,
                _ => string.CompareOrdinal(a, b),
            };
            if (c != 0) return c;
        }
        return Prerelease.Length.CompareTo(other.Prerelease.Length);
    }

    public bool IsPrerelease => Prerelease.Length > 0;

    public override string ToString() =>
        $"{Major}.{Minor}.{Patch}" + (Prerelease.Length > 0 ? "-" + string.Join('.', Prerelease) : "");

    // Records compare arrays by reference; versions are equal when they order the same.
    public bool Equals(ReleaseVersion? other) => other is not null && CompareTo(other) == 0;
    public override int GetHashCode() => ToString().GetHashCode();

    public static bool operator >(ReleaseVersion a, ReleaseVersion b) => a.CompareTo(b) > 0;
    public static bool operator <(ReleaseVersion a, ReleaseVersion b) => a.CompareTo(b) < 0;
    public static bool operator >=(ReleaseVersion a, ReleaseVersion b) => a.CompareTo(b) >= 0;
    public static bool operator <=(ReleaseVersion a, ReleaseVersion b) => a.CompareTo(b) <= 0;
}
