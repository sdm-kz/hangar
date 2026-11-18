using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hangar.Server.Widgets;

/// <summary>
/// The part of JSON Schema the widget format uses, and nothing more: <c>type</c>, <c>enum</c>,
/// <c>const</c>, <c>properties</c>, <c>required</c>, <c>additionalProperties</c>, <c>items</c>,
/// <c>pattern</c>, <c>minLength</c>/<c>maxLength</c>, <c>minimum</c>/<c>maximum</c>,
/// <c>minItems</c>/<c>maxItems</c>, and <c>$ref</c> to <c>#/$defs/…</c>. Anything else in a schema
/// (<c>description</c>, <c>default</c>, <c>title</c>) is read past.
/// </summary>
/// <remarks>
/// It exists so that the schema handed to Claude in the guide (<c>GET /api/self/widgets/guide</c>) is
/// the very document a write is checked against — a hand-written validator beside a hand-written schema
/// would drift apart the first time one of them changed. A library would do the same job, but this is
/// the whole of what is needed, and the same few rules also check a widget's params and its actions'
/// arguments, which are written in the same subset.
/// </remarks>
public static class MiniSchema
{
    public sealed record Error(string Path, string Message);

    /// <summary>Every way <paramref name="value"/> falls short of <paramref name="schema"/>, by JSON Pointer.</summary>
    public static List<Error> Validate(JsonElement schema, JsonElement value)
    {
        var errors = new List<Error>();
        Check(schema, value, "", schema, errors);
        return errors;
    }

