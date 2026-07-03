using System.Collections.Concurrent;
using System.Text;

namespace ClaudeWeb.Server.Logging;

/// <summary>
/// Tiny append-only file logger. The tray build runs without a console, so this keeps a
/// diagnostic trail (session launches, errors) in a log file the user can open.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly string _path;
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, FileLogger> _loggers = new();

    public FileLoggerProvider(string path)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    }

    public ILogger CreateLogger(string categoryName) =>
        _loggers.GetOrAdd(categoryName, name => new FileLogger(this, name));

    internal void Write(string category, LogLevel level, string message, Exception? ex)
    {
        var sb = new StringBuilder()
            .Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff"))
            .Append(" [").Append(level).Append("] ")
            .Append(category).Append(" - ").Append(message);
        if (ex is not null) sb.Append('\n').Append(ex);
        sb.Append('\n');

        lock (_gate)
        {
            try { File.AppendAllText(_path, sb.ToString()); } catch { /* best effort */ }
        }
    }

    public void Dispose() { }

    private sealed class FileLogger(FileLoggerProvider provider, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            provider.Write(category, logLevel, formatter(state, exception), exception);
        }
    }
}
