[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FixtureDirectory
)

$ErrorActionPreference = "Stop"
$resolvedFixtureDirectory = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$wordExe = Join-Path $env:ProgramFiles "Microsoft Office\root\Office16\WINWORD.EXE"
if (-not (Test-Path -LiteralPath $wordExe)) { throw "Microsoft Word is required for actual DOCX pagination verification." }

$existingWordPids = @((Get-Process WINWORD -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id))
$wordDialogType = @"
using System;
using System.Runtime.InteropServices;
public static class M06WordDialog {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="FindWindowW")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", EntryPoint="PostMessageW")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
"@
Add-Type $wordDialogType
$word = $null
$wordPid = $null
$ownedWord = $false
$documents = [System.Collections.Generic.List[object]]::new()
$results = [System.Collections.Generic.List[object]]::new()
$reportPath = Join-Path $resolvedFixtureDirectory "m06-word-pagination.json"
$report = [ordered]@{
  result = "RUNNING"
  renderer = "Microsoft Word COM pagination"
  executable = $wordExe
  wordVersion = $null
  processId = $null
  fixtures = @()
  cleanup = @{ wordExited = $false; documentsClosed = $false; normalQuitSucceeded = $false; gracefulProcessExit = $false; forcedTermination = $false; officeSetupDialogDismissed = $false }
  limitation = "DOCX pagination is measured by the installed Microsoft Word 16 renderer. Office reports an expired licence; the runner never signs in and stops only its own process if Word remains after Quit."
}

