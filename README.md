# Balance

Balance is a full-stack app for creating upload sessions, continuing sessions via magic links, and managing uploaded statement files.

## Stack

- Frontend: React + TypeScript + Vite (`client/`)
- Backend: NestJS + TypeScript + MongoDB (`api/`)
- Storage: S3-compatible bucket (validated at API startup)
- Auth: JWT + magic link verification flow

## Repository Layout

- `api/` Backend service
- `client/` Frontend app
- `start-local.sh` Install deps, build both apps, then run production-style start script
- `start.sh` Run built backend + frontend preview together
- `docker-local.sh` Build and run the containerized app locally
- `docker-fly-deploy.sh` Deploy with `flyctl`

## Prerequisites

- Node.js 20+ (recommended)
- npm
- MongoDB (local or remote URI)
- Valid AWS/S3 credentials and bucket access (API checks S3 on startup)

## Environment Setup

Create your API env file from the example:

```bash
cp api/.env.example api/.env
```

Then update values in `api/.env` for your environment (at minimum MongoDB, JWT secrets, and S3-related values).

## Local Development

Install dependencies:

```bash
npm --prefix api install
npm --prefix client install
```

Run backend (watch mode):

```bash
npm --prefix api run start:dev
```

Run frontend (Vite dev server):

```bash
npm --prefix client run dev
```

Default local URLs:

- API: `http://localhost:3000`
- Frontend: Vite default (typically `http://localhost:5173`) unless overridden

## Production-like Local Run

Build and run both apps together:

```bash
./start-local.sh
```

This script:

1. Installs deps for `api/` and `client/`
2. Builds both projects
3. Runs `./start.sh` (API on port `3000`, frontend preview on `4173` by default)

## Docker Local Run

Run with the helper script:

```bash
./docker-local.sh
```

Useful env overrides:

- `ENV_FILE` (default `api/.env`)
- `API_HOST_PORT` (default `3000`)
- `FRONTEND_HOST_PORT` (default `4173`)
- `WATCH_MODE` (default `1`)

## Common Commands

Backend:

```bash
npm --prefix api run build
npm --prefix api run test
npm --prefix api run lint
```

Frontend:

```bash
npm --prefix client run build
npm --prefix client run lint
npm --prefix client run preview
```

## Notes

- `api/README.md` and `client/README.md` are still framework template READMEs.
- Root README is the primary project entry point.
