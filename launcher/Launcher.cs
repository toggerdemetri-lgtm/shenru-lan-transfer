using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
[assembly: AssemblyTitle("深入·局域网互传")]
[assembly: AssemblyProduct("深入·局域网互传")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]
internal static class Program
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static EventWaitHandle StopRequested;
    private static readonly bool NoBrowser = Environment.GetEnvironmentVariable("SHENRU_NO_BROWSER") == "1";
    private static string Home, SessionPath, EntryPath;
    private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    private static string ReadResource(string name) { using (var r = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream(name))) return r.ReadToEnd(); }
    private static void OpenUrl(string url)
    {
        Uri parsed; System.Net.IPAddress address;
        if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != "http" || !String.IsNullOrEmpty(parsed.UserInfo) || !System.Net.IPAddress.TryParse(parsed.Host, out address)) throw new Exception("空间地址无效");
        if (!NoBrowser) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
    private static int Main(string[] args)
    {
        Mutex mutex = null; bool acquired = false;
        try {
            Home = Lifetime.HomePath(); Directory.CreateDirectory(Home);
            if (Array.IndexOf(args, "--stop") >= 0) { Lifetime.RequestStop(Home); return 0; }
            SessionPath = Path.Combine(Home, "session.json");
            EntryPath = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "深入·局域网互传.html");
            mutex = new Mutex(false, Lifetime.MutexName(Home));
            try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) {
                for (int i = 0; i < 150; i++) {
                    try {
                        var data = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SessionPath)); OpenUrl((string)data["url"]);
                        var original = (string)data["entryPath"];
                        if (!String.Equals(original, EntryPath, StringComparison.OrdinalIgnoreCase)) try { File.Copy(original, EntryPath, true); } catch {}
                        return 0;
                    } catch { Thread.Sleep(200); }
                }
                throw new Exception("深入·局域网互传正在启动，请稍后重试。");
            }
            if (File.Exists(SessionPath)) File.Delete(SessionPath);
            StopRequested = new EventWaitHandle(false, EventResetMode.ManualReset, Lifetime.StopName(Home));
            StopRequested.Reset();
            return RunService(Prepare());
        } catch (Exception e) {
            try { if (Home != null) File.WriteAllText(Path.Combine(Home, "last-error.txt"), e.ToString(), new UTF8Encoding(false)); } catch {}
            if (!NoBrowser) ShowNotice("深入·局域网互传启动失败", e.Message);
            return 1;
        } finally { if (acquired) mutex.ReleaseMutex(); if (mutex != null) mutex.Dispose(); }
    }
    private static ProcessStartInfo ChildStartInfo(string version)
    {
        var settings = new Dictionary<string, object> { { "dataDir", Path.Combine(Home, "data") }, { "entryPath", EntryPath }, { "resultPath", SessionPath } };
        int number;
        if (Int32.TryParse(Environment.GetEnvironmentVariable("SHENRU_PORT"), out number)) settings["port"] = number;
        if (Int32.TryParse(Environment.GetEnvironmentVariable("SHENRU_DISCOVERY_PORT"), out number)) settings["discoveryPort"] = number;
        var settingsPath = Path.Combine(Home, "launch.json"); File.WriteAllText(settingsPath, Json.Serialize(settings), new UTF8Encoding(false));
        return new ProcessStartInfo(Path.Combine(version, "runtime", "node.exe"), "\"" + Path.Combine(version, "portable.mjs") + "\" \"" + settingsPath + "\"") {
            WorkingDirectory = version, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
    }
    private static int RunService(string version)
    {
        using (var ready = new ManualResetEvent(false))
        using (var exited = new ManualResetEvent(false))
        using (var child = new Process { StartInfo = ChildStartInfo(version), EnableRaisingEvents = true }) {
            Dictionary<string, object> result = null; var log = new StringBuilder(); bool closing = false; var lifetimeGate = new object();
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) {
                try { var data = Json.Deserialize<Dictionary<string, object>>(e.Data); lock (lifetimeGate) { if (!closing && data.ContainsKey("url")) { result = data; ready.Set(); } } } catch {}
            } };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (log) { if (log.Length < 12000) log.AppendLine(e.Data); } };
            child.Exited += delegate { lock (lifetimeGate) { if (!closing) exited.Set(); } };
            child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine(); Timer timer = null; TrayHost tray = null;
            try {
                int wait = WaitHandle.WaitAny(new WaitHandle[] { ready, exited, StopRequested }, 30000);
                if (wait == 2) return 0;
                if (wait != 0 || result == null) throw new Exception(child.HasExited ? "连接进程提前退出：" + log : "启动超时，请检查网络权限。");
                var url = (string)result["url"];
                var mode = (string)result["mode"];
                tray = new TrayHost(delegate {
                    try { OpenUrl(url); } catch (Exception error) { ShowNotice("深入·局域网互传 · 打开空间", error.Message + "\n空间地址：" + url); }
                }, delegate { StopRequested.Set(); }, mode);
                File.WriteAllText(Path.Combine(Home, "tray-ready.json"), Json.Serialize(new Dictionary<string, object> {
                    { "pid", Process.GetCurrentProcess().Id }, { "mode", mode }, { "backend", "NotifyIcon" }, { "menu", new string[] { "打开深入·局域网互传", "退出深入·局域网互传" } }
                }), new UTF8Encoding(false));
                var warning = (string)result["warning"];
                if (!String.IsNullOrEmpty(warning)) { File.WriteAllText(Path.Combine(Home, "last-warning.txt"), warning); if (!NoBrowser) ShowNotice("深入·局域网互传 · 连接提示", warning); }
                try { OpenUrl(url); } catch { if (!NoBrowser) ShowNotice("深入·局域网互传已在后台运行", "请在浏览器打开空间地址：" + url); }
                int delay;
                if (Int32.TryParse(Environment.GetEnvironmentVariable("SHENRU_AUTO_EXIT_MS"), out delay) && delay > 0) timer = new Timer(_ => StopRequested.Set(), null, delay, Timeout.Infinite);
                if (WaitHandle.WaitAny(new WaitHandle[] { StopRequested, exited }) == 1) throw new Exception("空间进程已退出：" + log);
                if (tray.Failure != null) throw new Exception("系统托盘意外退出。", tray.Failure);
            } finally {
                lock (lifetimeGate) { closing = true; } if (timer != null) timer.Dispose();
                if (tray != null) tray.Dispose();
                try { File.Delete(Path.Combine(Home, "tray-ready.json")); } catch {}
                if (!child.HasExited) try { child.StandardInput.WriteLine("stop"); child.StandardInput.Flush(); if (!child.WaitForExit(10000)) child.Kill(); } catch {}
                child.WaitForExit(); try { File.Delete(SessionPath); } catch {}
            }
            return child.ExitCode;
        }
    }
    private static void ShowNotice(string title, string message)
    {
        try {
            var html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + System.Net.WebUtility.HtmlEncode(title) + "</title><body style=\"background:#0f1c2c;color:#dceefa;font:16px/1.9 Segoe UI,sans-serif;padding:48px;max-width:760px;margin:auto\"><h1>" + System.Net.WebUtility.HtmlEncode(title) + "</h1><p style=\"white-space:pre-wrap\">" + System.Net.WebUtility.HtmlEncode(message) + "</p><p>右下角深入·局域网互传托盘菜单提供“打开深入·局域网互传”和“退出深入·局域网互传”；图标可能收纳在系统的隐藏图标区域。</p></body></html>";
            var file = Path.Combine(Home, "启动提示.html"); File.WriteAllText(file, html, new UTF8Encoding(false));
            Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
        } catch {}
    }
    private static string Prepare()
    {
        var expected = ReadResource("shenru.build").Trim();
        var version = Path.Combine(Home, "versions", expected.Substring(0, 20));
        if (File.Exists(Path.Combine(version, ".ready")) && File.ReadAllText(Path.Combine(version, ".ready")) == expected && File.Exists(Path.Combine(version, "runtime", "node.exe"))) return version;
        var staging = version + "-extract-" + Process.GetCurrentProcess().Id;
        Directory.CreateDirectory(staging);
        using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("shenru.payload"))
        using (var memory = new MemoryStream())
        {
            source.CopyTo(memory);
            if (Hash(memory.ToArray()) != expected) throw new Exception("程序资源校验失败，请重新获取压缩包。");
            memory.Position = 0;
            using (var archive = new ZipArchive(memory, ZipArchiveMode.Read))
            {
                foreach (var entry in archive.Entries)
                {
                    var file = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                    if (!file.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("资源路径无效");
                    if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(file); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    using (var input = entry.Open()) using (var output = File.Create(file)) input.CopyTo(output);
                }
            }
        }
        foreach (var line in File.ReadAllLines(Path.Combine(staging, "SHA256SUMS.txt")))
        {
            int separator = line.IndexOf("  ", StringComparison.Ordinal);
            if (separator < 0) continue;
            var relative = line.Substring(separator + 2).Replace('/', Path.DirectorySeparatorChar);
            var file = Path.GetFullPath(Path.Combine(staging, relative));
            if (!file.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || Hash(File.ReadAllBytes(file)) != line.Substring(0, separator)) throw new Exception("程序文件校验失败：" + relative);
        }
        File.WriteAllText(Path.Combine(staging, ".ready"), expected);
        if (Directory.Exists(version)) throw new Exception("缓存资源不完整，请关闭深入·局域网互传并重命名此目录后重试：" + version);
        Directory.Move(staging, version);
        return version;
    }
}