function Close-M06WordSetupDialog([int]$expectedPid) {
  $dialog = [M06WordDialog]::FindWindow($null, "Sign in to set up Office")
  if ($dialog -eq [IntPtr]::Zero) { return $false }
  $owner = [uint32]0
  [void][M06WordDialog]::GetWindowThreadProcessId($dialog, [ref]$owner)
  if ([int]$owner -ne $expectedPid) { throw "A similarly titled setup window belongs to a process the test did not start." }
  if (-not [M06WordDialog]::PostMessage($dialog, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw "Could not close the test-owned Office setup prompt without entering credentials." }
  Start-Sleep -Milliseconds 300
  if ([M06WordDialog]::FindWindow($null, "Sign in to set up Office") -ne [IntPtr]::Zero) { throw "The test-owned Office setup prompt did not close." }
  $report.cleanup.officeSetupDialogDismissed = $true
  return $true
}

try {
  $word = New-Object -ComObject Word.Application
  $newWordProcesses = @()
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ([DateTime]::UtcNow -lt $deadline -and $newWordProcesses.Count -eq 0) {
    $newWordProcesses = @((Get-Process WINWORD -ErrorAction SilentlyContinue) | Where-Object { $existingWordPids -notcontains $_.Id })
    if ($newWordProcesses.Count -eq 0) { Start-Sleep -Milliseconds 200 }
  }
  if ($newWordProcesses.Count -ne 1) { throw "Could not uniquely identify a test-owned Word process; no existing Word process will be closed." }
  $wordPid = [int]$newWordProcesses[0].Id
  $ownedWord = $true
  $report.wordVersion = [string]$word.Version
  $report.processId = $wordPid
  $word.Visible = $true
  $word.DisplayAlerts = 0
  $word.Options.SaveNormalPrompt = $false
  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    if (Close-M06WordSetupDialog $wordPid) { break }
    Start-Sleep -Milliseconds 200
  }

  $themes = @("classic-navy", "clean-charcoal", "technical-slate", "research-classic", "modern-teal", "engineering-blue", "quiet-olive", "minimal-black")
  foreach ($theme in $themes) {
    foreach ($kind in @("cv", "letter")) {
      $path = Join-Path $resolvedFixtureDirectory ($theme + "-" + $kind + ".docx")
      if (-not (Test-Path -LiteralPath $path)) { throw "Missing generated fixture: $theme-$kind.docx" }
      $document = $word.Documents.Open($path, $false, $true, $false)
      $documents.Add($document)
      [void](Close-M06WordSetupDialog $wordPid)
      $pageCount = [int]$document.ComputeStatistics(2)
      $paperSize = [int]$document.PageSetup.PaperSize
      $pageWidth = [double]$document.PageSetup.PageWidth
      $pageHeight = [double]$document.PageSetup.PageHeight
      if ($paperSize -ne 7 -or [Math]::Abs($pageWidth - 595.28) -gt 1.5 -or [Math]::Abs($pageHeight - 841.89) -gt 1.5) {
        throw "$theme $kind DOCX did not paginate as A4 ($paperSize, $pageWidth x $pageHeight points)."
      }
      $pageWordCounts = @()
      for ($pageNumber = 1; $pageNumber -le $pageCount; $pageNumber++) {
        $pageStart = [int]$document.GoTo(1, 1, $pageNumber).Start
        $pageEnd = if ($pageNumber -lt $pageCount) { [int]$document.GoTo(1, 1, $pageNumber + 1).Start - 1 } else { [int]$document.Content.End }
        if ($pageEnd -lt $pageStart) { $pageEnd = $pageStart }
        $pageWordCounts += [int]$document.Range($pageStart, $pageEnd).ComputeStatistics(0)
      }
      if ($kind -eq "cv" -and $pageCount -ne 2) { throw "$theme CV DOCX should use two pages, observed $pageCount." }
      if ($kind -eq "cv" -and $pageCount -eq 2 -and $pageWordCounts[1] -lt 100) { throw "$theme CV DOCX page 2 is too sparse ($($pageWordCounts[1]) words)." }
      if ($kind -eq "letter" -and $pageCount -ne 1) { throw "$theme cover-letter DOCX should fit on one page, observed $pageCount." }

      $results.Add([ordered]@{ theme = $theme; kind = $kind; pages = $pageCount; pageWordCounts = $pageWordCounts; paper = "A4"; renderer = "Microsoft Word 16" })
      $document.Close(0)
      $documents.Remove($document) | Out-Null
    }
  }
  $report.fixtures = @($results)
  $report.result = "PASS"
} catch {
  $report.result = "FAIL"
  $report.error = $_.Exception.Message
  throw
} finally {
  foreach ($document in $documents) {
    try { $document.Close(0) } catch { $report.cleanup.documentsCloseError = $_.Exception.Message }
  }
  $report.cleanup.documentsClosed = ($documents.Count -eq 0)
  if ($word -and $ownedWord) {
    try { $word.Quit(); $report.cleanup.normalQuitSucceeded = $true } catch { $report.cleanup.wordQuitError = $_.Exception.Message }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
    $word = $null
    $report.cleanup.gracefulProcessExit = -not [bool](Get-Process -Id $wordPid -ErrorAction SilentlyContinue)
    if (-not $report.cleanup.gracefulProcessExit) {
      Stop-Process -Id $wordPid -Force
      $report.cleanup.forcedTermination = $true
    }
    try { Wait-Process -Id $wordPid -Timeout 20 -ErrorAction Stop; $report.cleanup.wordExited = $true }
    catch { $report.cleanup.wordExited = -not [bool](Get-Process -Id $wordPid -ErrorAction SilentlyContinue) }
    if ($report.result -eq "PASS" -and $report.cleanup.forcedTermination) { $report.result = "PASS_WITH_REPORTED_FORCED_SHUTDOWN" }
    elseif ($report.result -eq "PASS" -and -not $report.cleanup.normalQuitSucceeded) { $report.result = "PASS_WITH_REPORTED_QUIT_FAILURE" }
  } elseif (-not $word) {
    $report.cleanup.wordExited = $true
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
  if (-not $report.cleanup.documentsClosed -or ($ownedWord -and -not $report.cleanup.wordExited)) {
    throw "Word or a fixture document did not clean up. See $reportPath"
  }
}

Get-Content -Raw -LiteralPath $reportPath
