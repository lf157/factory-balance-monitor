@echo off
echo Starting Factory Balance Monitor...
set ADMIN_PASSWORD=123456
if not exist "config.json" (
    copy config.example.json config.json
    echo Created config.json from template. Please add your API keys.
)
start http://localhost:8000
node server.js
