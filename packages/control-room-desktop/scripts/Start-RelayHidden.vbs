' GUI entry point: hide the child at creation, before PowerShell can paint a console.
' Usage: wscript.exe //B //Nologo Start-RelayHidden.vbs script.ps1 [arguments]
Option Explicit
Dim shell, command, arg, code
If WScript.Arguments.Count = 0 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = Quote(shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")) & _
  " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File"
For Each arg In WScript.Arguments
  command = command & " " & Quote(arg)
Next
code = shell.Run(command, 0, True)
WScript.Quit code

Function Quote(value)
  If InStr(value, Chr(34)) > 0 Or InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then WScript.Quit 2
  Quote = Chr(34) & value & Chr(34)
End Function
