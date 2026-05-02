# CODEX Backend

This is the uploaded CODEX reading-library app converted into a Railway-ready full-stack project.

The backend uses Express and MongoDB to persist:

- books
- reading status
- loans
- ratings
- notes
- UI preferences

The client keeps the original CODEX UI and uses API-backed storage with local browser fallback.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy

See `DEPLOY_RAILWAY.md`.
