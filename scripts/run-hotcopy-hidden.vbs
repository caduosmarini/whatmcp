Option Explicit

Dim shell, files, runner, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
runner = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "sync-hotcopy-windows.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & runner & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
