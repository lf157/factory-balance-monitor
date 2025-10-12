@echo off
chcp 65001 >nul
title Factory.ai API 余额监控系统

echo.
echo ================================================================================
echo 🚀 Factory.ai API 余额监控系统 v2.0
echo ================================================================================
echo.
echo 正在启动服务...
echo.

REM 在后台启动 Node.js 服务
start /B node server.js

REM 等待服务启动
timeout /t 3 /nobreak >nul

REM 自动打开浏览器
echo 正在打开浏览器...
start http://localhost:8000

echo.
echo ================================================================================
echo ✅ 服务已启动! 浏览器已自动打开
echo 📊 访问地址: http://localhost:8000
echo.
echo 提示:
echo   - 关闭此窗口将停止服务
echo   - 按 Ctrl+C 可以停止服务
echo ================================================================================
echo.

REM 保持窗口打开,显示 Node.js 输出
node server.js
