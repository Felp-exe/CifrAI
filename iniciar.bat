@echo off
rem Inicia um servidor local para o CifrAI.
rem Depois abra no navegador: http://localhost:8080
cd /d "%~dp0"
echo.
echo  CifrAI rodando em http://localhost:8080
echo  Para encerrar, feche esta janela ou pressione Ctrl+C.
echo.
start "" http://localhost:8080
where python >nul 2>nul && (python servidor.py 8080 & goto :eof)
where py >nul 2>nul && (py servidor.py 8080 & goto :eof)
where npx >nul 2>nul && (npx --yes serve -l 8080 . & goto :eof)
echo Nao encontrei Python nem Node.js. Instale um deles para rodar o servidor local.
pause
