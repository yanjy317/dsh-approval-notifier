' dsh-approval-notifier: bring the DSH Desktop window to the front, on the
' session the clicked notification belongs to.
'
' The shell runs this through this plugin's per-user URL scheme, so it must
' never open a console: wscript.exe is a GUI-subsystem host, unlike
' powershell.exe -- whose console window is created before `-WindowStyle Hidden`
' can hide it, which is the visible flash this replaces.
'
' Invocation (the shell substitutes the activated URL into the "%1" in the
' registered command, so it always arrives as the last argument):
'
'   wscript.exe focus.vbs [--probe] [--api <url>] [other args] "<DSH Desktop.exe>"
'     "dsh-approval-notifier://focus?session=<id>"
'     "dsh-approval-notifier://decide?decision=allow&session=<id>&key=<k>&t=<token>"
'
'  --probe       quit 0 immediately; lets the plugin verify the script host
'                works without activating anything.
'  --api <url>   this plugin's loopback route, e.g.
'                http://127.0.0.1:43129/dsh-approval-notifier/activate.
'  <exe path>    any argument ending in .exe; the last one wins.
'  <url>         the activated URL: any non-http(s) "scheme://" argument.
'
' Behaviour: ask WMI for every process with that executable name and let
' AppActivate pick the one owning a window (only the browser process has one;
' it also restores a minimized window). If none activates, start the app and
' let its own single-instance handler show the window. Then the URL's own query
' is forwarded verbatim to the loopback route, which decides what the click
' means: `session` navigates, `decision` answers the pending approval. A
' decision deliberately skips the window juggling -- the user asked to decide
' without leaving what they were doing.
'
' Every activation appends one line to
'   %TEMP%\dsh-approval-notifier-click.log
' because a click is otherwise invisible: the toast cannot report back, so
' "clicking the notification did nothing" has no evidence either way. The file
' records the URL the shell handed over, the action, the session parsed out of
' it, the process AppActivate picked, and the route's reply.
'
' Keep this file ASCII-only: Windows Script Host reads a BOM-less .vbs as ANSI.

Option Explicit

Dim index, argument, exePath, apiUrl, activatedUrl
exePath = ""
apiUrl = ""
activatedUrl = ""

For index = 0 To WScript.Arguments.Count - 1
  argument = WScript.Arguments(index)
  If LCase(argument) = "--probe" Then WScript.Quit 0
  If LCase(argument) = "--api" Then
    If index + 1 <= WScript.Arguments.Count - 1 Then apiUrl = WScript.Arguments(index + 1)
  ElseIf LCase(Right(argument, 4)) = ".exe" Then
    exePath = argument
  ElseIf IsActivationUrl(argument) Then
    activatedUrl = argument
  End If
Next

Dim action, sessionId, query
action = UrlHost(activatedUrl)
sessionId = QueryValue(activatedUrl, "session")
query = UrlQuery(activatedUrl)

Dim trace
trace = "action=" & action & " url=" & activatedUrl & " session=" & sessionId & " api=" & apiUrl

Dim processName, cut
processName = "DSH Desktop.exe"
If exePath <> "" Then
  cut = InStrRev(exePath, "\")
  If cut > 0 Then
    processName = Mid(exePath, cut + 1)
  Else
    processName = exePath
  End If
End If
processName = Replace(processName, "'", "''")

Dim shell, wmi, processes, item, activated
Set shell = CreateObject("WScript.Shell")
activated = 0

' A decision button is answered by the page over the loopback route: the user
' asked to decide without leaving what they were doing, so the window is left
' where it is. A body click is the "take me there" gesture and still raises it.
If action <> "decide" Then
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number = 0 Then
    Set processes = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & processName & "'")
    If Err.Number = 0 Then
      For Each item In processes
        If shell.AppActivate(CLng(item.ProcessId)) Then
          activated = CLng(item.ProcessId)
          Exit For
        End If
      Next
    End If
  End If
  On Error GoTo 0

  If activated = 0 And exePath <> "" Then
    On Error Resume Next
    shell.Run """" & exePath & """", 1, False
    On Error GoTo 0
  End If
End If

TraceLine trace & " activated=" & activated

If apiUrl <> "" And query <> "" Then ReportRoute apiUrl, query

' Append one diagnostic line. A click must never raise anything, so every
' failure here is swallowed: the trace is for the human reading the log after
' "the notification did not switch sessions", not for the click itself.
Sub TraceLine(line)
  Dim fso, file
  On Error Resume Next
  Set fso = CreateObject("Scripting.FileSystemObject")
  If Err.Number = 0 Then
    Set file = fso.OpenTextFile(fso.GetSpecialFolder(2) & "\dsh-approval-notifier-click.log", 8, True)
    If Err.Number = 0 Then
      file.WriteLine Now & "  " & line
      file.Close
    End If
  End If
  Set file = Nothing
  Set fso = Nothing
  On Error GoTo 0
