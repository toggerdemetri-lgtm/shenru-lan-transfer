using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class Lifetime
{
    internal static string HomePath()
    {
        var home = Environment.GetEnvironmentVariable("SHENRU_HOME");
        return Path.GetFullPath(String.IsNullOrEmpty(home) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Shenru") : home);
    }
    internal static string MutexName(string home)
    {
        using (var sha = SHA256.Create()) return "Local\\Shenru-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(home.ToLowerInvariant()))).Replace("-", "").ToLowerInvariant().Substring(0, 20);
    }
    internal static string StopName(string home) { return MutexName(home) + "-stop"; }
    internal static bool RequestStop(string home)
    {
        EventWaitHandle signal;
        if (!EventWaitHandle.TryOpenExisting(StopName(home), out signal)) return false;
        using (signal) signal.Set();
        return true;
    }
}
