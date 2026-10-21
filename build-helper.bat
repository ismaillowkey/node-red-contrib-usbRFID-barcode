@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if not exist "%CSC%" (
    echo [ERROR] csc.exe .NET Framework tidak ditemukan.
    echo         Build helper Raw Input hanya tersedia di Windows dengan .NET Framework 4.x.
    exit /b 1
)

if not exist "%ROOT%\bin\win" mkdir "%ROOT%\bin\win"

echo [INFO] Membangun helper Raw Input...
"%CSC%" /nologo /target:exe /platform:anycpu /optimize+ ^
    /out:"%ROOT%\bin\win\RawInputBridge.exe" ^
    /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
    "%ROOT%\helper-src\RawInputBridge.cs"

if errorlevel 1 (
    echo [ERROR] Build helper Raw Input gagal.
    exit /b 1
)

echo [OK] Helper dibuat: %ROOT%\bin\win\RawInputBridge.exe
exit /b 0
