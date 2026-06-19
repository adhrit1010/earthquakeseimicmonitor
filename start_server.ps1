$ErrorActionPreference = 'Stop'

$Docs = -join ([char]0x30C9, [char]0x30AD, [char]0x30E5, [char]0x30E1, [char]0x30F3, [char]0x30C8)
$Root = Join-Path (Join-Path $env:OneDrive $Docs) 'machine learning\triaxis_dynamic_site'
$Python = 'C:\Users\adhri\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'

Set-Location -LiteralPath $Root
$env:PORT = '8787'

& $Python -u server.py 1>> (Join-Path $Root 'server.out.log') 2>> (Join-Path $Root 'server.err.log')
