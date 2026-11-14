@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Inventario - servidor local (puerto 8000)
echo   NO cierre esta ventana mientras use la app
echo   Direccion: http://localhost:8000
echo ============================================
where python >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "timeout /t 2 >nul && start http://localhost:8000"
  python -m http.server 8000
  goto fin
)
where py >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "timeout /t 2 >nul && start http://localhost:8000"
  py -m http.server 8000
  goto fin
)
echo.
echo No se encontro Python en este equipo.
echo Instale Python 3 desde https://www.python.org/downloads/
echo y marque la casilla "Add Python to PATH" al instalar.
:fin
pause
