Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & Replace(WScript.ScriptFullName, "RestroKOT_Silent.vbs", "Start_RestroKOT.bat") & chr(34), 0
Set WshShell = Nothing
