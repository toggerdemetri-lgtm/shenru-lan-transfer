using System.Reflection;
[assembly: AssemblyTitle("退出深入·局域网互传")]
[assembly: AssemblyProduct("深入·局域网互传")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]
internal static class StopProgram
{
    private static int Main() { Lifetime.RequestStop(Lifetime.HomePath()); return 0; }
}
