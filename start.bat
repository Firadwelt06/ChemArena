@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22 LTS or newer, then run this launcher again.
  pause
  exit /b 1
)

if not exist "apps\server\.env" (
  copy "apps\server\.env.example" "apps\server\.env" >nul
  echo Created apps\server\.env with default LAN settings.
)

call npm install
if errorlevel 1 goto :failed
call npm install-scripts approve @prisma/client @prisma/engines prisma argon2 esbuild
if errorlevel 1 echo Continuing; dependencies may already have their install scripts enabled.
call npm run db:generate
if errorlevel 1 goto :failed
call npm run db:push
if errorlevel 1 goto :failed
call npm run db:seed
if errorlevel 1 goto :failed
call npm run build
if errorlevel 1 goto :failed

echo.
echo ChemArena is starting. Keep this window open.
echo On this laptop: http://localhost:4174
echo Students: ask the admin dashboard for the LAN join URL.
echo.
:run_server
call npm run start --workspace @chemarena/server
if errorlevel 75 if not errorlevel 76 goto :run_server
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo ChemArena could not start. Review the error above and the README troubleshooting section.
pause
exit /b 1
