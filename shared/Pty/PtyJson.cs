using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hangar.Pty;

/// <summary>
/// Source-generated serializers for everything that crosses between the web app and a pty host.
/// </summary>
/// <remarks>
/// Not a nicety: <c>Hangar.PtyHost.exe</c> publishes <b>trimmed</b> (13 MB rather than 70), and
/// reflection-based <c>JsonSerializer</c> is not trim-safe — the trimmer would quietly drop the
/// record properties nothing appears to reference, and the two processes would stop understanding
/// each other at runtime with no build-time signal. Going through a context makes every one of these
/// types statically reachable. The web app isn't trimmed and doesn't need this, but it compiles the
/// same files, so both ends stay on the identical serializer by construction.
/// </remarks>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(PtyControl))]
[JsonSerializable(typeof(PtyState))]
[JsonSerializable(typeof(PtySpawnRequest))]
internal sealed partial class PtyJsonContext : JsonSerializerContext;

/// <summary>The same contract, indented — used for the files a human may have to read.</summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = true)]
[JsonSerializable(typeof(PtyState))]
[JsonSerializable(typeof(PtySpawnRequest))]
internal sealed partial class PtyJsonFileContext : JsonSerializerContext;
