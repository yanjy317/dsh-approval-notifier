# dsh-approval-notifier: show exactly one Windows toast.
#
# Invoked by lib/notify.js as a short-lived child process:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File toast.ps1 -Payload <base64 utf8 json>
#
# The payload carries every variable text as base64 on purpose. This file must
# stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so
# non-ASCII literals inside it would be mangled on a non-UTF-8 code page.
#
# Payload: { appId, lines: [string], sound: bool, launch: string, button: string,
#            actions: [{ content, arguments }], icon: path }
# `launch` is activated by clicking the toast body; `actions` are the toast's
# buttons (an approval carries the two decision labels there, each with its own
# protocol URL). `button` is the single label action kept for toasts without
# actions, for environments where a body click on an unregistered app id is not
# delivered.
# Prints TOAST-OK on success, TOAST-FAIL: <reason> on failure, and exits 0
# either way: the parent classifies the result from stdout, not the exit code.

param(
  [Parameter(Mandatory = $true)][string]$Payload
)

$ErrorActionPreference = 'Stop'

function Get-JsonText([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json

$appId = 'DSH.ApprovalNotifier'
if (-not [string]::IsNullOrWhiteSpace([string]$data.appId)) {
  $appId = [string]$data.appId
}

# @() guards the PowerShell 5.1 behaviour where a one-element JSON array
# arrives unwrapped from ConvertFrom-Json.
$texts = ''
foreach ($line in @($data.lines)) {
  if ($null -eq $line) { continue }
  $text = [string]$line
  if ($text.Trim().Length -eq 0) { continue }
  $texts += '<text>' + (Get-JsonText $text) + '</text>'
}
if ($texts -eq '') { $texts = '<text>DSH</text>' }

$attributes = ' duration="long"'
$launch = [string]$data.launch
if (-not [string]::IsNullOrWhiteSpace($launch)) {
  $attributes += ' activationType="protocol" launch="' + (Get-JsonText $launch) + '"'
}

# Buttons. The action list wins; `button` is the single-action legacy form. An
# entry missing its text or its URL is dropped rather than rendered as a dead
# button the user would press and get nothing from.
$actions = ''
foreach ($action in @($data.actions)) {
  if ($null -eq $action) { continue }
  $content = [string]$action.content
  $arguments = [string]$action.arguments
  if ([string]::IsNullOrWhiteSpace($content) -or [string]::IsNullOrWhiteSpace($arguments)) { continue }
  $actions += '<action content="' + (Get-JsonText $content) + '" activationType="protocol" arguments="' + (Get-JsonText $arguments) + '"/>'
}
if ($actions -ne '') {
  $actions = '<actions>' + $actions + '</actions>'
} else {
  $button = [string]$data.button
  if (-not [string]::IsNullOrWhiteSpace($launch) -and -not [string]::IsNullOrWhiteSpace($button)) {
    $actions = '<actions><action content="' + (Get-JsonText $button) + '" activationType="protocol" arguments="' + (Get-JsonText $launch) + '"/></actions>'
  }
}

$image = ''
$iconPath = [string]$data.icon
if (-not [string]::IsNullOrWhiteSpace($iconPath) -and (Test-Path -LiteralPath $iconPath)) {
  $iconUri = ([uri]$iconPath).AbsoluteUri
  $image = '<image placement="appLogoOverride" src="' + (Get-JsonText $iconUri) + '"/>'
}

$audio = '<audio silent="true"/>'
if ($data.sound -ne $false) {
  $audio = '<audio src="ms-winsoundevent:Notification.Default"/>'
}

$xml = '<toast' + $attributes + '><visual><binding template="ToastGeneric">' + $texts + $image + '</binding></visual>' + $actions + $audio + '</toast>'

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Write-Output 'TOAST-OK'
} catch {
  Write-Output ('TOAST-FAIL: ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
}
