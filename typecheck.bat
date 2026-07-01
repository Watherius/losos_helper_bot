@echo off
echo Running type check for gateway-node...
cd gateway-node
call npm run typecheck
if %errorlevel% neq 0 (
    echo [ERROR] gateway-node typecheck failed!
    cd ..
    exit /b %errorlevel%
)
cd ..

echo Running type check for backend-python...
cd backend-python
py -3.9 -m mypy app
if %errorlevel% neq 0 (
    echo [ERROR] backend-python mypy check failed!
    cd ..
    exit /b %errorlevel%
)
cd ..
echo [SUCCESS] All type checks passed!
