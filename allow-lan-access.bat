@echo off
REM Lets phones and tablets on the same network reach PW-Warehouse.
REM RIGHT-CLICK THIS FILE AND CHOOSE "Run as administrator".
REM
REM Opens three inbound TCP ports on this machine:
REM   80   - the built app served at http://pw-warehouse.local
REM   5173 - the Vite dev server, for development
REM   8765 - the label printing service
REM All three are restricted to private/local network addresses only.

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo This script needs administrator rights.
  echo Right-click allow-lan-access.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Adding firewall rules...

netsh advfirewall firewall delete rule name="PW-Warehouse site (80)" >nul 2>&1
netsh advfirewall firewall delete rule name="PW-Warehouse app (5173)" >nul 2>&1
netsh advfirewall firewall delete rule name="PW-Warehouse label printer (8765)" >nul 2>&1

netsh advfirewall firewall add rule ^
  name="PW-Warehouse site (80)" ^
  dir=in action=allow protocol=TCP localport=80 ^
  remoteip=LocalSubnet profile=any
if %errorLevel% neq 0 goto :failed

netsh advfirewall firewall add rule ^
  name="PW-Warehouse app (5173)" ^
  dir=in action=allow protocol=TCP localport=5173 ^
  remoteip=LocalSubnet profile=any
if %errorLevel% neq 0 goto :failed

netsh advfirewall firewall add rule ^
  name="PW-Warehouse label printer (8765)" ^
  dir=in action=allow protocol=TCP localport=8765 ^
  remoteip=LocalSubnet profile=any
if %errorLevel% neq 0 goto :failed

echo.
echo Done. Devices on your local network can now reach this machine.
echo.
echo On this network the app is at:     http://pw-warehouse.local
echo Or find this machine's address:    ipconfig
echo and open:                          http://THAT-ADDRESS
echo.
pause
exit /b 0

:failed
echo.
echo Failed to add firewall rules.
pause
exit /b 1
