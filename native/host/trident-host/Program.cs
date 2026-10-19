/*
 * Nova · Trident 原生宿主（trident-host.exe）
 * ==========================================================================
 * 这是一个 C# / .NET Framework 4.x 控制台程序，用 WinForms 的 WebBrowser 控件
 * 承载真实 IE11（Trident / MSHTML），并通过 stdio 上的 NDJSON 协议和 Nova 主进程
 * 通信。协议细节见仓库 native/README.md。
 *
 * 编译（无需 Visual Studio，用系统自带的 csc 即可，见同目录 build-trident.bat）：
 *   csc /nologo /target:exe /platform:x86 /out:trident-host.exe Program.cs
 * 然后把生成的 trident-host.exe 放到仓库的 native/bin/ 下。
 *
 * 为什么是 x86：很多老 ActiveX 控件只有 32 位版本，x86 宿主能加载它们；
 * 系统里 32/64 位 mshtml.dll 都有，WebBrowser 在 x86 进程里用 32 位那支。
 *
 * 注意：本文件刻意只用 C# 5 语法（无表达式体成员、无 out var、无字典索引器
 * 初始化器、无 is 模式匹配），以兼容系统自带的 .NET Framework csc。
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Nova.TridentHost
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // 协议走 UTF-8，避免中文 URL/标题在 stdio 上被 OEM 代码页截断乱码。
            Console.OutputEncoding = new UTF8Encoding(false);

            // 必须在创建任何 WebBrowser 控件之前写入 FEATURE_BROWSER_EMULATION，
            // 否则 WebBrowser 会掉进古老的 IE7 兼容视图，老系统必挂。
            BrowserEmulation.SetEmulation(11001); // 11001 = IE11 edge 模式

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 单例：一个宿主进程服务一个 Nova 会话；多个标签页通过 viewId 区分。
            TridentHost host = new TridentHost();
            host.Run();
        }
    }

    /// <summary>把本 exe 名钉进 FEATURE_BROWSER_EMULATION=11001（HKCU）。</summary>
    internal static class BrowserEmulation
    {
        private const string FEATURE_KEY =
            @"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION";

        private const string LOCKDOWN_KEY =
            @"Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_LOCALMACHINE_LOCKDOWN";

        public static void SetEmulation(int value)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(FEATURE_KEY))
                {
                    if (key != null) key.SetValue(AppExeName(), value, Microsoft.Win32.RegistryValueKind.DWord);
                }
                // 关掉「本地文件锁区」，否则 file:// 打开的内网页面会被 IE 当成高安全区而禁脚本。
                using (Microsoft.Win32.RegistryKey key2 = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(LOCKDOWN_KEY))
                {
                    if (key2 != null) key2.SetValue(AppExeName(), 0, Microsoft.Win32.RegistryValueKind.DWord);
                }
            }
            catch (Exception ex)
            {
                // 注册表写不上也不致命，但宿主会停留在默认文档模式，记一条日志。
                Console.Error.WriteLine("[trident-host] 注册表写入失败：" + ex.Message);
            }
        }

        private static string AppExeName()
        {
            return Path.GetFileName(Application.ExecutablePath);
        }
    }

    /// <summary>
    /// 宿主主体：一个隐藏（离屏）的 WinForms 窗体，内部用 WebBrowser 控件承载真实 IE11。
    /// 支持多个 viewId（每个标签页一个），但同一时刻只有「激活」的那个可见、被抓帧、收输入。
    /// </summary>
    internal sealed class TridentHost : Form
    {
        // ---- 视图状态 ----
        private sealed class View
        {
            public int Id;
            public WebBrowser Browser;
            public int W, H;
            public byte[] LastHash;       // 上一帧 FNV，用于变化检测
            public bool Navigating;       // 正在导航，等待 DocumentCompleted
            public string LastUrl;
        }

        private readonly Dictionary<int, View> _views = new Dictionary<int, View>();
        private int _activeViewId = -1;
        private int _seq = 0;
        private int _autoViewId = 1;

        // ---- 输出（stdout 线程安全）----
        private readonly object _outLock = new object();

        // ---- 帧抓取定时器（STA 线程）----
        private readonly System.Windows.Forms.Timer _frameTimer;

        private readonly Thread _stdinThread;
        private volatile bool _running = true;

        public TridentHost()
        {
            // 必须放在**屏幕内**：Windows 不会为完全离屏的窗口做真实绘制，
            // DrawToBitmap 会一直返回纯白（实测放在 -32000 时，百度只抓到 1 张纯白帧，
            // 而 url/title 事件是正常的 —— 也就是“页面打开了但不显示”）。
            // 用户看不见靠下面三件事：Opacity≈1/255、点击穿透、永远压在最底层。
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(0, 0);
            Size = new Size(1024, 768);
            Opacity = 0.01;
            Visible = false;

            _frameTimer = new System.Windows.Forms.Timer();
            _frameTimer.Interval = 50; // ~20fps 抓帧
            _frameTimer.Tick += new EventHandler(OnFrameTick);
            _frameTimer.Start();

            _stdinThread = new Thread(new ThreadStart(StdinLoop));
            _stdinThread.IsBackground = true;
            _stdinThread.Name = "stdin";
        }

        // 窗口必须在屏幕内才会真正绘制，但又不能让用户看见/点到：
        //   WS_EX_TRANSPARENT  点击穿透（否则会挡住桌面点击）
        //   WS_EX_LAYERED      配合 Opacity 做近乎全透明
        //   WS_EX_NOACTIVATE   显示时不抢焦点
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT
                cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                return cp;
            }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;

        /** 压到所有窗口下面：屏幕内保证会被绘制，同时不遮住浏览器。 */
        private void KeepAtBottom()
        {
            try
            {
                SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch { /* 压不到最底层也不影响抓帧 */ }
        }

        private void OnFrameTick(object sender, EventArgs e)
        {
            CaptureActiveView();
        }

        public void Run()
        {
            _stdinThread.Start();
            // 窗体句柄创建好即视为 ready（此时 WebBrowser 才能被创建）。
            // 注意：必须在收到第一条 create 之前就把 ready 发出，否则和 Nova 主进程
            // 的 host.start()（等 ready 最多 5 秒）相互死等。
            HandleCreated += new EventHandler(OnHandleCreated);
            // 同步强制创建窗口句柄，立刻触发上面的 HandleCreated -> 发 ready。
            this.CreateControl();
            Application.Run(this);
        }

        private void OnHandleCreated(object sender, EventArgs e)
        {
            Dictionary<string, object> readyFields = new Dictionary<string, object>();
            readyFields["kernel"] = "trident";
            readyFields["version"] = "11.0";
            Emit("ready", readyFields);
        }

        // ===================================================================
        //  协议：读 stdin
        // ===================================================================
        private void StdinLoop()
        {
            try
            {
                using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string line;
                    while (_running && (line = reader.ReadLine()) != null)
                    {
                        if (string.IsNullOrWhiteSpace(line)) continue;
                        Dispatch(line);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[trident-host] stdin 读取结束：" + ex.Message);
            }
        }

        private void Dispatch(string line)
        {
            Dictionary<string, object> msg;
            try { msg = Json.Parse(line); }
            catch { return; }
            if (msg == null || !msg.ContainsKey("t")) return;

            string t = msg["t"] as string;
            object id = msg.ContainsKey("id") ? msg["id"] : null;

            // 跨线程投到 STA（控件只能在创建线程访问）。
            Action action = delegate()
            {
                try { HandleCommand(t, id, msg); }
                catch (Exception ex) { ReplyError(id, ex.Message); }
            };
            Invoke(action);
        }

        private void HandleCommand(string t, object id, Dictionary<string, object> msg)
        {
            switch (t)
            {
                case "create":
                    HandleCreate(id, msg);
                    break;
                case "navigate":
                    HandleNavigate(id, msg);
                    break;
                case "resize":
                    HandleResize(id, msg);
                    break;
                case "input":
                    HandleInput(id, msg);
                    break;
                case "eval":
                    HandleEval(id, msg);
                    break;
                case "destroy":
                    HandleDestroy(id, msg);
                    break;
                case "activate":
                    HandleActivate(id, msg);
                    break;
                case "stop":
                    _running = false;
                    try { Invoke(new Action(Application.Exit)); } catch { }
                    ReplyOk(id, null);
                    break;
                default:
                    ReplyError(id, "未知指令：" + t);
                    break;
            }
        }

        // ===================================================================
        //  指令处理
        // ===================================================================
        private void HandleCreate(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", NextViewId()));
            int w = ToInt(msg.GetValueOrDefault("w", 1024));
            int h = ToInt(msg.GetValueOrDefault("h", 768));

            if (_views.ContainsKey(viewId))
            {
                Dictionary<string, object> dup = new Dictionary<string, object>();
                dup["viewId"] = viewId;
                ReplyOk(id, dup);
                return;
            }

            WebBrowser wb = new WebBrowser();
            wb.Dock = DockStyle.Fill;
            wb.ScriptErrorsSuppressed = true;   // 不弹脚本错误框；VBScript/JS 仍照常执行
            wb.IsWebBrowserContextMenuEnabled = false;
            wb.AllowWebBrowserDrop = false;

            View view = new View();
            view.Id = viewId;
            view.Browser = wb;
            view.W = w;
            view.H = h;

            wb.DocumentCompleted += delegate(object s, WebBrowserDocumentCompletedEventArgs e2)
            {
                view.Navigating = false;
                Dictionary<string, object> u = new Dictionary<string, object>();
                u["url"] = SafeUrl(wb);
                EmitFor(view, "url", u);
                Dictionary<string, object> ti = new Dictionary<string, object>();
                ti["title"] = wb.DocumentTitle ?? "";
                EmitFor(view, "title", ti);
            };
            wb.Navigated += delegate(object s, WebBrowserNavigatedEventArgs e2)
            {
                Dictionary<string, object> u = new Dictionary<string, object>();
                u["url"] = SafeUrl(wb);
                EmitFor(view, "url", u);
            };

            Controls.Add(wb);
            _views[viewId] = view;
            Dictionary<string, object> created = new Dictionary<string, object>();
            created["viewId"] = viewId;
            ReplyOk(id, created);
        }

        private void HandleNavigate(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", _activeViewId));
            string url = (msg.GetValueOrDefault("url") as string) ?? "about:blank";
            View view = GetView(viewId);
            if (view == null) { ReplyError(id, "viewId 不存在：" + viewId); return; }

            view.Navigating = true;
            // 让目标成为激活视图（可见、收输入、被抓帧）。
            ActivateView(viewId);
            try { view.Browser.Navigate(url); }
            catch (Exception ex) { ReplyError(id, ex.Message); return; }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["viewId"] = viewId;
            ReplyOk(id, r);
        }

        private void HandleResize(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", _activeViewId));
            int w = ToInt(msg.GetValueOrDefault("w", 1024));
            int h = ToInt(msg.GetValueOrDefault("h", 768));
            View view = GetView(viewId);
            if (view == null) { ReplyError(id, "viewId 不存在：" + viewId); return; }

            view.W = w; view.H = h;
            Size = new Size(w, h);
            if (viewId == _activeViewId) view.Browser.Size = new Size(w, h);
            ReplyOk(id, null);
        }

        private void HandleDestroy(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", -1));
            View view;
            if (_views.TryGetValue(viewId, out view))
            {
                Controls.Remove(view.Browser);
                view.Browser.Dispose();
                _views.Remove(viewId);
                if (_activeViewId == viewId) _activeViewId = -1;
            }
            ReplyOk(id, null);
        }

        private void HandleActivate(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", _activeViewId));
            if (!_views.ContainsKey(viewId)) { ReplyError(id, "viewId 不存在：" + viewId); return; }
            ActivateView(viewId); // 把已有视图的控制提到前台，不重新导航
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["viewId"] = viewId;
            ReplyOk(id, r);
        }

        private void HandleEval(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", _activeViewId));
            string code = (msg.GetValueOrDefault("code") as string) ?? "";
            View view = GetView(viewId);
            if (view == null || view.Browser.Document == null) { ReplyError(id, "视图未就绪"); return; }

            try
            {
                // 用页面里的 eval 执行，结果尽量序列化成字符串。
                object result = view.Browser.Document.InvokeScript("eval", new object[] { code });
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["result"] = result == null ? null : result.ToString();
                ReplyOk(id, r);
            }
            catch (Exception ex) { ReplyError(id, ex.Message); }
        }

        private void HandleInput(object id, Dictionary<string, object> msg)
        {
            int viewId = ToInt(msg.GetValueOrDefault("viewId", _activeViewId));
            View view = GetView(viewId);
            // 只有激活视图真正收输入（渲染进程也只为可见标签页发输入）。
            if (view == null || viewId != _activeViewId || view.Browser.Handle == IntPtr.Zero)
            {
                ReplyError(id, "目标视图不可接收输入");
                return;
            }
            Input.Dispatch(view.Browser.Handle, msg);
            ReplyOk(id, null);
        }

        // ===================================================================
        //  视图激活 & 帧抓取
        // ===================================================================
        private void ActivateView(int viewId)
        {
            if (_activeViewId == viewId) return;
            View prev = null;
            if (_activeViewId != -1 && _views.TryGetValue(_activeViewId, out prev))
            {
                prev.Browser.Visible = false;
                prev.Browser.SendToBack();
            }
            View view = null;
            if (_views.TryGetValue(viewId, out view))
            {
                view.Browser.Size = new Size(view.W, view.H);
                view.Browser.Visible = true;
                view.Browser.BringToFront();
                _activeViewId = viewId;
                Visible = true;
                KeepAtBottom();
            }
        }

        private void CaptureActiveView()
        {
            if (_activeViewId == -1) return;
            View view = null;
            if (!_views.TryGetValue(_activeViewId, out view)) return;
            if (view.Browser.Handle == IntPtr.Zero || !view.Browser.Visible) return;

            try
            {
                int w = view.W, h = view.H;
                if (w <= 0 || h <= 0) return;
                using (Bitmap bmp = new Bitmap(w, h))
                {
                    // DrawToBitmap 抓的是控件自身的软件渲染；IE11 在 WebBrowser 控件里默认走软件渲染，可行。
                    view.Browser.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                    int bw = 0, bh = 0;
                    byte[] bytes = BgraUtil.ExtractBgraTopDown(bmp, out bw, out bh);
                    if (bytes == null) return;

                    byte[] hash = Fnv1a.Hash(bytes);
                    if (view.LastHash != null && BgraUtil.EqualHash(view.LastHash, hash)) return; // 没变化，跳过
                    view.LastHash = hash;

                    string data = Convert.ToBase64String(bytes);
                    Dictionary<string, object> frameFields = new Dictionary<string, object>();
                    frameFields["viewId"] = view.Id;
                    frameFields["seq"] = ++_seq;
                    frameFields["w"] = bw;
                    frameFields["h"] = bh;
                    frameFields["format"] = "bgra";
                    frameFields["data"] = data;
                    Emit("frame", frameFields);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[trident-host] 抓帧失败：" + ex.Message);
            }
        }

        // ===================================================================
        //  输出（线程安全）
        // ===================================================================
        private void Emit(string t, Dictionary<string, object> fields)
        {
            Dictionary<string, object> obj = new Dictionary<string, object>();
            obj["t"] = t;
            if (fields != null) foreach (KeyValuePair<string, object> kv in fields) obj[kv.Key] = kv.Value;
            string line = Json.Stringify(obj);
            lock (_outLock)
            {
                Console.Out.Write(line);
                Console.Out.Write("\n");
                Console.Out.Flush();
            }
        }

        private void EmitFor(View view, string t, Dictionary<string, object> fields)
        {
            fields = fields ?? new Dictionary<string, object>();
            fields["viewId"] = view.Id;
            Emit(t, fields);
        }

        private void ReplyOk(object id, Dictionary<string, object> extra)
        {
            Dictionary<string, object> fields = new Dictionary<string, object>();
            fields["ok"] = true;
            if (extra != null) foreach (KeyValuePair<string, object> kv in extra) fields[kv.Key] = kv.Value;
            if (id != null) fields["id"] = id;
            Emit("reply", fields);
        }

        private void ReplyError(object id, string message)
        {
            Dictionary<string, object> fields = new Dictionary<string, object>();
            fields["ok"] = false;
            fields["message"] = message;
            if (id != null) fields["id"] = id;
            Emit("reply", fields);
        }

        // ===================================================================
        //  小工具
        // ===================================================================
        private View GetView(int viewId)
        {
            View v = null;
            if (_views.TryGetValue(viewId, out v)) return v;
            return null;
        }

        private int NextViewId()
        {
            int id = _autoViewId;
            _autoViewId++;
            return id;
        }

        private static string SafeUrl(WebBrowser wb)
        {
            try { return wb.Url != null ? wb.Url.ToString() : ""; }
            catch { return ""; }
        }

        private static int ToInt(object o, int def)
        {
            if (o == null) return def;
            if (o is int) { int i = (int)o; return i; }
            if (o is long) { long l = (long)o; return (int)l; }
            if (o is double) { double d = (double)o; return (int)d; }
            if (o is float) { float f = (float)o; return (int)f; }
            int r = 0;
            if (int.TryParse(o.ToString(), out r)) return r;
            return def;
        }

        private static int ToInt(object o)
        {
            return ToInt(o, 0);
        }
    }

    /// <summary>把 WinForms 控件的输入事件（鼠标/键盘/滚轮/文本）投递到目标 HWND。</summary>
    internal static class Input
    {
        private const int WM_MOUSEMOVE = 0x0200;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_LBUTTONUP = 0x0202;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int WM_RBUTTONUP = 0x0205;
        private const int WM_MOUSEWHEEL = 0x020A;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_CHAR = 0x0102;

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private static readonly Dictionary<string, int> VkMap = MakeVkMap();

        private static Dictionary<string, int> MakeVkMap()
        {
            Dictionary<string, int> m = new Dictionary<string, int>();
            m["Enter"] = 0x0D; m["Return"] = 0x0D; m["Tab"] = 0x09; m["Backspace"] = 0x08;
            m["Delete"] = 0x2E; m["Escape"] = 0x1B; m["Esc"] = 0x1B; m["Space"] = 0x20;
            m["Home"] = 0x24; m["End"] = 0x23; m["PageUp"] = 0x21; m["PageDown"] = 0x22;
            m["Left"] = 0x25; m["Up"] = 0x26; m["Right"] = 0x27; m["Down"] = 0x28;
            m["F1"] = 0x70; m["F2"] = 0x71; m["F3"] = 0x72; m["F4"] = 0x73; m["F5"] = 0x74;
            m["F6"] = 0x75; m["F7"] = 0x76; m["F8"] = 0x77; m["F9"] = 0x78; m["F10"] = 0x79;
            m["F11"] = 0x7A; m["F12"] = 0x7B;
            return m;
        }

        public static void Dispatch(IntPtr hwnd, Dictionary<string, object> msg)
        {
            string kind = (msg.GetValueOrDefault("kind") as string) ?? "mouse";
            switch (kind)
            {
                case "mouse":
                    int x = ToInt(msg.GetValueOrDefault("x"));
                    int y = ToInt(msg.GetValueOrDefault("y"));
                    string type = (msg.GetValueOrDefault("type") as string) ?? "move";
                    string button = (msg.GetValueOrDefault("button") as string) ?? "left";
                    IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
                    if (type == "move") Post(hwnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
                    else if (type == "down") Post(hwnd, button == "right" ? WM_RBUTTONDOWN : WM_LBUTTONDOWN, IntPtr.Zero, lp);
                    else if (type == "up") Post(hwnd, button == "right" ? WM_RBUTTONUP : WM_LBUTTONUP, IntPtr.Zero, lp);
                    break;
                case "wheel":
                    int dx = ToInt(msg.GetValueOrDefault("deltaX"));
                    int dy = ToInt(msg.GetValueOrDefault("deltaY"));
                    IntPtr wp = (IntPtr)((dy << 16) | (dx & 0xFFFF));
                    Post(hwnd, WM_MOUSEWHEEL, wp, IntPtr.Zero);
                    break;
                case "key":
                    string key = (msg.GetValueOrDefault("key") as string) ?? "";
                    string ktype = (msg.GetValueOrDefault("type") as string) ?? "down";
                    int vk = VkOf(key);
                    if (ktype == "down") Post(hwnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
                    else if (ktype == "up") Post(hwnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
                    // 普通字符也补一个 WM_CHAR，保证可输入。
                    if (key.Length == 1) Post(hwnd, WM_CHAR, (IntPtr)key[0], IntPtr.Zero);
                    break;
                case "text":
                    string text = (msg.GetValueOrDefault("text") as string) ?? "";
                    foreach (char c in text) Post(hwnd, WM_CHAR, (IntPtr)c, IntPtr.Zero);
                    break;
            }
        }

        private static void Post(IntPtr hwnd, int msg, IntPtr w, IntPtr l)
        {
            // PostMessage 异步投递，不阻塞 STA 线程。
            PostMessage(hwnd, msg, w, l);
        }

        private static int VkOf(string key)
        {
            int v = 0;
            if (VkMap.TryGetValue(key, out v)) return v;
            if (key.Length == 1) return char.ToUpperInvariant(key[0]); // A-Z / 0-9 的虚拟键码即 ASCII
            return 0;
        }

        private static int ToInt(object o)
        {
            if (o == null) return 0;
            if (o is int) { int i = (int)o; return i; }
            if (o is long) { long l = (long)o; return (int)l; }
            int r = 0;
            if (int.TryParse(o.ToString(), out r)) return r;
            return 0;
        }
    }

    /// <summary>
    /// .NET Framework 4.x 的 Dictionary 没有内置 GetValueOrDefault，这里补一个扩展，
    /// 让协议解析里的取值写法保持一致（.NET Core+ 才有此 API）。
    /// </summary>
    internal static class DictUtil
    {
        public static object GetValueOrDefault(this Dictionary<string, object> m, string key, object def)
        {
            if (m == null) return def;
            object v = null;
            if (m.TryGetValue(key, out v)) return v;
            return def;
        }

        public static object GetValueOrDefault(this Dictionary<string, object> m, string key)
        {
            if (m == null) return null;
            object v = null;
            if (m.TryGetValue(key, out v)) return v;
            return null;
        }
    }

    /// <summary>BGRA 像素提取 + 轻量哈希。</summary>
    internal static class BgraUtil
    {
        public static byte[] ExtractBgraTopDown(Bitmap bmp, out int w, out int h)
        {
            h = bmp.Height; w = bmp.Width;
            if (w <= 0 || h <= 0) { w = 0; h = 0; return null; }
            // 统一转成 32bpp ARGB（内存里就是 BGRA 小端），逐行拷贝成紧凑 w*4 缓冲，保证顶行在前、无 stride padding。
            using (Bitmap src = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(src))
                {
                    g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                    g.DrawImage(bmp, 0, 0, w, h);
                }
                BitmapData data = src.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    int stride = Math.Abs(data.Stride);
                    int rowBytes = w * 4;
                    byte[] outBuf = new byte[rowBytes * h];
                    IntPtr ptr = data.Scan0;
                    for (int y = 0; y < h; y++)
                    {
                        Marshal.Copy(IntPtr.Add(ptr, y * stride), outBuf, y * rowBytes, rowBytes);
                    }
                    return outBuf;
                }
                finally { src.UnlockBits(data); }
            }
        }

        public static bool EqualHash(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }
    }

    internal static class Fnv1a
    {
        public static byte[] Hash(byte[] data)
        {
            // 32-bit FNV-1a，足够做帧变化检测（非加密）。
            const uint prime = 16777619u;
            uint hash = 2166136261u;
            int step = Math.Max(1, data.Length / 4096); // 抽样，避免大帧每 tick 全量扫描
            for (int i = 0; i < data.Length; i += step)
            {
                hash ^= data[i];
                hash *= prime;
            }
            return BitConverter.GetBytes(hash);
        }
    }

    /// <summary>极简 NDJSON（手写下，避免引第三方 JSON 库）。只覆盖协议用到的类型。</summary>
    internal static class Json
    {
        public static Dictionary<string, object> Parse(string s)
        {
            int i = 0;
            object v = ParseValue(s, ref i);
            return v as Dictionary<string, object>;
        }

        public static string Stringify(Dictionary<string, object> obj)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object> kv in obj)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(Escape(kv.Key)).Append("\":");
                WriteValue(sb, kv.Value);
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object v)
        {
            if (v == null) sb.Append("null");
            else if (v is string) { string s = (string)v; sb.Append('"').Append(Escape(s)).Append('"'); }
            else if (v is bool) { bool b = (bool)v; sb.Append(b ? "true" : "false"); }
            else if (v is int || v is long || v is double || v is float) sb.Append(Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture));
            else sb.Append('"').Append(Escape(v.ToString())).Append('"');
        }

        private static string Escape(string s)
        {
            StringBuilder sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipSpace(s, ref i);
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i);
            if (c == '"') return ParseString(s, ref i);
            if (c == 't' || c == 'f') return ParseBool(s, ref i);
            if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber(s, ref i);
            return null;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            Dictionary<string, object> obj = new Dictionary<string, object>();
            i++; // {
            SkipSpace(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return obj; }
            while (i < s.Length)
            {
                SkipSpace(s, ref i);
                if (s[i] != '"') break;
                string key = ParseString(s, ref i);
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == ':') i++;
                object val = ParseValue(s, ref i);
                obj[key] = val;
                SkipSpace(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; break; }
            }
            return obj;
        }

        private static string ParseString(string s, ref int i)
        {
            i++; // "
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '\\')
                {
                    if (i >= s.Length) break;
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            string hex = s.Substring(i, 4); i += 4;
                            sb.Append((char)int.Parse(hex, System.Globalization.NumberStyles.HexNumber));
                            break;
                        default: sb.Append(e); break;
                    }
                }
                else if (c == '"') break;
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static object ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) i++;
            string num = s.Substring(start, i - start);
            int iv = 0;
            if (int.TryParse(num, out iv)) return iv;
            double dv = 0;
            if (double.TryParse(num, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dv)) return dv;
            return 0;
        }

        private static object ParseBool(string s, ref int i)
        {
            if (s.Substring(i, 4) == "true") { i += 4; return true; }
            if (s.Substring(i, 5) == "false") { i += 5; return false; }
            return false;
        }

        private static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }
    }
}
