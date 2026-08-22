# Chat Buddy

**Live: https://chat-buddy-production.up.railway.app**

A chatbot with rule-based chat, an agent-style multi-step task planner, image/video upload & analysis, webcam capture, screenshot paste, voice input, real user accounts with server-side persistence, document upload/preview/Q&A (PDF/DOCX/TXT), image intelligence (OCR, object detection, captioning, Q&A), and a full multi-conversation UX (profiles, settings, light/dark theme, folders, search, rename/delete).

## What changed: real authentication

Chat Buddy started as a single static `index.html` (no backend). It now has a small **Node/Express backend** with:

- **Auth**: register/login with bcrypt-hashed passwords and JWT session tokens.
- **Per-user database**: each user's profile, folders, and conversations (each with its own chat history, remembered name, and notes) are stored server-side (in `data.json`, a simple JSON file — no native database driver required, so it installs anywhere without a C++ build toolchain).
- The frontend (`public/index.html`) now shows a login/register screen and syncs chat state to `/api/conversations/:id` instead of using `localStorage`.

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
| `GET /api/profile` | Bearer token | — | returns `{ displayName, avatar, theme, username, createdAt }` |
| `PUT /api/profile` | Bearer token | `{ displayName?, avatar?, theme? }` | updates profile fields |
| `PUT /api/password` | Bearer token | `{ currentPassword, newPassword }` | changes the account password |
| `GET /api/folders` | Bearer token | — | lists the user's folders |
| `POST /api/folders` | Bearer token | `{ name }` | creates a folder |
| `PATCH /api/folders/:id` | Bearer token | `{ name }` | renames a folder |
| `DELETE /api/folders/:id` | Bearer token | — | deletes a folder (its chats become unfoldered, not deleted) |
| `GET /api/conversations` | Bearer token | — | lists the user's conversations (metadata + preview), newest first |
| `POST /api/conversations` | Bearer token | `{ title? }` | creates a new conversation |
| `GET /api/conversations/:id` | Bearer token | — | returns a conversation's full `{ history, userName, notes }` |
| `PUT /api/conversations/:id` | Bearer token | `{ history, userName, notes }` | saves a conversation's chat state |
| `PATCH /api/conversations/:id` | Bearer token | `{ title?, folderId? }` | renames a conversation or moves it into/out of a folder |
| `DELETE /api/conversations/:id` | Bearer token | — | deletes a conversation |
| `GET /api/search?q=` | Bearer token | — | searches message text across all the user's conversations, returns matches with conversation id/title and a snippet |
| `POST /api/files` | Bearer token | multipart `file` field | uploads a PDF/DOCX/TXT/JPG/PNG/GIF/BMP (10MB max); documents get text extracted, images get OCR + object detection + a generated caption |
| `GET /api/files` | Bearer token | — | lists the user's uploaded files (metadata only) |
| `GET /api/files/:id` | Bearer token | — | returns the file's full extracted text |
| `GET /api/files/:id/download` | Bearer token | — | streams the original file (inline, for preview) |
| `POST /api/ask-files` | Bearer token | `{ question }` | finds the best-matching passage across the user's uploaded files (semantic match if `VOYAGE_API_KEY` is set, otherwise keyword-overlap search) |

## Phase 1: Document & File Intelligence

- **Upload**: PDF, DOCX, or TXT via the 📄 button. Files are stored per-user on disk (`uploads/<userId>/`) and their text is extracted server-side with `pdf-parse` and `mammoth`.
- **Preview**: PDFs open in the browser's native PDF viewer in a new tab; DOCX/TXT show an extracted-text preview inline in the chat.
- **Ask questions**: after uploading, ask a specific question (ending in "?", or starting with what/who/when/where/why/how/does/is/tell me/summarize/explain) and the backend finds the best-matching passage across your uploaded files, returning it with its source filename. If nothing in the document answers the question, it says so explicitly instead of falling back to an unrelated generic chatbot reply. For generic requests anywhere in the sentence — "can you verify this and tell me about it," "please describe this image," "analyze this" — the frontend also recognizes those verbs and, if no specific match is found, falls back to a plain overview of the most recently uploaded file (its extracted text or, for images, its caption/objects/OCR).
- **Matching**: extractive, not generative — it finds an existing passage, it doesn't synthesize a new answer. Two modes:
  - **Semantic (recommended)**: if `VOYAGE_API_KEY` is set (see `.env.example`), each uploaded file's text is chunked and embedded once at upload time via [Voyage AI](https://www.voyageai.com/) (Anthropic's recommended embeddings provider — Anthropic has no first-party embeddings API). Answering a question embeds just the question and does cosine-similarity search against those precomputed vectors, so it understands paraphrased questions, not just exact keyword matches.
  - **Keyword fallback**: used automatically when no `VOYAGE_API_KEY` is set, for files uploaded before it was set, or if a Voyage API call fails. Requires a real fraction of the question's meaningful words to literally appear in a passage — good for exact/close phrasing, but won't recognize a heavily paraphrased question that shares no real keywords with the document's wording.

