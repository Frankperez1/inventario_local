@echo off
cd /d "%~dp0"
echo ============================================
echo   Iniciando servidor local del inventario...
echo   No cierres esta ventana mientras lo uses.
echo ============================================
start "" http://localhost:8000
python -m http.server 8000
if errorlevel 1 (
  echo.
  echo "python" no funciono, probando con "py"...
  py -m http.server 8000
)
pause
