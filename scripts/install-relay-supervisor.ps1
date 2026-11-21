# Installs the Synloq relay supervisor as a Windows Scheduled Task (issue #166).
# Idempotent: an existing task with the same name is left untouched.
# The task runs `synloq relay-supervisor` every 5 minutes; the command itself
# exits instantly when the relay is healthy and starts it otherwise.
# Never touches serve.lock — lock recovery belongs to the relay (#141).
param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [string]$SynloqHome = "",
  [string]$RelayUrl = "http://127.0.0.1:4100",
  [string]$TaskName = "SynloqRelaySupervisor",
  [string]$NodePath = "C:\Program Files\nodejs\node.exe",
  [string]$SynloqCli = ""
)

$ErrorActionPreference = "Stop"

if ($SynloqCli -eq "") {
  $SynloqCli = Join-Path $ProjectRoot "dist\cli\main.js"
}

& schtasks.exe /query /tn $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Output "Task '$TaskName' already exists — nothing to do."
  exit 0
}

$cmd = "`"$NodePath`" `"$SynloqCli`" relay-supervisor --project-root `"$ProjectRoot`" --relay-url `"$RelayUrl`""
if ($SynloqHome -ne "") {
  $cmd += " --synloq-home `"$SynloqHome`""
}

& schtasks.exe /create /tn $TaskName /tr $cmd /sc minute /mo 5 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "schtasks /create failed with exit code $LASTEXITCODE"
}
Write-Output "Task '$TaskName' registered: relay-supervisor every 5 minutes."
