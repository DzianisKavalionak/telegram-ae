function Invoke-TelegramIsolatedAE {
    param(
        [Parameter(Mandatory)][string]$AfterEffectsPath,
        [Parameter(Mandatory)][string]$WorkerPath,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$JobStatusPath,
        [Parameter(Mandatory)][int]$BuildTimeoutSeconds,
        [Parameter(Mandatory)][int]$RenderTimeoutSeconds
    )
    if (-not ('TelegramIsolatedAE.Worker' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace TelegramIsolatedAE {
    public sealed class Worker : IDisposable {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public int Size;
            public string Reserved, Desktop, Title;
            public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedLength;
            public IntPtr ReservedData, StdIn, StdOut, StdErr;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInfo {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder result, int bytes, out int required);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateDesktopW(string name, string device, IntPtr mode, int flags, int access, IntPtr attributes);
        [DllImport("user32.dll")]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inherit, int flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private IntPtr process, desktop;
        public uint Id { get; private set; }
        public string DesktopName { get; private set; }

        public static Worker Start(string afterfx, string jsx) {
            var station = new StringBuilder(256);
            int required;
            if (!GetUserObjectInformationW(GetProcessWindowStation(), 2, station, station.Capacity * 2, out required))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            string name = "TelegramAERender-" + Guid.NewGuid().ToString("N");
            var worker = new Worker();
            worker.DesktopName = station.ToString() + "\\" + name;
            // Read/write desktop objects, create windows and enumerate the private desktop.
            worker.desktop = CreateDesktopW(name, null, IntPtr.Zero, 0, 0x00C3, IntPtr.Zero);
            if (worker.desktop == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            try {
                var startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfo));
                startup.Desktop = worker.DesktopName;
                startup.Flags = 1; // STARTF_USESHOWWINDOW, SW_HIDE
                string scriptArgument = jsx.IndexOfAny(new[] { ' ', '\t' }) >= 0 ? "\"" + jsx + "\"" : jsx;
                var command = new StringBuilder("\"" + afterfx + "\" -m -noui -r " + scriptArgument);
                ProcessInfo info;
                const int CreateNoWindow = 0x08000000;
                if (!CreateProcessW(afterfx, command, IntPtr.Zero, IntPtr.Zero, false,
                    CreateNoWindow, IntPtr.Zero, Path.GetDirectoryName(afterfx), ref startup, out info))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                worker.process = info.Process;
                worker.Id = info.ProcessId;
                CloseHandle(info.Thread);
                return worker;
            } catch {
                worker.Dispose();
                throw;

            }
        }

        public bool Wait(uint milliseconds) {
            uint result = WaitForSingleObject(process, milliseconds);
            if (result == 0) return true;
            if (result == 0x102) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public uint ExitCode {
            get {
                uint result;
                if (!GetExitCodeProcess(process, out result)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return result;
            }
        }

        public void Dispose() {
            if (process != IntPtr.Zero) {
                if (WaitForSingleObject(process, 0) == 0x102) {
                    TerminateProcess(process, 1);
                    WaitForSingleObject(process, 5000);
                }
                CloseHandle(process);
                process = IntPtr.Zero;
            }
            if (desktop != IntPtr.Zero) {
                CloseDesktop(desktop);
                desktop = IntPtr.Zero;
            }
        }
    }
}
"@
    }

    $previousToken = [Environment]::GetEnvironmentVariable('TELEGRAM_AE_JOB_TOKEN', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('TELEGRAM_AE_JOB_TOKEN', $Token, 'Process')
        $worker = [TelegramIsolatedAE.Worker]::Start($AfterEffectsPath, $WorkerPath)
    } finally {
        [Environment]::SetEnvironmentVariable('TELEGRAM_AE_JOB_TOKEN', $previousToken, 'Process')
    }
    try {
        Write-Output ("Изолированный AE PID $($worker.Id), рабочий стол $($worker.DesktopName)")
        $deadline = [DateTime]::UtcNow.AddSeconds($BuildTimeoutSeconds)
        $stage = ''
        do {
            $exited = $worker.Wait(1000)
            if (Test-Path -LiteralPath $JobStatusPath) {
                try {
                    $status = [IO.File]::ReadAllText($JobStatusPath) | ConvertFrom-Json
                } catch {
                    $status = $null
                }
                if ($status -and $status.token -eq $Token -and $status.status -ne $stage) {
                    $stage = [string]$status.status
                    Write-Output "AE: $stage"
                    if ($stage -eq 'rendering') {
                        $deadline = [DateTime]::UtcNow.AddSeconds($RenderTimeoutSeconds)
                    } elseif ($stage -eq 'done' -or $stage -eq 'failed') {
                        $deadline = [DateTime]::UtcNow.AddSeconds(15)
                    }
                }
            }
            if ($exited) { break }
            if ([DateTime]::UtcNow -gt $deadline) {
                throw "Истекло время ожидания изолированного AE. Этап $stage. Отчёт $JobStatusPath"
            }
        } while ($true)

        if ($stage -eq 'failed') { throw "Изолированный AE: $($status.error) (строка $($status.line))." }
        if ($stage -ne 'done' -or $worker.ExitCode -ne 0) {
            throw "Изолированный AE завершился с кодом $($worker.ExitCode). Последний этап $stage. Отчёт $JobStatusPath"
        }
    } finally {
        $worker.Dispose()
    }
}
