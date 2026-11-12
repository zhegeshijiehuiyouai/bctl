using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// Windows 上 npm 风格的 bctl.cmd 会用 %* 把参数再交给 cmd.exe 解析一次。
// 引号里的 | < > & 会在到达 node 之前被本机拆掉。这个 exe 用参数数组启动 node.exe，中间不再经过 cmd。
internal static class BctlLaunch
{
    private static int Main(string[] args)
    {
        string exeDir = Path.GetDirectoryName(typeof(BctlLaunch).Assembly.Location);
        string homeFile = Path.Combine(exeDir, "bctl.home");
        if (!File.Exists(homeFile))
        {
            Console.Error.WriteLine("找不到 " + homeFile + "。请重新运行 scripts\\install-cli.ps1。");
            return 1;
        }

        string script = File.ReadAllText(homeFile).Trim();
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("bctl.home 指向的脚本不存在: " + script);
            return 1;
        }

        string node = FindNode();
        if (node == null)
        {
            Console.Error.WriteLine("PATH 中找不到 node.exe。");
            return 1;
        }

        var command = new StringBuilder();
        command.Append(Quote(script));
        for (int i = 0; i < args.Length; i++)
        {
            command.Append(' ');
            command.Append(Quote(args[i]));
        }

        var start = new ProcessStartInfo();
        start.FileName = node;
        start.Arguments = command.ToString();
        start.UseShellExecute = false;
        Process child = Process.Start(start);
        child.WaitForExit();
        return child.ExitCode;
    }

    private static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path)) return null;
        string[] dirs = path.Split(';');
        for (int i = 0; i < dirs.Length; i++)
        {
            string dir = dirs[i].Trim();
            if (dir.Length == 0) continue;
            string candidate = Path.Combine(dir, "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // CommandLineToArgvW 的引用规则：参数始终加引号，引号前的反斜杠成对加倍。
    private static string Quote(string value)
    {
        if (value == null) value = "";
        var sb = new StringBuilder();
        sb.Append('"');
        int slashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                slashes++;
            }
            else if (c == '"')
            {
                sb.Append('\\', slashes * 2 + 1);
                sb.Append('"');
                slashes = 0;
            }
            else
            {
                if (slashes > 0) sb.Append('\\', slashes);
                sb.Append(c);
                slashes = 0;
            }
        }
        if (slashes > 0) sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
