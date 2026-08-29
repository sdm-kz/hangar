using System.Runtime.Versioning;

// ConPTY, job objects and named-pipe ACLs are all Windows-only, and so is everything this host does.
// Saying so once here keeps the platform analyzer quiet without a blanket NoWarn.
[assembly: SupportedOSPlatform("windows")]
