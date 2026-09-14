<#
  Shortcut for the npm scripts in package.json, for when you'd rather type .\dev.ps1 than npm run.

    .\dev.ps1 build              compile the Cairo contract
    .\dev.ps1 test               run the TypeScript tests in Docker against devnet
    .\dev.ps1 test-local         same tests, with your Windows Node
    .\dev.ps1 deploy             deploy to devnet, write tests/deployment.json
    .\dev.ps1 up | logs | reset | down | fmt | clean | shell | typecheck

  Anything else is passed straight to npm run, so `.\dev.ps1 test -t disputes` works
  and any script added to package.json is available here without touching this file.
#>
param(
  [Parameter(Position = 0)] [string] $Command = "help",
  [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest
)

# Docker and npm write progress to stderr; Windows PowerShell 5.1 would treat that as an error.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
if ($null -eq $Rest) { $Rest = @() }

if ($Command -in @("help", "-h", "--help")) {
  Get-Help $PSCommandPath
  exit 0
}

# dash-style names map to the npm colon convention: test-local -> test:local
$script = $Command -replace "-", ":"

# npm needs exactly one "--" before script arguments; add it ourselves so both
# `.\dev.ps1 test -t foo` and `.\dev.ps1 test -- -t foo` behave the same.
if ($Rest.Count -gt 0 -and $Rest[0] -eq "--") { $Rest = $Rest[1..($Rest.Count - 1)] }

if ($Rest.Count -gt 0) {
  npm run $script -- @Rest
} else {
  npm run $script
}
exit $LASTEXITCODE
