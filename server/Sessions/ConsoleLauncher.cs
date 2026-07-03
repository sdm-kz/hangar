using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// Launches a console program in its OWN new console (CREATE_NEW_CONSOLE) with no redirected
/// stdio. This is what lets the interactive <c>claude</c> TUI detect a real terminal and enable
/// Remote Control. When the host is a Windows service (session 0) the console is never visible,
/// so the launched session is effectively headless.
/// </summary>
public static class ConsoleLauncher
{
    /// <summary>Starts <paramref name="fileName"/> with <paramref name="arguments"/> and returns the child process id.</summary>
    public static int Start(string fileName, IReadOnlyList<string> arguments, string workingDirectory)
    {
        var commandLine = BuildCommandLine(fileName, arguments);

        var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        var pi = new PROCESS_INFORMATION();

        // CREATE_NEW_CONSOLE gives the child a real console (a TTY); CREATE_UNICODE_ENVIRONMENT
        // is unset because we inherit the parent environment (lpEnvironment = NULL).
        bool ok = CreateProcess(
            null,
            commandLine,
            IntPtr.Zero, IntPtr.Zero,
            false,
            CREATE_NEW_CONSOLE,
            IntPtr.Zero,
            string.IsNullOrWhiteSpace(workingDirectory) ? null : workingDirectory,
            ref si,
            out pi);

        if (!ok)
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"CreateProcess failed for: {commandLine}");

        try
        {
            return pi.dwProcessId;
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        }
    }

    // Quote the executable and each argument per the Windows command-line convention.
    private static string BuildCommandLine(string fileName, IReadOnlyList<string> args)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(Quote(fileName));
        foreach (var a in args)
        {
            sb.Append(' ');
            sb.Append(Quote(a));
        }
        return sb.ToString();
    }

    private static string Quote(string s)
    {
        if (s.Length > 0 && !s.Contains(' ') && !s.Contains('"') && !s.Contains('\t'))
            return s;
        var sb = new System.Text.StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (var c in s)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1); backslashes = 0; sb.Append('"'); continue; }
            if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private const uint CREATE_NEW_CONSOLE = 0x00000010;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
}
