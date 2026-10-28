# dsh-approval-notifier: give the toast identity a Start Menu shortcut.
#
# Invoked by lib/shortcut.js as a short-lived child process:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File register-shortcut.ps1 -LnkPath <path> -TargetPath <exe> -AppId <id> \
#     [-IconPath <ico>] [-WorkingDirectory <dir>]
#
# WHY THIS EXISTS: a Win32 process may raise a toast under any AppUserModelID
# string and WinRT accepts it -- Show() does not throw and the payload even lands
# in wpndatabase. The shell still will not display it, because it can only map
# the id back to an installed application, and for a non-packaged app that
# mapping is a Start Menu shortcut whose System.AppUserModel.ID property equals
# the id. Without the shortcut the toast is dropped silently: no banner, no
# sound, nothing in the notification centre. `Setting` keeps reporting
# `Enabled` the whole time, so the failure is invisible from the API.
#
# This file must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1
# as ANSI, so any non-ASCII literal would be mangled on a non-UTF-8 code page.
#
# Prints SHORTCUT-OK: created / SHORTCUT-OK: unchanged on success and
# SHORTCUT-FAIL: <reason> on failure. Exits 0 either way -- the parent
# classifies the result from stdout, not the exit code.

param(
  [Parameter(Mandatory = $true)][string]$LnkPath,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$AppId,
  [string]$IconPath = '',
  [string]$WorkingDirectory = ''
)

$ErrorActionPreference = 'Stop'

function Write-Fail([string]$message) {
  Write-Output ('SHORTCUT-FAIL: ' + $message)
  exit 0
}

function Get-CurrentAppId([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path $path -Parent))
    if ($null -eq $folder) { return '' }
    $item = $folder.ParseName((Split-Path $path -Leaf))
    if ($null -eq $item) { return '' }
    $value = $item.ExtendedProperty('System.AppUserModel.ID')
    if ($null -eq $value) { return '' }
    return [string]$value
  } catch {
    return ''
  }
}

function Set-AppId([string]$path, [string]$appId) {
  if (-not ('DshAppUserModelId' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class CShellLink { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
public interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY
{
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(2)] public ushort wReserved1;
    [FieldOffset(4)] public ushort wReserved2;
    [FieldOffset(8)] public IntPtr p;
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

public static class DshAppUserModelId
{
    public static void Set(string lnkPath, string appUserModelId)
    {
        var link = (IShellLinkW)new CShellLink();
        var store = (IPropertyStore)link;
        var persist = (IPersistFile)link;
        persist.Load(lnkPath, 2);

        var pkey = new PROPERTYKEY();
        pkey.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        pkey.pid = 5;

        var pv = new PROPVARIANT();
        pv.vt = 31;
        pv.p = Marshal.StringToCoTaskMemUni(appUserModelId);
        try
        {
            store.SetValue(ref pkey, ref pv);
            store.Commit();
            persist.Save(lnkPath, true);
        }
        finally
        {
            Marshal.FreeCoTaskMem(pv.p);
        }
    }
}
'@
  }
  [DshAppUserModelId]::Set($path, $appId)
}

if (-not (Test-Path -LiteralPath $TargetPath)) {
  Write-Fail ('target executable not found: ' + $TargetPath)
}

$existing = Get-CurrentAppId $LnkPath
if ($existing -eq $AppId) {
  Write-Output 'SHORTCUT-OK: unchanged'
  exit 0
}

try {
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($LnkPath)
  $shortcut.TargetPath = $TargetPath
  if ($WorkingDirectory -ne '') { $shortcut.WorkingDirectory = $WorkingDirectory }
  $icon = $IconPath
  if ($icon -eq '') { $icon = $TargetPath }
  $shortcut.IconLocation = ($icon + ',0')
  $shortcut.Description = 'DSH approval notifications (toast identity)'
  $shortcut.Save()
} catch {
  Write-Fail ('could not create the shortcut: ' + $_.Exception.Message)
}

try {
  Set-AppId $LnkPath $AppId
} catch {
  Write-Fail ('could not stamp the AppUserModelID: ' + $_.Exception.Message)
}

$readBack = Get-CurrentAppId $LnkPath
if ($readBack -ne $AppId) {
  Write-Fail ('AppUserModelID did not stick (read back: ' + $readBack + ')')
}

Write-Output 'SHORTCUT-OK: created'
exit 0