End Sub

' Hand the activated URL's own query to the plugin's loopback route. Both click
' kinds travel this way -- "?session=<id>" for the body click and
' "?decision=...&key=...&t=..." for a decision button -- so the route receives
' exactly what the shell passed, already percent-encoded. Every failure is
' swallowed: a notification click must never raise a dialog, and the toast has
' already done its job by the time this runs.
Sub ReportRoute(route, search)
  Dim target, http, outcome
  target = route
  If InStr(target, "?") > 0 Then
    target = target & "&" & search
  Else
    target = target & "?" & search
  End If
  outcome = "route=unreached"
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number = 0 Then
    ' Direct: a loopback route must not be handed to a configured proxy.
    http.SetProxy 1
    Err.Clear
    http.Open "GET", target, False
    http.Send
    If Err.Number = 0 Then
      outcome = "route=" & http.Status & " " & http.ResponseText
    Else
      outcome = "route=error " & Err.Description
    End If
    Err.Clear
  End If
  Set http = Nothing
  On Error GoTo 0
  TraceLine outcome
End Sub

' The activated URL is the argument the shell appended: a "scheme://" value
' that is not http(s) (the --api route is a second, http URL on the line).
Function IsActivationUrl(value)
  Dim lower
  IsActivationUrl = False
  If Len(value) < 5 Then Exit Function
  lower = LCase(value)
  If InStr(lower, "://") = 0 Then Exit Function
  If Left(lower, 7) = "http://" Then Exit Function
  If Left(lower, 8) = "https://" Then Exit Function
  IsActivationUrl = True
End Function

' The action of a "scheme://action?..." URL: "focus" for a body click, "decide"
' for an approval button. Empty when the URL has no host part.
Function UrlHost(value)
  Dim rest, cut
  UrlHost = ""
  cut = InStr(value, "://")
  If cut = 0 Then Exit Function
  rest = Mid(value, cut + 3)
  cut = InStr(rest, "?")
  If cut > 0 Then rest = Left(rest, cut - 1)
  cut = InStr(rest, "/")
  If cut > 0 Then rest = Left(rest, cut - 1)
  UrlHost = LCase(rest)
End Function

' Everything after the URL's first "?", exactly as the shell passed it (still
' percent-encoded), so the route can parse every parameter the URL carried.
Function UrlQuery(value)
  Dim cut
  UrlQuery = ""
  cut = InStr(value, "?")
  If cut = 0 Then Exit Function
  UrlQuery = Mid(value, cut + 1)
End Function

' One query parameter out of a URL, percent-decoded. Missing means "".
Function QueryValue(url, key)
  Dim lower, marker, at, chunk, cut
  QueryValue = ""
  If url = "" Then Exit Function
  lower = LCase(url)
  marker = LCase(key) & "="
  at = InStr(lower, "?" & marker)
  If at = 0 Then at = InStr(lower, "&" & marker)
  If at = 0 Then Exit Function
  chunk = Mid(url, at + Len(marker) + 1)
  cut = InStr(chunk, "&")
  If cut > 0 Then chunk = Left(chunk, cut - 1)
  cut = InStr(chunk, "#")
  If cut > 0 Then chunk = Left(chunk, cut - 1)
  QueryValue = UrlDecode(chunk)
End Function

' Percent-decoding for the session id, so an id with an escaped character
' reaches the route exactly as the page knows it.
Function UrlDecode(value)
  Dim result, position, current, pair
  result = ""
  position = 1
  Do While position <= Len(value)
    current = Mid(value, position, 1)
    If current = "+" Then
      result = result & " "
      position = position + 1
    ElseIf current = "%" And position + 2 <= Len(value) Then
      pair = Mid(value, position + 1, 2)
      If IsHex(pair) Then
        result = result & Chr(CLng("&H" & pair))
        position = position + 3
      Else
        result = result & current
        position = position + 1
      End If
    Else
      result = result & current
      position = position + 1
    End If
  Loop
  UrlDecode = result
End Function

Function IsHex(value)
  Dim position, current
  IsHex = False
  If Len(value) <> 2 Then Exit Function
  For position = 1 To 2
    current = UCase(Mid(value, position, 1))
    If InStr("0123456789ABCDEF", current) = 0 Then Exit Function
  Next
  IsHex = True
End Function
