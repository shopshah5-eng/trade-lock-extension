@echo off
echo Stopping Trade Lock Background Server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conns = Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue; if ($conns) { $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host 'Trade Lock background server stopped.' } else { Write-Host 'No Trade Lock server was running on port 8787.' }"
pause
