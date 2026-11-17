@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Organizando el proyecto en carpetas...
echo ============================================
if not exist css mkdir css
if not exist js mkdir js
if not exist js\nube mkdir js\nube
if not exist assets mkdir assets
if not exist data mkdir data

rem Archivos que se mueven (si existen en la raiz). Los nuevos css/nube.css, js/nube/*.js ya vienen listos.
if exist styles.css move /Y styles.css css\styles.css >nul
if exist app.js move /Y app.js js\app.js >nul
if exist logo-uncp.png move /Y logo-uncp.png assets\logo-uncp.png >nul
if exist logo-data.js move /Y logo-data.js assets\logo-data.js >nul
if exist inventario.xlsx move /Y inventario.xlsx data\inventario.xlsx >nul
if exist datos-extra.json move /Y datos-extra.json data\datos-extra.json >nul
if exist nube.js del /Q nube.js

echo.
echo Listo. Ahora copie encima los archivos nuevos de esta entrega
echo (index.html, css\, js\, README.md, .gitignore, firestore.rules)
echo y abra la app con iniciar-servidor.bat
pause
