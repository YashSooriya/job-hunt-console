[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

$nodeRoot = Join-Path $env:LOCALAPPDATA "Programs\JobHuntAI\node-v24.22.2-win-x64"
$nodePath = Join-Path $nodeRoot "node.exe"
if (Test-Path -LiteralPath $nodePath) {
  $env:PATH = "$nodeRoot;$env:PATH"
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw "Node.js is required for the isolated M03 desktop runner." }

$configLines = & wsl.exe -d Ubuntu-24.04 -u root -- cat ($SupabaseWorkdir + "/supabase/config.toml")
$projectLine = $configLines | Select-String -Pattern '^\s*project_id\s*=\s*"([^"]+)"' | Select-Object -First 1
$projectId = if ($projectLine) { $projectLine.Matches[0].Groups[1].Value } else { "" }
if ($LASTEXITCODE -ne 0 -or -not $projectId) {
  throw "Could not resolve the local Supabase project id from the specified WSL workdir."
}

$oldErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$statusLines = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/local/bin/supabase status --workdir $SupabaseWorkdir --output json 2>&1
$statusExitCode = $LASTEXITCODE
$ErrorActionPreference = $oldErrorActionPreference
if ($statusExitCode -ne 0) { throw "The specified local Supabase stack is not running. No hosted project was accessed." }
$statusText = $statusLines -join "`n"
$jsonStart = $statusText.IndexOf("{")
$jsonEnd = $statusText.LastIndexOf("}")
if ($jsonStart -lt 0 -or $jsonEnd -lt $jsonStart) { throw "Supabase CLI did not return local status JSON." }
$status = $statusText.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json

$apiUri = [Uri]$status.API_URL
if ($apiUri.Scheme -ne "http" -or $apiUri.Host -notin @("127.0.0.1", "localhost")) {
  throw "The M03 app runner accepts only the isolated local loopback Supabase URL."
}
$ports = @($apiUri.Port, ([Uri]$status.DB_URL).Port, ([Uri]$status.STUDIO_URL).Port, ([Uri]$status.MAILPIT_URL).Port) | Sort-Object -Unique
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort })
foreach ($port in $ports) {
  $matches = @($listeners | Where-Object { $_.LocalPort -eq $port })
  if (-not $matches) { throw "Expected a Windows localhost forwarder for local Supabase port $port." }
  if (@($matches | Where-Object { $_.LocalAddress -ne "127.0.0.1" }).Count -gt 0) {
    throw "Local Supabase port $port has a non-loopback Windows listener; acceptance stopped before sign-in."
  }
}

$containerLines = & wsl.exe -d Ubuntu-24.04 -u root -- podman ps --filter ("label=com.supabase.cli.project=" + $projectId) --format "{{.Names}}"
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the local Podman project containers." }
$dbContainers = @($containerLines | Where-Object { $_ -match "^supabase_db_" })
if ($dbContainers.Count -ne 1) { throw "Expected exactly one local database container for project $projectId." }

foreach ($functionName in @("job-pool-scheduler", "chatgpt-bridge")) {
  $functionStatus = 0
  try {
    $functionResponse = Invoke-WebRequest -Uri ($apiUri.AbsoluteUri.TrimEnd("/") + "/functions/v1/" + $functionName) -Method Get -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    $functionStatus = [int]$functionResponse.StatusCode
  } catch {
    $response = $_.Exception.Response
    if ($response -and $response.StatusCode) { $functionStatus = [int]$response.StatusCode }
    else { throw "The local $functionName function is not being served. Start the two local Supabase Edge Functions before acceptance." }
  }
  if ($functionStatus -eq 404) { throw "The local $functionName Edge Function returned 404; start the matching test functions." }
}

try {
  $env:JOBHUNT_M03_SUPABASE_URL = [string]$status.API_URL
  $env:JOBHUNT_M03_PUBLISHABLE_KEY = [string]$status.PUBLISHABLE_KEY
  $env:JOBHUNT_M03_SERVICE_KEY = [string]$status.SERVICE_ROLE_KEY
  $env:JOBHUNT_M03_DB_CONTAINER = [string]$dbContainers[0]
  $env:JOBHUNT_M03_LOOPBACK_PORTS = ($ports -join ",")
  $runner = Join-Path $repoRoot "scripts\windows_m03_supabase_acceptance.py"
  $python = Get-Command python.exe -ErrorAction Stop
  $runnerArgs = @($runner, "--source-root", $repoRoot)
  if ($EvidenceDir) { $runnerArgs += @("--evidence-dir", $EvidenceDir) }
  & $python.Source @runnerArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item Env:JOBHUNT_M03_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M03_PUBLISHABLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M03_SERVICE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M03_DB_CONTAINER -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M03_LOOPBACK_PORTS -ErrorAction SilentlyContinue
}
