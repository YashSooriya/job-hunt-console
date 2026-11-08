[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$ExpectedProjectId = "jobhuntai-m02-local-20261106",
  [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tempRoot = [IO.Path]::GetFullPath($env:TEMP)
$runId = [Guid]::NewGuid().ToString("N")
$runRoot = Join-Path $tempRoot ("JobHuntAI-M07-Runner-" + $runId)
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$evidenceRoot = if ($EvidenceDir) { [IO.Path]::GetFullPath($EvidenceDir) } else { Join-Path $tempRoot "JobHuntAI-M07-Evidence" }
$evidenceDir = Join-Path $evidenceRoot $runId
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$overlayDir = "/tmp/job-hunt-m07-overlay-$runId"
$linuxPidFile = "/tmp/job-hunt-m07-edge-$runId.pid"
$linuxLogPath = ("/mnt/c/" + (Join-Path $runRoot "edge-function.log").Substring(3).Replace("\", "/"))
$edgeProcess = $null
$edgeChildPid = 0
$overlayEntries = @()
$previousEnvironment = @{}
$edgeScriptProcess = $null
$localStatus = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$runnerSummary = $null
$reportPath = $null
$runnerOutput = @()
$failureMessage = $null
$bridgeStopped = $false

$overlayFiles = @(
  @{ Source = "supabase/functions/chatgpt-bridge/index.ts"; Target = "supabase/functions/chatgpt-bridge/index.ts" },
  @{ Source = "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts"; Target = "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts" },
  @{ Source = "apps/web/lib/job-fit-memory-v4/response.ts"; Target = "apps/web/lib/job-fit-memory-v4/response.ts" },
  @{ Source = "apps/web/lib/job-fit-memory-v4/contract.ts"; Target = "apps/web/lib/job-fit-memory-v4/contract.ts" }
)

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

function ConvertTo-WslPath([string]$WindowsPath) {
  $fullPath = [IO.Path]::GetFullPath($WindowsPath)
  if ($fullPath -notmatch '^[A-Za-z]:\\') { throw "Expected a local drive path for WSL staging." }
  return "/mnt/" + $fullPath.Substring(0, 1).ToLowerInvariant() + "/" + $fullPath.Substring(3).Replace("\", "/")
}

function Read-OptionalLinuxPid([string]$Path) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $value = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/cat $Path 2>$null
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  $text = ($value -join "").Trim()
  if ($exitCode -eq 0 -and $text -match '^\d+$') { return [int]$text }
  return 0
}

function Restore-Environment {
  foreach ($name in $previousEnvironment.Keys) {
    $value = $previousEnvironment[$name]
    if ($null -eq $value) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { Set-Item ("Env:" + $name) -Value $value }
  }
}

try {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $node -or -not $python) { throw "Node.js and Python are required for the isolated M07 acceptance runner." }

  $config = Invoke-WslChecked @("/usr/bin/cat", "$SupabaseWorkdir/supabase/config.toml") "The local Supabase workdir has no config.toml."
  $projectMatch = [regex]::Match(($config -join "`n"), '(?m)^\s*project_id\s*=\s*"([^"]+)"')
  if (-not $projectMatch.Success -or $projectMatch.Groups[1].Value -ne $ExpectedProjectId) {
    throw "Refusing M07 acceptance outside the exact disposable local Supabase project."
  }

  $statusOutput = Invoke-WslChecked @("/usr/local/bin/supabase", "status", "--workdir", $SupabaseWorkdir, "--output", "json") "The disposable local Supabase stack is not running."
  $statusText = $statusOutput -join "`n"
  $start = $statusText.IndexOf("{")
  $end = $statusText.LastIndexOf("}")
  if ($start -lt 0 -or $end -lt $start) { throw "The local Supabase CLI did not return status JSON." }
  $localStatus = $statusText.Substring($start, $end - $start + 1) | ConvertFrom-Json
  $apiUri = [Uri]$localStatus.API_URL
  if ($apiUri.Scheme -ne "http" -or $apiUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
    throw "M07 acceptance accepts only a loopback Supabase API."
  }
  $containerLines = Invoke-WslChecked @("podman", "ps", "--filter", ("label=com.supabase.cli.project=" + $ExpectedProjectId), "--format", "{{.Names}}") "Could not inspect the local Podman project."
  $dbContainers = @($containerLines | Where-Object { $_ -match '^supabase_db_' })
  if ($dbContainers.Count -ne 1 -or $dbContainers[0] -ne "supabase_db_jobhuntai-m02-local-20261106") {
    throw "M07 acceptance did not find the single expected local database container."
  }

  $migrations = @(
    "20261107211016_m07_document_generation_drive_recovery.sql",
    "20261107224400_m07_document_version_write_boundary.sql",
    "20261107233000_m07_document_finalize_kind_cast.sql",
    "20261107235000_m07_reload_postgrest_schema.sql",
    "20261108000000_m07_drive_publish_rpcs_repair.sql",
    "20261108004205_m07_renderer_retry_classification.sql",
    "20261108005340_m07_memory_cv_trigger.sql"
  )
  Invoke-WslChecked @("/usr/bin/mkdir", "-p", "$SupabaseWorkdir/supabase/migrations") "Could not prepare the local migration directory." | Out-Null
  foreach ($migration in $migrations) {
    $sourceMigration = Join-Path $repoRoot ("database\migrations\" + $migration)
    if (-not (Test-Path -LiteralPath $sourceMigration)) { throw "The M07 forward migration is missing: $migration" }
    $sourceMigrationWsl = ConvertTo-WslPath $sourceMigration
    Invoke-WslChecked @("/usr/bin/cp", $sourceMigrationWsl, "$SupabaseWorkdir/supabase/migrations/$migration") "Could not stage M07 into the disposable local Supabase workdir." | Out-Null
  }
  Invoke-WslChecked @("/usr/local/bin/supabase", "migration", "up", "--local", "--workdir", $SupabaseWorkdir) "The M07 migration could not be applied to the local-only database." | Out-Null
  $history = Invoke-WslChecked @("/usr/local/bin/supabase", "migration", "list", "--local", "--workdir", $SupabaseWorkdir) "Could not verify local M07 migration history."
  foreach ($version in @("20261107211016", "20261107224400", "20261107233000", "20261107235000", "20261108000000", "20261108004205", "20261108005340")) {
    $migrationPattern = "(?m)^\s*\x60?" + $version + "\x60?\s+\|\s+\x60?" + $version + "\x60?\s+\|"
    if (($history -join "`n") -notmatch $migrationPattern) {
      throw "M07 migration $version is not recorded as applied in both local migration columns."
    }
  }

  Invoke-WslChecked @("/usr/bin/mkdir", "-p", $overlayDir) "Could not create the local Edge-source backup directory." | Out-Null
  foreach ($entry in $overlayFiles) {
    $target = "$SupabaseWorkdir/$($entry.Target)"
    $backup = "$overlayDir/$($entry.Target.Replace('/', '__'))"
    Invoke-WslChecked @("/usr/bin/mkdir", "-p", (Split-Path -Parent $target)) "Could not prepare the local Edge source directory." | Out-Null
    Invoke-WslChecked @("/usr/bin/cp", $target, $backup) "Could not preserve the local Edge source before overlay." | Out-Null
    $overlayEntries += [pscustomobject]@{ Target = $target; Backup = $backup }
    $source = Join-Path $repoRoot $entry.Source
    if (-not (Test-Path -LiteralPath $source)) { throw "The current branch is missing local Edge source: $($entry.Source)" }
    Invoke-WslChecked @("/usr/bin/cp", (ConvertTo-WslPath $source), $target) "Could not overlay the current branch Edge source into the disposable local workdir." | Out-Null
  }

  $edgeScriptSource = Join-Path $repoRoot "scripts\fixtures\m04-local-edge-serve.sh"
  $edgeScriptText = [IO.File]::ReadAllText($edgeScriptSource).Replace("`r`n", "`n").Replace("`r", "`n")
  $edgeScriptWindows = Join-Path $runRoot "m07-edge-serve.sh"
  [IO.File]::WriteAllText($edgeScriptWindows, $edgeScriptText, [Text.UTF8Encoding]::new($false))
  $edgeScript = ConvertTo-WslPath $edgeScriptWindows
  $edgeOut = Join-Path $runRoot "edge-wrapper.out.log"
  $edgeErr = Join-Path $runRoot "edge-wrapper.err.log"
  $edgeProcess = Start-Process -FilePath (Join-Path $env:WINDIR "System32\wsl.exe") `
    -ArgumentList @("-d", "Ubuntu-24.04", "-u", "root", "--", "/usr/bin/bash", $edgeScript, $SupabaseWorkdir, $linuxLogPath, $linuxPidFile) `
    -WorkingDirectory $runRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $edgeOut -RedirectStandardError $edgeErr

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $edgeReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($edgeChildPid -le 1) {
      $edgeChildPid = Read-OptionalLinuxPid $linuxPidFile
    }
    if ($edgeProcess.HasExited -and $edgeChildPid -le 1) { throw "The test-owned local Edge Function process exited before publishing its process id." }
    try {
      $response = Invoke-WebRequest -Uri ($apiUri.AbsoluteUri.TrimEnd("/") + "/functions/v1/chatgpt-bridge") -Method Get -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ([int]$response.StatusCode -in @(200, 404, 405)) { $edgeReady = $true; break }
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -in @(404, 405)) { $edgeReady = $true; break }
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not $edgeReady) { throw "The local chatgpt-bridge Edge Function did not become available on loopback." }

  if ($edgeChildPid -le 1) {
    $pidLines = Invoke-WslChecked @("/usr/bin/cat", $linuxPidFile) "The test-owned Edge Function did not publish its PID."
    if (($pidLines -join "").Trim() -notmatch '^\d+$') { throw "The test-owned Edge Function PID file was invalid." }
    $edgeChildPid = [int](($pidLines -join "").Trim())
  }
  if ($edgeChildPid -le 1) { throw "The test-owned Edge Function PID was outside the valid process range." }
  $edgeCommand = Invoke-WslChecked @("/usr/bin/ps", "-p", [string]$edgeChildPid, "-o", "args=") "The recorded local Edge Function process is not running."
  if (($edgeCommand -join " ") -notmatch 'supabase functions serve chatgpt-bridge') { throw "The recorded local PID does not belong to the test-owned Edge Function." }

  $names = @("JOBHUNT_M02_SUPABASE_URL", "JOBHUNT_M02_PUBLISHABLE_KEY", "JOBHUNT_M02_SERVICE_KEY", "JOBHUNT_M02_DB_CONTAINER",
    "JOBHUNT_M03_SUPABASE_URL", "JOBHUNT_M03_PUBLISHABLE_KEY", "JOBHUNT_M03_SERVICE_KEY", "JOBHUNT_M03_DB_CONTAINER")
  foreach ($name in $names) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
  $env:JOBHUNT_M02_SUPABASE_URL = [string]$localStatus.API_URL
  $env:JOBHUNT_M02_PUBLISHABLE_KEY = [string]$localStatus.PUBLISHABLE_KEY
  $env:JOBHUNT_M02_SERVICE_KEY = [string]$localStatus.SERVICE_ROLE_KEY
  $env:JOBHUNT_M02_DB_CONTAINER = [string]$dbContainers[0]
  $env:JOBHUNT_M03_SUPABASE_URL = $env:JOBHUNT_M02_SUPABASE_URL
  $env:JOBHUNT_M03_PUBLISHABLE_KEY = $env:JOBHUNT_M02_PUBLISHABLE_KEY
  $env:JOBHUNT_M03_SERVICE_KEY = $env:JOBHUNT_M02_SERVICE_KEY
  $env:JOBHUNT_M03_DB_CONTAINER = $env:JOBHUNT_M02_DB_CONTAINER

  $runnerArgs = @((Join-Path $repoRoot "scripts\windows_m07_document_generation_acceptance.py"), "--evidence-dir", $evidenceDir)
  $runnerOutput = & $python.Source @runnerArgs
  $runnerExit = $LASTEXITCODE
  try {
    $runnerSummary = (($runnerOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
    $reportPath = [string]$runnerSummary.report
  } catch { }
  $runnerOutput | ForEach-Object { Write-Output $_ }
  if ($runnerExit -ne 0) { throw "The authenticated M07 local desktop acceptance failed with exit code $runnerExit." }
} catch {
  $failureMessage = $_.Exception.Message
  throw
} finally {
  if ($edgeChildPid -le 1) {
    $edgeChildPid = Read-OptionalLinuxPid $linuxPidFile
  }
  if ($edgeChildPid -gt 1) {
    $bridgeStopped = $false
    try {
      $lookup = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/ps -p $edgeChildPid -o args= 2>$null
      $lookupExit = $LASTEXITCODE
      if ($lookupExit -eq 0 -and ($lookup -join " ") -match 'supabase functions serve chatgpt-bridge') {
        Invoke-WslChecked @("/usr/bin/kill", "-TERM", [string]$edgeChildPid) "Could not stop the test-owned local Edge Function." | Out-Null
      } elseif ($lookupExit -eq 0 -and ($lookup -join " ").Trim()) {
        $cleanupErrors.Add("Recorded Linux PID $edgeChildPid no longer matched the expected Edge Function command.")
      } elseif ($lookupExit -gt 1) {
        $cleanupErrors.Add("Could not check the exact test-owned Edge Function PID.")
      }
      $deadline = [DateTime]::UtcNow.AddSeconds(8)
      do {
        Start-Sleep -Milliseconds 200
        $remaining = & wsl.exe -d Ubuntu-24.04 -u root -- /usr/bin/ps -p $edgeChildPid -o pid= 2>$null
        $remainingExit = $LASTEXITCODE
      } while ($remainingExit -eq 0 -and ($remaining -join " ").Trim() -and [DateTime]::UtcNow -lt $deadline)
      if ($remainingExit -eq 0 -and ($remaining -join " ").Trim()) {
        $cleanupErrors.Add("The exact test-owned Edge Function did not exit cleanly (Linux PID $edgeChildPid).")
      } elseif ($remainingExit -gt 1) {
        $cleanupErrors.Add("Could not verify that the exact Edge Function PID exited.")
      } else {
        $bridgeStopped = $true
      }
    } catch {
      $cleanupErrors.Add("Edge Function cleanup failed: $($_.Exception.Message)")
    }
    if ($reportPath -and (Test-Path -LiteralPath $reportPath)) {
      try {
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $report.cleanup.bridgeStoppedByRunner = $bridgeStopped
        $report.cleanup.bridgeFunctionPid = $edgeChildPid
        $report.cleanup.bridgeFunctionProcessExited = $bridgeStopped
        $edgeLog = Join-Path $runRoot "edge-function.log"
        if ($failureMessage -and (Test-Path -LiteralPath $edgeLog)) {
          $rawLog = [IO.File]::ReadAllText($edgeLog)
          foreach ($secretName in @("PUBLISHABLE_KEY", "SERVICE_ROLE_KEY", "ANON_KEY", "SECRET_KEY")) {
            if ($localStatus -and $localStatus.PSObject.Properties[$secretName] -and $localStatus.$secretName) {
              $rawLog = $rawLog.Replace([string]$localStatus.$secretName, "<redacted-key>")
            }
          }
          $rawLog = [regex]::Replace($rawLog, 'eyJ[A-Za-z0-9_=-]{32,}', '<redacted-token>')
          $rawLog = [regex]::Replace($rawLog, 'sb_(?:publishable|secret)_[A-Za-z0-9_-]+', '<redacted-key>')
          $rawLog = [regex]::Replace($rawLog, '(?i)(authorization\s*:\s*bearer\s+)\S+', '$1<redacted-token>')
          $bridgeLogPath = Join-Path $evidenceDir "bridge-function-log-redacted.txt"
          [IO.File]::WriteAllText($bridgeLogPath, ([string]::Join("`n", ($rawLog -split "`r?`n" | Select-Object -Last 100)) + "`n"), [Text.UTF8Encoding]::new($false))
          $report | Add-Member -NotePropertyName bridgeDiagnosticLog -NotePropertyValue $bridgeLogPath -Force
        }
        [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 40) + "`n", [Text.UTF8Encoding]::new($false))
      } catch { $cleanupErrors.Add("Could not record Edge Function cleanup state in the evidence report.") }
    }
  }
  if ($edgeProcess -and -not $edgeProcess.HasExited) {
    try {
      Wait-Process -Id $edgeProcess.Id -Timeout 8 -ErrorAction Stop
    } catch { }
    if (-not $edgeProcess.HasExited) {
      try { Stop-Process -Id $edgeProcess.Id -Force -ErrorAction Stop }
      catch { $cleanupErrors.Add("Could not close the test-owned WSL wrapper process.") }
    }
  }
  foreach ($entry in $overlayEntries) {
    try { Invoke-WslChecked @("/usr/bin/cp", $entry.Backup, $entry.Target) "Could not restore the exact pre-test local Edge source." | Out-Null }
    catch { $cleanupErrors.Add("Could not restore the exact pre-test local Edge source: $($entry.Target).") }
  }
  if ($overlayDir -match '^/tmp/job-hunt-m07-overlay-[0-9a-f]{32}$') {
    try { Invoke-WslChecked @("/usr/bin/rm", "-rf", $overlayDir) "Could not remove the exact temporary local Edge overlay." | Out-Null }
    catch { $cleanupErrors.Add("Could not remove the exact temporary local Edge overlay.") }
  } else { $cleanupErrors.Add("Refused to remove an unexpected local Edge overlay path.") }
  try { Invoke-WslChecked @("/usr/bin/rm", "-f", $linuxPidFile) "Could not remove the exact temporary local Edge PID file." | Out-Null }
  catch { $cleanupErrors.Add("Could not remove the exact temporary local Edge PID file.") }
  try { Restore-Environment }
  catch { $cleanupErrors.Add("Could not restore the current process environment after M07 acceptance.") }
  if (-not $reportPath) { $reportPath = Join-Path $evidenceDir "report.json" }
  if (-not (Test-Path -LiteralPath $reportPath)) {
    try {
      $edgeLog = Join-Path $runRoot "edge-function.log"
      $redactedLog = ""
      if (Test-Path -LiteralPath $edgeLog) {
        $rawLog = [IO.File]::ReadAllText($edgeLog)
        foreach ($secretName in @("PUBLISHABLE_KEY", "SERVICE_ROLE_KEY", "ANON_KEY", "SECRET_KEY")) {
          if ($localStatus -and $localStatus.PSObject.Properties[$secretName] -and $localStatus.$secretName) {
            $rawLog = $rawLog.Replace([string]$localStatus.$secretName, "<redacted-key>")
          }
        }
        $rawLog = [regex]::Replace($rawLog, 'eyJ[A-Za-z0-9_=-]{32,}', '<redacted-token>')
        $rawLog = [regex]::Replace($rawLog, 'sb_(?:publishable|secret)_[A-Za-z0-9_-]+', '<redacted-key>')
        $redactedLog = [string]::Join("`n", ($rawLog -split "`r?`n" | Select-Object -Last 80)) + "`n"
      }
      if ($failureMessage -and $redactedLog) { [IO.File]::WriteAllText((Join-Path $evidenceDir "edge-startup-log-redacted.txt"), $redactedLog, [Text.UTF8Encoding]::new($false)) }
      $initialReport = [ordered]@{
        schemaVersion = "1.0.0"; milestone = "M07"; startedBy = "PowerShell local acceptance runner"; result = "FAIL";
        error = $failureMessage; testRunReport = if ($runnerSummary) { $runnerSummary.report } else { $null };
        localSupabaseProject = $ExpectedProjectId; productionTouched = $false; liveChatGptActivity = $false; realGoogleDriveUsed = $false;
        cleanup = [ordered]@{ bridgeStoppedByRunner = if ($edgeChildPid -gt 1) { $bridgeStopped } else { $null }; bridgeFunctionPid = if ($edgeChildPid -gt 1) { $edgeChildPid } else { $null }; overlayRestoreErrors = $cleanupErrors.Count }
      }
      if ($redactedLog -and $failureMessage) { $initialReport["startupDiagnosticLog"] = Join-Path $evidenceDir "edge-startup-log-redacted.txt" }
      [IO.File]::WriteAllText($reportPath, ($initialReport | ConvertTo-Json -Depth 20) + "`n", [Text.UTF8Encoding]::new($false))
    } catch { $cleanupErrors.Add("Could not preserve the local M07 startup diagnostic report.") }
  }
  try {
    $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
    $tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedRunRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $resolvedRunRoot -notmatch '\\JobHuntAI-M07-Runner-[0-9a-f]{32}$') {
      throw "Refusing to remove an unexpected M07 runner workspace path."
    }
    if (Test-Path -LiteralPath $resolvedRunRoot) { Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force }
  } catch { $cleanupErrors.Add("Could not safely remove the M07 runner workspace.") }
  if ($cleanupErrors.Count -gt 0) { throw ("M07 cleanup incomplete: " + ($cleanupErrors -join " ")) }
}
