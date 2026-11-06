[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
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
if ($statusExitCode -ne 0) {
  throw "The specified local Supabase stack is not running. No hosted project was accessed."
}
$statusText = $statusLines -join "`n"
$jsonStart = $statusText.IndexOf("{")
if ($jsonStart -lt 0) { throw "Supabase CLI did not return local status JSON." }
$jsonEnd = $statusText.LastIndexOf("}")
if ($jsonEnd -lt $jsonStart) { throw "Supabase CLI returned incomplete local status JSON." }
$status = $statusText.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json

$apiUri = [Uri]$status.API_URL
if ($apiUri.Scheme -ne "http" -or $apiUri.Host -notin @("127.0.0.1", "localhost")) {
  throw "The app runner accepts only the isolated local loopback Supabase URL."
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

try {
  $env:JOBHUNT_M02_SUPABASE_URL = [string]$status.API_URL
  $env:JOBHUNT_M02_PUBLISHABLE_KEY = [string]$status.PUBLISHABLE_KEY
  $env:JOBHUNT_M02_SERVICE_KEY = [string]$status.SERVICE_ROLE_KEY
  $env:JOBHUNT_M02_DB_CONTAINER = [string]$dbContainers[0]
  $env:JOBHUNT_M02_LOOPBACK_PORTS = ($ports -join ",")
  $runner = Join-Path $repoRoot "scripts\windows_supabase_onboarding_acceptance.py"
  $python = Get-Command python -ErrorAction Stop
  $runnerArgs = @($runner, "--source-root", $repoRoot)
  if ($EvidenceDir) { $runnerArgs += @("--evidence-dir", $EvidenceDir) }
  & $python.Source @runnerArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item Env:JOBHUNT_M02_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_PUBLISHABLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_SERVICE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_DB_CONTAINER -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_LOOPBACK_PORTS -ErrorAction SilentlyContinue
}
