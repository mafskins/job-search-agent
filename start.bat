@echo off
echo Starting Job Search Agent...
cd /d C:\Users\twekkrt\job-search-agent
start start chrome http://localhost:3000
node server.js
pause