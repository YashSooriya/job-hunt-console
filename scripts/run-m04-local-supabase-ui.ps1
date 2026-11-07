[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$EvidenceDir = "",
  [switch]$KeepWorkspace,
  [switch]$RealBridgeCheck
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runId = [Guid]::NewGuid().ToString("N")
$tempRoot = [IO.Path]::GetFullPath($env:TEMP)
$runRoot = Join-Path $tempRoot ("JobHuntAI-M04-Runner-" + $runId)
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$nodeRoot = Join-Path $env:LOCALAPPDATA "Programs\JobHuntAI\node-v24.22.2-win-x64"
if (Test-Path -LiteralPath (Join-Path $nodeRoot "node.exe")) { $env:PATH = "$nodeRoot;$env:PATH" }

$localStatus = $null
$edgeProcess = $null
$overlayDir = "/tmp/job-hunt-m04-overlay-$runId"
$linuxPidFile = "/tmp/job-hunt-m04-edge-$runId.pid"
$linuxLogPath = "/mnt/c/Users/yashw/AppData/Local/Temp/JobHuntAI-M04-Runner-$runId/edge-function.log"
$edgeStarted = $false
$overlayFiles = @(
  @{ Source = "supabase/functions/chatgpt-bridge/index.ts"; Target = "supabase/functions/chatgpt-bridge/index.ts" },
  @{ Source = "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts"; Target = "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts" },
  @{ Source = "apps/web/lib/job-fit-memory-v4/response.ts"; Target = "apps/web/lib/job-fit-memory-v4/response.ts" },
  @{ Source = "apps/web/lib/job-fit-memory-v4/contract.ts"; Target = "apps/web/lib/job-fit-memory-v4/contract.ts" }
)
$overlayApplied = $false

function Invoke-WslChecked([string[]]$Arguments, [string]$Failure) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & wsl.exe -d Ubuntu-24.04 -u root -- @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) { throw "$Failure (exit code $exitCode)." }
  return $output
}