    private static void Check(JsonElement schema, JsonElement value, string path, JsonElement root, List<Error> errors)
    {
        if (schema.ValueKind == JsonValueKind.True) return;
        if (schema.ValueKind == JsonValueKind.False) { errors.Add(new(path, "is not allowed here")); return; }
        if (schema.ValueKind != JsonValueKind.Object) return;

        if (schema.TryGetProperty("$ref", out var r) && r.GetString() is { } refPath)
        {
            if (Resolve(root, refPath) is { } target) Check(target, value, path, root, errors);
            else errors.Add(new(path, $"schema reference {refPath} does not resolve"));
            return;
        }

        if (schema.TryGetProperty("type", out var type) && !MatchesType(type, value))
        {
            errors.Add(new(path, $"must be {Describe(type)}, got {KindName(value)}"));
            return; // the rest are about a value of the right type
        }

        if (schema.TryGetProperty("const", out var constant) && !JsonEquals(constant, value))
            errors.Add(new(path, $"must be {constant.GetRawText()}"));

        if (schema.TryGetProperty("enum", out var options) && options.ValueKind == JsonValueKind.Array
            && !options.EnumerateArray().Any(o => JsonEquals(o, value)))
            errors.Add(new(path, $"must be one of {string.Join(", ", options.EnumerateArray().Select(o => o.GetRawText()))}; got {Short(value)}"));

        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var s = value.GetString()!;
                if (Int(schema, "minLength") is { } minLen && s.Length < minLen)
                    errors.Add(new(path, $"must be at least {minLen} characters"));
                if (Int(schema, "maxLength") is { } maxLen && s.Length > maxLen)
                    errors.Add(new(path, $"must be at most {maxLen} characters (is {s.Length})"));
                if (schema.TryGetProperty("pattern", out var pattern) && pattern.GetString() is { } p && !Matches(p, s))
                    errors.Add(new(path, $"must match /{p}/; got {Short(value)}"));
                break;

            case JsonValueKind.Number:
                var n = value.GetDouble();
                if (Num(schema, "minimum") is { } min && n < min) errors.Add(new(path, $"must be at least {Fmt(min)}"));
                if (Num(schema, "maximum") is { } max && n > max) errors.Add(new(path, $"must be at most {Fmt(max)}"));
                break;

            case JsonValueKind.Array:
                var count = value.GetArrayLength();
                if (Int(schema, "minItems") is { } minItems && count < minItems)
                    errors.Add(new(path, $"must have at least {minItems} item{(minItems == 1 ? "" : "s")}"));
                if (Int(schema, "maxItems") is { } maxItems && count > maxItems)
                    errors.Add(new(path, $"must have at most {maxItems} items (has {count})"));
                if (schema.TryGetProperty("items", out var items))
                {
                    var i = 0;
                    foreach (var item in value.EnumerateArray()) Check(items, item, $"{path}/{i++}", root, errors);
                }
                break;

            case JsonValueKind.Object:
                if (schema.TryGetProperty("required", out var required) && required.ValueKind == JsonValueKind.Array)
                    foreach (var name in required.EnumerateArray().Select(x => x.GetString()).OfType<string>())
                        if (!value.TryGetProperty(name, out _)) errors.Add(new($"{path}/{name}", "is required"));

                schema.TryGetProperty("properties", out var props);
                schema.TryGetProperty("additionalProperties", out var extra);
                foreach (var prop in value.EnumerateObject())
                {
                    var at = $"{path}/{Escape(prop.Name)}";
                    if (props.ValueKind == JsonValueKind.Object && props.TryGetProperty(prop.Name, out var sub))
                        Check(sub, prop.Value, at, root, errors);
                    else if (extra.ValueKind == JsonValueKind.False)
                        errors.Add(new(at, KnownNames(props) is { Length: > 0 } known
                            ? $"is not a known property (known: {known})"
                            : "is not a known property"));
                    else if (extra.ValueKind == JsonValueKind.Object)
                        Check(extra, prop.Value, at, root, errors);
                }
                break;
        }
    }

    /// <summary>Whether <paramref name="text"/> matches a schema pattern, which (as in JSON Schema) is a search, not anchored.</summary>
    public static bool Matches(string pattern, string text)
    {
        try { return Regex.IsMatch(text, pattern, RegexOptions.None, TimeSpan.FromMilliseconds(200)); }
        catch (ArgumentException) { return false; }
        catch (RegexMatchTimeoutException) { return false; }
    }

    /// <summary>The first match of a schema pattern in <paramref name="text"/>, or null.</summary>
    public static string? FirstMatch(string pattern, string text)
    {
        try
        {
            var m = Regex.Match(text, pattern, RegexOptions.None, TimeSpan.FromMilliseconds(200));
            return m.Success && m.Length > 0 ? m.Value : null;
        }
        catch (ArgumentException) { return null; }
        catch (RegexMatchTimeoutException) { return null; }
    }

    /// <summary>Whether a pattern compiles at all — checked on write, so a bad one is reported where it was written.</summary>
    public static string? PatternError(string pattern)
    {
        try { _ = new Regex(pattern, RegexOptions.None, TimeSpan.FromMilliseconds(200)); return null; }
        catch (ArgumentException ex) { return ex.Message; }
    }

    private static JsonElement? Resolve(JsonElement root, string reference)
    {
        if (!reference.StartsWith("#/", StringComparison.Ordinal)) return null;
        var at = root;
        foreach (var part in reference[2..].Split('/'))
        {
            var name = part.Replace("~1", "/").Replace("~0", "~");
            if (at.ValueKind != JsonValueKind.Object || !at.TryGetProperty(name, out at)) return null;
        }
        return at;
    }

    private static bool MatchesType(JsonElement type, JsonElement value) => type.ValueKind switch
    {
        JsonValueKind.String => IsType(type.GetString()!, value),
        JsonValueKind.Array => type.EnumerateArray().Any(t => t.GetString() is { } name && IsType(name, value)),
        _ => true,
    };

    private static bool IsType(string type, JsonElement value) => type switch
    {
        "string" => value.ValueKind == JsonValueKind.String,
        "number" => value.ValueKind == JsonValueKind.Number,
        "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
        "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "object" => value.ValueKind == JsonValueKind.Object,
        "array" => value.ValueKind == JsonValueKind.Array,
        "null" => value.ValueKind == JsonValueKind.Null,
        _ => true,
    };

    private static string Describe(JsonElement type) => type.ValueKind == JsonValueKind.Array
        ? string.Join(" or ", type.EnumerateArray().Select(t => Article(t.GetString() ?? "")))
        : Article(type.GetString() ?? "");

    private static string Article(string type) => type switch
    {
        "integer" or "object" or "array" => $"an {type}",
        "null" => "null",
        _ => $"a {type}",
    };

    private static string KindName(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => "a string",
        JsonValueKind.Number => value.TryGetInt64(out _) ? "an integer" : "a number",
        JsonValueKind.True or JsonValueKind.False => "a boolean",
        JsonValueKind.Object => "an object",
        JsonValueKind.Array => "an array",
        JsonValueKind.Null => "null",
        _ => "nothing",
    };

    private static string KnownNames(JsonElement props) => props.ValueKind == JsonValueKind.Object
        ? string.Join(", ", props.EnumerateObject().Select(p => p.Name))
        : "";

    private static bool JsonEquals(JsonElement a, JsonElement b)
    {
        if (a.ValueKind == JsonValueKind.Number && b.ValueKind == JsonValueKind.Number) return a.GetDouble() == b.GetDouble();
        return a.ValueKind == b.ValueKind && a.GetRawText() == b.GetRawText();
    }

    private static int? Int(JsonElement schema, string name) =>
        schema.TryGetProperty(name, out var v) && v.TryGetInt32(out var i) ? i : null;

    private static double? Num(JsonElement schema, string name) =>
        schema.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    private static string Fmt(double d) => d.ToString(CultureInfo.InvariantCulture);

    private static string Short(JsonElement value)
    {
        var raw = value.GetRawText();
        return raw.Length > 60 ? raw[..57] + "…" : raw;
    }

    private static string Escape(string name) => name.Replace("~", "~0").Replace("/", "~1");
}
