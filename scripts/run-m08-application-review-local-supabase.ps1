[CmdletBinding()]
param(
  [string]$SupabaseWorkdir = "/tmp/jobhuntai-m02-local-1EJyDw",
  [string]$ExpectedProjectId = "jobhuntai-m02-local-20261106",
  [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-m07-document-generation-local-supabase.ps1"
& $runner -SupabaseWorkdir $SupabaseWorkdir -ExpectedProjectId $ExpectedProjectId -EvidenceDir $EvidenceDir -IncludeM08