## Phase 2: Image Intelligence

- **Upload**: any JPG/PNG/GIF/BMP via the existing 📎 image button. An instant client-side analysis (dimensions, dominant color, brightness) appears immediately, followed by a deeper server-side pass a few seconds later.
- **OCR**: real text extraction via [Tesseract.js](https://github.com/naptha/tesseract.js), running fully server-side (no external API).
- **Object detection**: real local inference via [TensorFlow.js](https://www.tensorflow.org/js) (pure-JS CPU backend, no native compilation) with the pre-trained [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) model — recognizes 80 common object classes (person, car, dog, chair, etc.). The model's weights are fetched once from TensorFlow's public model repository at server startup; no image or user data is ever sent to any external service — all inference happens locally in the Node process.
- **Captioning**: a plain-English sentence generated by combining the object detection results, OCR presence, and color/brightness analysis (e.g. "This image appears to contain a person, a dog. It is predominantly blue and bright. It also contains visible text."). This is **rule-based composition of the other real analyses, not a neural image-captioning model** — being upfront about that so it isn't mistaken for something it's not.
- **Ask questions**: images are stored in the same per-user file library as documents (Phase 1), so `/api/ask-files` searches their OCR text, caption, and detected-object list right alongside your PDFs/DOCX/TXT files — no separate code path.
- **Preview**: images open in the browser's native image viewer in a new tab, same as PDFs.

Note: `@tensorflow/tfjs-node` (the fast, native-accelerated backend) was tried first but requires a C++ build toolchain unavailable here and not guaranteed on hosting platforms, so this uses the pure-JS `@tensorflow/tfjs` CPU backend instead — slower per-image (a few seconds) but installs and runs anywhere, matching this project's "no native compilation" approach from Phase 1.

## Phase 3: User Experience

- **User profiles**: display name, a chosen emoji avatar, and account creation date — editable from Settings.
- **Settings**: displayName/avatar/theme editing and password change, all in one modal reachable from the sidebar footer.
- **Theme switching**: light/dark mode via CSS custom properties, saved per-account (not just per-browser) and applied immediately on login.
- **Multiple conversations**: chat history is no longer a single blob per user — each user now has any number of named conversations, switchable from a sidebar, matching the "New Chat" pattern of most chat apps.
- **Conversation folders**: group conversations into folders; deleting a folder un-parents its chats rather than deleting them.
- **Chat search**: a sidebar search box does a live, debounced search across every message in every one of the user's conversations (not just the open one), showing matching snippets that jump straight to that conversation.
- **Rename/delete chats**: inline rename (click the pencil, type, Enter/blur to save) and a two-click delete confirmation (no native `confirm()`/`prompt()` dialogs anywhere in the UI) for both conversations and folders.
- The per-user file library (Phases 1–2) is unchanged by this — files stay attached to the account, not to a single conversation, so you can ask any conversation about any file you've uploaded.

## Deploying

Currently deployed on **Railway** at https://chat-buddy-production.up.railway.app (project: `chat-buddy`, deployed via `railway up`; `JWT_SECRET` and `DATA_DIR=/data` are set as environment variables there).

**Persistent storage**: `data.json` and `uploads/` are written under the path in the `DATA_DIR` environment variable (defaults to the app directory, so local dev is unaffected). On Railway, `DATA_DIR` points at a mounted volume (`chat-buddy-volume`, 500MB, mount path `/data`) so accounts and files survive container restarts — not just code redeploys. Earlier versions of this app stored everything on the container's local disk with no volume, which meant registered accounts could disappear after *any* restart (idle sleep, crash-restart, OOM), not only a deploy — that bug is fixed as of the volume + `DATA_DIR` change.

GitHub Pages won't work for this app (no backend) — the repo page's README is just documentation, not the live app. To redeploy elsewhere, any host that runs Node works, e.g. [Render](https://render.com) or [Fly.io](https://fly.io):

- Build command: `npm install`
- Start command: `npm start`
- Set the `JWT_SECRET` environment variable to a long random string.
- **Attach a persistent volume/disk and set `DATA_DIR` to its mount path.** Without this, accounts and uploaded files will be lost whenever the container restarts — this bit us once already on Railway before the volume was added.

## Known limitations

- Chat itself is still rule-based (not a real LLM) — it's a keyword/pattern matching engine plus a lightweight "agent" that splits multi-part requests into steps.
- `data.json` is a flat file, not a real concurrent-safe database — fine for a small demo, not for scale.
- Object detection recognizes only the 80 COCO classes (common everyday objects) — it won't identify specific people, brands, or anything outside that set.
- Captions are templated sentences built from the other analyses, not generated by a vision-language model.
- The server needs internet access on first startup to download the COCO-SSD model weights and Tesseract's OCR language data (both are one-time downloads, cached in memory/disk after that — no per-request external calls).
- Per-image processing (OCR + object detection) takes a few seconds since it runs on plain CPU with no native acceleration.