try {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $node -or -not $python) { throw "Node.js and Python are required for the isolated local UI runner." }
  $config = Invoke-WslChecked @("/usr/bin/cat", "$SupabaseWorkdir/supabase/config.toml") "The local Supabase workdir has no config.toml."
  $projectMatch = [regex]::Match(($config -join "`n"), '(?m)^\s*project_id\s*=\s*"([^"]+)"')
  if (-not $projectMatch.Success) { throw "Could not resolve the local Supabase project id." }
  $projectId = $projectMatch.Groups[1].Value

  $statusOutput = Invoke-WslChecked @("/usr/local/bin/supabase", "status", "--workdir", $SupabaseWorkdir, "--output", "json") "The local Supabase stack is not running; no hosted endpoint was accessed."
  $statusText = $statusOutput -join "`n"
  $start = $statusText.IndexOf("{")
  $end = $statusText.LastIndexOf("}")
  if ($start -lt 0 -or $end -lt $start) { throw "The local Supabase CLI did not return status JSON." }
  $localStatus = $statusText.Substring($start, $end - $start + 1) | ConvertFrom-Json
  $apiUri = [Uri]$localStatus.API_URL
  if ($apiUri.Scheme -ne "http" -or $apiUri.Host -notin @("127.0.0.1", "localhost")) {
    throw "The M04 runner accepts only a local loopback Supabase API."
  }
  $containerLines = Invoke-WslChecked @("podman", "ps", "--filter", ("label=com.supabase.cli.project=" + $projectId), "--format", "{{.Names}}") "Could not inspect the local Podman project."
  $dbContainers = @($containerLines | Where-Object { $_ -match '^supabase_db_' })
  if ($dbContainers.Count -ne 1) { throw "Expected exactly one local Supabase database container." }

  $wslMigrations = "$SupabaseWorkdir/supabase/migrations"
  Invoke-WslChecked @("/usr/bin/mkdir", "-p", $wslMigrations) "Could not prepare the local migration directory." | Out-Null
  foreach ($migration in @("20261106212716_combined_job_url_memory_fit.sql", "20261106220538_m04_terminal_fit_outcomes.sql", "20261106224247_skip_pool_dirty_for_deleted_users.sql", "20261107090000_m04_batch_recovery_and_identity.sql", "20261107150039_m04_dispatch_lookup_schema_cache.sql", "20261107150350_m04_batch_dispatch_lookup_rpc.sql")) {
    $source = Join-Path $repoRoot ("database\migrations\" + $migration)
    if (-not (Test-Path -LiteralPath $source)) { throw "Required M04 local migration is missing: $migration" }
    $sourceWsl = "/mnt/c/" + $source.Substring(3).Replace("\", "/")
    Invoke-WslChecked @("/usr/bin/cp", $sourceWsl, "$wslMigrations/$migration") "Could not stage the M04 migration into the disposable local Supabase workdir." | Out-Null
  }
  Invoke-WslChecked @("/usr/local/bin/supabase", "migration", "up", "--local", "--workdir", $SupabaseWorkdir) "The M04 migrations could not be applied to the local-only Supabase database." | Out-Null

  Invoke-WslChecked @("/usr/bin/mkdir", "-p", $overlayDir) "Could not create the exact local Edge-source backup directory." | Out-Null
  foreach ($entry in $overlayFiles) {
    $target = "$SupabaseWorkdir/$($entry.Target)"
    Invoke-WslChecked @("/usr/bin/mkdir", "-p", (Split-Path -Parent $target)) "Could not prepare an Edge source directory." | Out-Null
    Invoke-WslChecked @("/usr/bin/cp", $target, "$overlayDir/$($entry.Target.Replace('/', '__'))") "Could not preserve the current local Edge source before overlay." | Out-Null
    $source = Join-Path $repoRoot $entry.Source
    $sourceWsl = "/mnt/c/" + $source.Substring(3).Replace("\", "/")
    Invoke-WslChecked @("/usr/bin/cp", $sourceWsl, $target) "Could not overlay the checked-out M04 Edge source into the disposable local workdir." | Out-Null
  }
  $overlayApplied = $true

  $edgeScript = Join-Path $repoRoot "scripts\fixtures\m04-local-edge-serve.sh"
  $edgeScriptWsl = "/mnt/c/" + $edgeScript.Substring(3).Replace("\", "/")
  $edgeOut = Join-Path $runRoot "edge-wrapper.out.log"
  $edgeErr = Join-Path $runRoot "edge-wrapper.err.log"
  $edgeProcess = Start-Process -FilePath (Join-Path $env:WINDIR "System32\wsl.exe") `
    -ArgumentList @("-d", "Ubuntu-24.04", "-u", "root", "--", "/usr/bin/bash", $edgeScriptWsl, $SupabaseWorkdir, $linuxLogPath, $linuxPidFile) `
    -WorkingDirectory $runRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $edgeOut -RedirectStandardError $edgeErr
  $deadline = [DateTime]::UtcNow.AddSeconds(50)
  $edgeReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($edgeProcess.HasExited) { throw "The test-owned WSL Edge function process exited before readiness." }
    try {
      $response = Invoke-WebRequest -Uri ($apiUri.AbsoluteUri.TrimEnd("/") + "/functions/v1/chatgpt-bridge") -Method Get -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ([int]$response.StatusCode -in @(200, 404, 405)) { $edgeReady = $true; break }
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -in @(404, 405)) { $edgeReady = $true; break }
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not $edgeReady) { throw "The local chatgpt-bridge Edge function did not become available on loopback." }
  $edgeStarted = $true

  $env:JOBHUNT_M02_SUPABASE_URL = [string]$localStatus.API_URL
  $env:JOBHUNT_M02_PUBLISHABLE_KEY = [string]$localStatus.PUBLISHABLE_KEY
  $env:JOBHUNT_M02_SERVICE_KEY = [string]$localStatus.SERVICE_ROLE_KEY
  $env:JOBHUNT_M02_DB_CONTAINER = [string]$dbContainers[0]
  $runner = Join-Path $repoRoot "scripts\windows_m04_combined_import_acceptance.py"
  $runnerArgs = @($runner, "--source-root", $repoRoot)
  if ($EvidenceDir) { $runnerArgs += @("--evidence-dir", $EvidenceDir) }
  if ($KeepWorkspace) { $runnerArgs += "--keep-workspace" }
  if ($RealBridgeCheck) { $runnerArgs += "--real-bridge-check" }
  & $python.Source @runnerArgs
  $runnerExit = $LASTEXITCODE
  if ($runnerExit -ne 0) { exit $runnerExit }
} finally {
  if ($edgeStarted -or $edgeProcess) {
    $pidLines = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/cat $linuxPidFile 2>$null
    $linuxPid = if ($pidLines -match '^\d+$') { [int]$pidLines } else { 0 }
    if ($linuxPid -gt 1) {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $cmdline = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/ps -p $linuxPid -o args= 2>$null
        $processLookupExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($processLookupExit -eq 0 -and ($cmdline -join " ") -match 'supabase functions serve chatgpt-bridge') {
        Invoke-WslChecked @("/usr/bin/kill", "-TERM", [string]$linuxPid) "Could not stop the test-owned local Edge function process." | Out-Null
      }
    }
    if ($edgeProcess -and -not $edgeProcess.HasExited) {
      try { Wait-Process -Id $edgeProcess.Id -Timeout 8 -ErrorAction Stop } catch { }
      if (-not $edgeProcess.HasExited) { Stop-Process -Id $edgeProcess.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($linuxPid -gt 1) {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $stillRunning = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/ps -p $linuxPid -o pid= 2>$null
        $processLookupExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($processLookupExit -eq 0 -and ($stillRunning -join " ").Trim()) {
        throw "The test-owned local Edge process did not exit cleanly (Linux PID $linuxPid)."
      }
    }
  }
  if ($overlayApplied) {
    foreach ($entry in $overlayFiles) {
      $target = "$SupabaseWorkdir/$($entry.Target)"
      $backup = "$overlayDir/$($entry.Target.Replace('/', '__'))"
      & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/cp $backup $target 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Could not restore the exact pre-test local Edge source file: $($entry.Target)" }
    }
  }
  if ($overlayDir -notmatch '^/tmp/job-hunt-m04-overlay-[0-9a-f]{32}$') {
    throw "Refusing to remove an unexpected M04 overlay path: $overlayDir"
  }
  & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/rm -rf $overlayDir 2>$null | Out-Null
  & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/rm -f $linuxPidFile 2>$null | Out-Null
  Remove-Item Env:JOBHUNT_M02_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_PUBLISHABLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_SERVICE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:JOBHUNT_M02_DB_CONTAINER -ErrorAction SilentlyContinue
  if (-not $KeepWorkspace) {
    $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
    $tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedRunRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $resolvedRunRoot -notmatch '\\JobHuntAI-M04-Runner-[0-9a-f]{32}$') {
      throw "Refusing to remove an unexpected M04 runner workspace: $resolvedRunRoot"
    }
    if (Test-Path -LiteralPath $resolvedRunRoot) {
      Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
    }
  }
}
