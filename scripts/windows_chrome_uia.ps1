[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][ValidateSet('Button','Edit','Text','ComboBox','CheckBox','ToggleButton','TabItem')][string]$ControlType,
  [Parameter(Mandatory=$true)][ValidateSet('Find','CompareValue','ReadToggle')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Name
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobHuntM04UiaNative {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
'@

$hwnd = [IntPtr]::new($WindowHandle)
$ownerPid = [uint32]0
[void][JobHuntM04UiaNative]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ($ownerPid -ne [uint32]$ProcessId) {
  throw 'The requested UI Automation window does not belong to the test-owned Chrome process.'
}

$controlTypes = @{
  Button = [System.Windows.Automation.ControlType]::Button
  Edit = [System.Windows.Automation.ControlType]::Edit
  Text = [System.Windows.Automation.ControlType]::Text
  ComboBox = [System.Windows.Automation.ControlType]::ComboBox
  CheckBox = [System.Windows.Automation.ControlType]::CheckBox
  ToggleButton = [System.Windows.Automation.ControlType]::Button
  TabItem = [System.Windows.Automation.ControlType]::TabItem
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$nameCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
$typeCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlTypes[$ControlType])
$condition = [System.Windows.Automation.AndCondition]::new($nameCondition, $typeCondition)
$matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$element = $null
for ($i = 0; $i -lt $matches.Count; $i++) {
  $candidate = $matches.Item($i)
  if ($candidate.Current.IsEnabled -and -not $candidate.Current.IsOffscreen) {
    $element = $candidate
    break
  }
}

if (-not $element) {
  @{ found = $false; requestedControl = $ControlType; requestedName = $Name } |
    ConvertTo-Json -Compress
  exit 0
}

$result = @{
  found = $true
  name = $Name
  controlType = $ControlType
  enabled = $element.Current.IsEnabled
}

if ($Action -eq 'Find') {
  $bounds = $element.Current.BoundingRectangle
  $result.bounds = @{
    x = $bounds.Left
    y = $bounds.Top
    width = $bounds.Width
    height = $bounds.Height
  }
  $result.isKeyboardFocusable = $element.Current.IsKeyboardFocusable
  $result.hasValuePattern = $element.Current.IsValuePatternAvailable
  $result.hasTogglePattern = $element.Current.IsTogglePatternAvailable
}
elseif ($Action -eq 'CompareValue') {
  $inputText = [Console]::In.ReadToEnd()
  $inputData = $inputText | ConvertFrom-Json
  if (-not ($inputData.expectedValue -is [string])) {
    throw 'The UI Automation value comparison did not receive a string value.'
  }
  if (-not $element.Current.IsValuePatternAvailable) {
    $result.valuePatternAvailable = $false
    $result.matchesExpected = $false
  }
  else {
    $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $actualValue = [string]$valuePattern.Current.Value
    $result.valuePatternAvailable = $true
    $result.matchesExpected = $actualValue -ceq $inputData.expectedValue
    $result.valueLength = $actualValue.Length
  }
}
elseif ($Action -eq 'ReadToggle') {
  if ($element.Current.IsTogglePatternAvailable) {
    $toggle = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $result.toggleState = $toggle.Current.ToggleState.ToString()
  }
  else {
    $result.toggleState = 'unavailable'
  }
}

$result | ConvertTo-Json -Depth 4 -Compress
