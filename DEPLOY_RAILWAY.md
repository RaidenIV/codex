# Railway Deployment Guide for CODEX Backend

## What this project contains

- `client/index.html` — backend-connected CODEX app served at `/`.
- `client/code.html` — same app, also available at `/code.html`.
- `server/server.js` — Express + MongoDB backend.
- `package.json` — Railway start script and Node dependencies.
- `railway.json`, `nixpacks.toml`, `Procfile` — deployment configuration.
- `env.example` — environment variable reference.

## Local test

1. Install Node.js 20.
2. Open a terminal in the project folder.
3. Run:

```bash
npm install
npm start
```

4. Open:

```text
http://localhost:3000
```

5. Health check:

```text
http://localhost:3000/api/health
```

Without `MONGODB_URI`, the server uses temporary in-memory storage. That is only for quick local testing. Railway should use MongoDB.

## GitHub setup

1. Create a new GitHub repository.
2. Copy this project folder's contents into the repo.
3. Commit and push:

```bash
git init
git add .
git commit -m "Add CODEX backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## Railway deployment

1. Go to Railway.
2. Click **New Project**.
3. Choose **Deploy from GitHub repo**.
4. Select your CODEX backend repo.
5. Let Railway detect the Node app.
6. Add a MongoDB service:
   - In the Railway project, click **New**.
   - Choose **Database**.
   - Choose **MongoDB**.
7. Open your web service variables and add:

```text
MONGODB_URI=<the MongoDB connection string from Railway>
```

Railway sets `PORT` automatically. Do not hardcode a public port.

8. Redeploy the web service after adding `MONGODB_URI`.
9. Open the generated Railway domain.
10. Confirm the health endpoint returns `mongoReady: true`:

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/health
```

## Important behavior

The app creates a browser client ID in `localStorage` and sends it as `X-Codex-Client`. This keeps different browsers from overwriting each other's CODEX libraries without requiring a login screen. Clearing browser storage creates a new library identity.

For a true account/login system later, reuse the uploaded Project Tracker backend pattern with JWT auth and user-owned records.
