@echo off
setlocal

set TOOL_PY=%~dp0quiz_csv_batch_tool.py

if not exist "%TOOL_PY%" (
  echo [ERROR] Tool not found: %TOOL_PY%
  exit /b 1
)

python "%TOOL_PY%" %*
exit /b %ERRORLEVEL%
