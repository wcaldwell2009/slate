' Starts Slate with no console window at all.
'
' The Desktop shortcut points here (via wscript.exe). All this does is run
' launch.js hidden — launch.js works out the folders and starts the server.
' Window style 0 = hidden, False = don't wait for it to finish.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

home = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = home
sh.Run "node.exe " & Chr(34) & home & "\launch.js" & Chr(34), 0, False
