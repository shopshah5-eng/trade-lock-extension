@echo off
echo Starting Trade Lock Server in Background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$proc = Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue; if ($proc) { Write-Host 'Trade Lock server is already running on port 8787.' } else { Start-Process node -ArgumentList 'server/index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden; Start-Sleep -Seconds 2; Write-Host 'Trade Lock server started successfully in background on port 8787.' }"
pause
