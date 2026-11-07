[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$ExpectedProjectId = "jobhuntai-m02-local-20261106"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Invoke-WslChecked([string[]]$Arguments, [string]$Failure) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & wsl.exe -d Ubuntu-24.04 -u root -- @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($exitCode -ne 0) { throw "$Failure (exit code $exitCode)." }
  return $output
}

try {
  $configLines = Invoke-WslChecked @("/usr/bin/cat", "$SupabaseWorkdir/supabase/config.toml") "The local Supabase workdir has no config.toml."
  $configText = $configLines -join "`n"
  $projectMatch = [regex]::Match($configText, '(?m)^\s*project_id\s*=\s*"([^"]+)"')
  if (-not $projectMatch.Success -or $projectMatch.Groups[1].Value -ne $ExpectedProjectId) {
    throw "Refusing authorization acceptance outside the expected disposable Supabase project."
  }

  $statusOutput = Invoke-WslChecked @("/usr/local/bin/supabase", "status", "--workdir", $SupabaseWorkdir, "--output", "json") "The disposable local Supabase stack is not running."
  $statusText = $statusOutput -join "`n"
  $start = $statusText.IndexOf("{")
  $end = $statusText.LastIndexOf("}")
  if ($start -lt 0 -or $end -lt $start) { throw "The local Supabase CLI did not return status JSON." }
  $localStatus = $statusText.Substring($start, $end - $start + 1) | ConvertFrom-Json
  $apiUri = [Uri]$localStatus.API_URL
  if ($apiUri.Scheme -ne "http" -or $apiUri.Host -notin @("127.0.0.1", "localhost")) {
    throw "Authorization acceptance accepts only a loopback Supabase API."
  }
  $containerLines = Invoke-WslChecked @("podman", "ps", "--filter", ("label=com.supabase.cli.project=" + $ExpectedProjectId), "--format", "{{.Names}}") "Could not inspect the disposable local Podman project."
  $dbContainers = @($containerLines | Where-Object { $_ -match '^supabase_db_' })
  if ($dbContainers.Count -ne 1) { throw "Expected exactly one disposable local database container." }

  $migration = "20261107182946_m05_application_write_authorization.sql"
  $sourceMigration = Join-Path $repoRoot ("database\migrations\" + $migration)
  if (-not (Test-Path -LiteralPath $sourceMigration)) { throw "The M05 authorization migration is missing." }
  $sourceWsl = "/mnt/c/" + $sourceMigration.Substring(3).Replace("\", "/")
  Invoke-WslChecked @("/usr/bin/mkdir", "-p", "$SupabaseWorkdir/supabase/migrations") "Could not prepare the local migration directory." | Out-Null
  Invoke-WslChecked @("/usr/bin/cp", $sourceWsl, "$SupabaseWorkdir/supabase/migrations/$migration") "Could not stage the M05 authorization migration." | Out-Null
  Invoke-WslChecked @("/usr/local/bin/supabase", "migration", "up", "--local", "--workdir", $SupabaseWorkdir) "The M05 authorization migration failed on the disposable database." | Out-Null

  $env:JOBHUNT_M02_SUPABASE_URL = [string]$localStatus.API_URL
  $env:JOBHUNT_M02_PUBLISHABLE_KEY = [string]$localStatus.PUBLISHABLE_KEY
  $env:JOBHUNT_M02_SERVICE_KEY = [string]$localStatus.SERVICE_ROLE_KEY
  $env:JOBHUNT_M02_DB_CONTAINER = [string]$dbContainers[0]
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $python) { throw "Python is required for the local M05 authorization acceptance." }
  & $python.Source (Join-Path $repoRoot "scripts\windows_m05_authorization_acceptance.py")
  if ($LASTEXITCODE -ne 0) { throw "The authenticated M05 local authorization acceptance failed." }
} finally {
  foreach ($name in @("JOBHUNT_M02_SUPABASE_URL", "JOBHUNT_M02_PUBLISHABLE_KEY", "JOBHUNT_M02_SERVICE_KEY", "JOBHUNT_M02_DB_CONTAINER")) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}
