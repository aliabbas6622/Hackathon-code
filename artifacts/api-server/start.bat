@echo off
cd C:\Users\aliab\OneDrive\Desktop\Work-Attachments\artifacts\api-server
set DATABASE_URL=postgresql://postgres:03377770951@db.tofxgmgifbhwviydsush.supabase.co:5432/postgres
set PORT=8080
node --enable-source-maps ./dist/index.mjs