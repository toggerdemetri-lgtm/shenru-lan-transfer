using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// All shell integration is owned by the framework's NotifyIcon on one STA thread.
// No injected hooks, native delegates, or window-procedure subclassing.
internal sealed class TrayHost : IDisposable
{
    private readonly Thread thread;
    private readonly ManualResetEvent ready = new ManualResetEvent(false);
    private Control dispatcher;
    private TrayContext context;
    private volatile Exception failure;
    private bool disposed;
    internal Exception Failure { get { return failure; } }

    internal TrayHost(Action open, Action stop, string mode)
    {
        thread = new Thread(delegate() {
            try {
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                using (var ui = new TrayContext(open, stop, mode)) {
                    context = ui; dispatcher = ui.Dispatcher;
                    ready.Set(); Application.Run(ui);
                }
            } catch (Exception error) { failure = error; ready.Set(); try { stop(); } catch {} }
            finally { dispatcher = null; context = null; }
        });
        thread.Name = "Shenru system tray"; thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        if (!ready.WaitOne(10000)) throw new Exception("系统托盘启动超时。");
        if (failure != null) throw new Exception("系统托盘启动失败。", failure);
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        var ui = context; var target = dispatcher;
        if (ui != null && target != null) {
            try { target.BeginInvoke(new MethodInvoker(ui.ExitThread)); } catch (InvalidOperationException) {}
        }
        if (thread.Join(5000)) ready.Dispose();
    }

    private sealed class TrayContext : ApplicationContext
    {
        internal readonly Control Dispatcher = new Control();
        private readonly NotifyIcon tray;
        private readonly ContextMenuStrip menu;
        private readonly Icon image;

        internal TrayContext(Action open, Action stop, string mode)
        {
            // Force the marshaling handle to be created on this UI thread.
            var handle = Dispatcher.Handle;
            using (var bytes = Assembly.GetExecutingAssembly().GetManifestResourceStream("shenru.icon"))
            using (var source = new Icon(bytes)) image = (Icon)source.Clone();
            menu = new ContextMenuStrip();
            var opening = new ToolStripMenuItem("打开深入·局域网互传");
            var exit = new ToolStripMenuItem("退出深入·局域网互传");
            opening.Click += delegate { open(); };
            exit.Click += delegate { opening.Enabled = false; exit.Enabled = false; stop(); };
            menu.Items.Add(opening); menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(exit);
            tray = new NotifyIcon { Icon = image, Text = mode == "host" ? "深入·局域网互传 · 本机提供服务" : "深入·局域网互传 · 已加入空间", ContextMenuStrip = menu };
            tray.DoubleClick += delegate { open(); };
            tray.Visible = true;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) {
                if (tray != null) { tray.Visible = false; tray.Dispose(); }
                if (menu != null) menu.Dispose();
                if (image != null) image.Dispose();
                Dispatcher.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
