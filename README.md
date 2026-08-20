# Chat Buddy

A chatbot with rule-based chat, an agent-style multi-step task planner, image/video upload & analysis, webcam capture, screenshot paste, voice input, and now real user accounts with server-side persistence.

## What changed: real authentication

Chat Buddy started as a single static `index.html` (no backend). It now has a small **Node/Express backend** with:

- **Auth**: register/login with bcrypt-hashed passwords and JWT session tokens.
- **Per-user database**: each user's chat history, remembered name, and notes are stored server-side (in `data.json`, a simple JSON file — no native database driver required, so it installs anywhere without a C++ build toolchain).
- The frontend (`public/index.html`) now shows a login/register screen and syncs chat state to `/api/data` instead of using `localStorage`.

Because of this, **GitHub Pages can no longer host the working app** — Pages only serves static files, and this now needs a running Node process for the API. See "Deploying" below.

## Running locally

```bash
npm install
npm start
```

Then open **http://localhost:3001**. Register an account, chat, refresh the page — you'll stay logged in and your history reloads from the server.

Set a real `JWT_SECRET` environment variable in production (see `.env.example`); a fallback dev secret is used if it's not set.

## Project structure

```
server.js       Express app: auth + data API, serves public/ as static files
db.js           Tiny JSON-file-backed data layer (users + per-user chat data)
public/
  index.html    The chatbot UI (frontend)
data.json       Created automatically on first run (git-ignored)
```

## API

| Endpoint | Auth | Body | Notes |
|---|---|---|---|
| `POST /api/register` | — | `{ username, password }` | username 3+ chars, password 6+ chars |
| `POST /api/login` | — | `{ username, password }` | returns `{ token }` |
| `GET /api/data` | Bearer token | — | returns `{ history, userName, notes }` |
| `PUT /api/data` | Bearer token | `{ history, userName, notes }` | overwrites the user's saved state |

## Deploying

GitHub Pages won't work anymore (no backend). To deploy for real, push this repo to a host that runs Node, e.g. [Render](https://render.com), [Railway](https://railway.app), or [Fly.io](https://fly.io):

- Build command: `npm install`
- Start command: `npm start`
- Set the `JWT_SECRET` environment variable to a long random string.
- Note: `data.json` lives on local disk, so on most free hosts it resets on redeploy — fine for a demo, not for production data you care about keeping.

## Known limitations

- Chat itself is still rule-based (not a real LLM) — it's a keyword/pattern matching engine plus a lightweight "agent" that splits multi-part requests into steps.
- `data.json` is a flat file, not a real concurrent-safe database — fine for a small demo, not for scale.
