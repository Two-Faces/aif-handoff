/** Host-owned helper, compiled in memory by Windows PowerShell. No task text is
 * interpolated into this source. Target output has separate pipes and cannot
 * manufacture control messages. No native binary/toolchain is downloaded. */
export const windowsJobSource = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class AifJobHost {
  const uint WAIT_TIMEOUT = 258, STILL_ACTIVE = 259;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
  static readonly object OutputLock = new object();
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct Security {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Start; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security sa, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buffer, uint size, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, byte[] buffer, uint size, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Birth(IntPtr handle) {
    long birth, exit, kernel, user; Check(GetProcessTimes(handle, out birth, out exit, out kernel, out user));
    return birth.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  static void Send(object value) { lock(OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
  static Dictionary<string, object> Read() {
    string line = Console.ReadLine();
    return line == null ? null : Json.Deserialize<Dictionary<string, object>>(line);
  }
  static string Text(Dictionary<string,object> value, string key) { return (string)value[key]; }
  static string Quote(string arg) {
    var value = new StringBuilder("\""); int slashes=0;
    foreach (char c in arg) {
      if(c=='\\') { slashes++; continue; }
      value.Append('\\', c=='"' ? slashes*2+1 : slashes); slashes=0; value.Append(c);
    }
    return value.Append('\\', slashes*2).Append('"').ToString();
  }
  static uint Count(IntPtr job) {
    Accounting value; Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return value.Active;
  }
  static void Empty(IntPtr job) {
    Check(TerminateJobObject(job, 137));
    var clock = Stopwatch.StartNew();
    while(Count(job)!=0) { if(clock.ElapsedMilliseconds>10000) throw new TimeoutException(); Thread.Sleep(10); }
  }
  static void Drain(IntPtr handle, string stream) {
    try {
      byte[] buffer = new byte[8192]; uint count;
      while(ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero) && count>0)
        Send(new { kind="output", stream=stream, bytes=Convert.ToBase64String(buffer, 0, (int)count) });
    } finally { CloseHandle(handle); }
  }
  static void Recover(Dictionary<string,object> config) {
    // Local\\ job names belong to a Windows session. Never interpret a
    // lookup in another session's namespace as proof that this job vanished.
    if(Convert.ToInt32(config["hostSessionId"])!=Process.GetCurrentProcess().SessionId) throw new InvalidOperationException();
    IntPtr owner=IntPtr.Zero, job=IntPtr.Zero;
    try {
      // Open the job first so its object cannot disappear/reuse its name while
      // the exact host process is being stopped. Never kill a PID by itself.
      job=OpenJobObject(0x0004|0x0008, false, Text(config,"jobName"));
      int jobError=Marshal.GetLastWin32Error();
      if(job==IntPtr.Zero && jobError!=2) throw new Win32Exception(jobError);
      owner=OpenProcess(0x1000|0x100000|1, false, Convert.ToUInt32(config["hostPid"]));
      int ownerError=Marshal.GetLastWin32Error();
      if(owner==IntPtr.Zero && ownerError!=87) throw new Win32Exception(ownerError);
      if(owner!=IntPtr.Zero) {
        if(Birth(owner)!=Text(config,"hostBirth")) throw new InvalidOperationException();
        if(WaitForSingleObject(owner,0)==WAIT_TIMEOUT) Check(TerminateProcess(owner,137));
        if(WaitForSingleObject(owner,10000)!=0) throw new TimeoutException();
      }
      // The host may have created the job between the first lookup and exit.
      // Re-open after its death; an absent object is proof only once creation
      // has stopped and Windows has destroyed the empty/terminated job.
      if(job==IntPtr.Zero) {
        job=OpenJobObject(0x0004|0x0008,false,Text(config,"jobName"));
        int error=Marshal.GetLastWin32Error();
        if(job==IntPtr.Zero && error!=2) throw new Win32Exception(error);
      }
      if(job!=IntPtr.Zero) Empty(job);
      Send(new {kind="recovered", jobName=Text(config,"jobName"), activeProcesses=0});
    } finally { if(owner!=IntPtr.Zero) CloseHandle(owner); if(job!=IntPtr.Zero) CloseHandle(job); }
  }
  static void Launch(Dictionary<string,object> config) {
    IntPtr job=IntPtr.Zero, attrs=IntPtr.Zero, jobValue=IntPtr.Zero, handleList=IntPtr.Zero, environment=IntPtr.Zero;
    IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
    ProcessInfo child = new ProcessInfo(); bool initialized=false;
    Task stdout=null,stderr=null,stdin=null;
    var inputQueue=new BlockingCollection<byte[]>(64);
    try {
      string name=Text(config,"jobName");
      job=CreateJobObject(IntPtr.Zero,name); int jobError=Marshal.GetLastWin32Error();
      Check(job!=IntPtr.Zero);
      if(jobError==183) throw new Win32Exception(183);
      var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      var sa=new Security {Length=Marshal.SizeOf(typeof(Security)),Inherit=1};
      Check(CreatePipe(out inputRead,out inputWrite,ref sa,0));
      Check(CreatePipe(out outputRead,out outputWrite,ref sa,0));
      Check(CreatePipe(out errorRead,out errorWrite,ref sa,0));
      Check(SetHandleInformation(inputWrite,1,0)); Check(SetHandleInformation(outputRead,1,0)); Check(SetHandleInformation(errorRead,1,0));
      UIntPtr size=UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      attrs=Marshal.AllocHGlobal((IntPtr)(long)size.ToUInt64());
      Check(InitializeProcThreadAttributeList(attrs,2,0,ref size)); initialized=true;
      jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
      // JOB_LIST assigns the process at creation, eliminating the suspended
      // process / AssignProcessToJobObject crash window.
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x2000D,jobValue,(UIntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
      Marshal.WriteIntPtr(handleList,0,inputRead); Marshal.WriteIntPtr(handleList,IntPtr.Size,outputWrite); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errorWrite);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20002,handleList,(UIntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      var start=new StartupEx(); start.Start.Size=Marshal.SizeOf(typeof(StartupEx)); start.Start.Flags=0x100;
      start.Start.Input=inputRead; start.Start.Output=outputWrite; start.Start.Error=errorWrite; start.Attributes=attrs;
      string exe=Text(config,"executable"); var command=new StringBuilder(Quote(exe));
      foreach(object arg in (IEnumerable)config["args"]) command.Append(' ').Append(Quote((string)arg));
      var env=(Dictionary<string,object>)config["environment"];
      var keys=new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
      var block=new StringBuilder(); foreach(string key in keys) block.Append(key).Append('=').Append((string)env[key]).Append('\0');
      block.Append('\0'); environment=Marshal.StringToHGlobalUni(block.ToString());
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x00080000|0x00000400|0x00000004,environment,Text(config,"cwd"),ref start,out child));
      CloseHandle(inputRead); inputRead=IntPtr.Zero; CloseHandle(outputWrite); outputWrite=IntPtr.Zero; CloseHandle(errorWrite); errorWrite=IntPtr.Zero;
      IntPtr outHandle=outputRead,errHandle=errorRead; outputRead=IntPtr.Zero; errorRead=IntPtr.Zero;
      stdout=Task.Run(()=>Drain(outHandle,"stdout")); stderr=Task.Run(()=>Drain(errHandle,"stderr"));
      IntPtr inHandle=inputWrite; inputWrite=IntPtr.Zero;
      stdin=Task.Run(()=> {
        try {
          foreach(byte[] bytes in inputQueue.GetConsumingEnumerable()) {
            uint written;
            // A child may close its input at any time. This never proves exit.
            if(!WriteFile(inHandle,bytes,(uint)bytes.Length,out written,IntPtr.Zero)) break;
            if(written!=bytes.Length) throw new InvalidOperationException();
          }
        } finally {CloseHandle(inHandle);}
      });
      Send(new {kind="prepared",jobName=name,pid=child.Pid,birth=Birth(child.Process)});
      var read=Task.Run(()=>Read()); bool started=false; string reason="completed";
      for(;;) {
        if(read.IsCompleted) {
          var request=read.GetAwaiter().GetResult();
          if(request==null) {reason="channel_closed";break;}
          string kind=Text(request,"kind");
          if(kind=="stop") {reason="cancelled";break;}
          if(kind=="start" && !started) {Check(ResumeThread(child.Thread)!=UInt32.MaxValue);started=true;Send(new {kind="started"});}
          else if(kind=="input" && started) {
            byte[] bytes=Convert.FromBase64String(Text(request,"bytes"));
            if(bytes.Length>65536 || !inputQueue.TryAdd(bytes)) throw new InvalidOperationException();
          }
          else if(kind=="endInput" && started) inputQueue.CompleteAdding();
          else throw new InvalidOperationException();
          read=Task.Run(()=>Read());
        }
        uint wait=WaitForSingleObject(child.Process,20);
        if(wait==0) break;
        if(wait!=WAIT_TIMEOUT) throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      uint rootExit; Check(GetExitCodeProcess(child.Process,out rootExit));
      uint remaining=Count(job); Empty(job); inputQueue.CompleteAdding();
      if(WaitForSingleObject(child.Process,10000)!=0) throw new TimeoutException();
      Check(GetExitCodeProcess(child.Process,out rootExit));
      if(!Task.WaitAll(new[]{stdout,stderr,stdin},10000)) throw new TimeoutException();
      Send(new {kind="stopped",jobName=name,activeProcesses=0,exitCode=rootExit,reason=reason,terminatedProcesses=remaining});
    } finally {
      // Closing this sole non-inherited job handle also contains host crashes.
      if(job!=IntPtr.Zero) CloseHandle(job);
      inputQueue.CompleteAdding();
      foreach(IntPtr h in new[]{child.Process,child.Thread,inputRead,inputWrite,outputRead,outputWrite,errorRead,errorWrite}) if(h!=IntPtr.Zero) CloseHandle(h);
      if(initialized) DeleteProcThreadAttributeList(attrs);
      foreach(IntPtr p in new[]{attrs,jobValue,handleList,environment}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
    }
  }
  public static void Run() {
    try {
      Send(new {kind="hello",pid=Process.GetCurrentProcess().Id,sessionId=Process.GetCurrentProcess().SessionId,birth=Birth(GetCurrentProcess())});
      var config=Read(); if(config==null) return;
      if(Text(config,"kind")=="launch") Launch(config);
      else if(Text(config,"kind")=="recover") Recover(config);
      else throw new InvalidOperationException();
    } catch(Exception error) {
      var native=error as Win32Exception;
      Send(new {kind="error",code=native==null ? "supervisor_failed" : "native_failed",nativeCode=native==null ? 0 : native.NativeErrorCode});
      Environment.ExitCode=1;
    }
  }
}
`;
