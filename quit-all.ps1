# Force-quit every DeepSeek Harness process after the tray item starts a
# graceful quit. ASCII only, because Windows PowerShell 5.1 reads a BOM-less
# file as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$self = $PID
Start-Sleep -Milliseconds 1200

$install = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$patterns = @(
  'dsh-desktop-host',
  '\.dsh\\profiles',
  'rea-agents',
  '@dsh-ops',
  'windows-mcp',
  'github-mcp-server'
)
$names = @('github-mcp-server.exe', 'windows-mcp.exe', 'DeepSeek Harness.exe')

Get-CimInstance Win32_Process | ForEach-Object {
  $p = $_
  if ($p.ProcessId -eq $self) { return }
  $hit = $false
  if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($install, [System.StringComparison]::OrdinalIgnoreCase)) {
    $hit = $true
  }
  if (-not $hit -and $p.CommandLine -and $p.CommandLine.IndexOf($install, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    $hit = $true
  }
  if (-not $hit -and $p.Name -and ($names -contains $p.Name)) {
    $hit = $true
  }
  if (-not $hit -and $p.CommandLine) {
    foreach ($pat in $patterns) {
      if ($p.CommandLine -match $pat) { $hit = $true; break }
    }
  }
  if ($hit) { Stop-Process -Id $p.ProcessId -Force }
}
