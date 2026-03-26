# VFB Chat Client

VFB Chat is a Next.js chat interface for exploring Virtual Fly Brain (VFB) data with grounded tool use. The production build is aligned to the governance and privacy controls for launch: structured logging, no free-text analytics logging, reviewed-domain search only, outbound link allow-listing, and production checks that can enforce an approved ELM endpoint and model when explicit approval values are configured.

## What Changed

- Native `web_search` has been removed from the model toolset.
- Search is limited to approved `virtualflybrain.org`, `neurofly.org`, and `vfb-connect.readthedocs.io` pages plus reviewed `flybase.org` pages through server-side, domain-restricted tools.
- Outbound links are sanitized server-side to approved domains only.
- Raw IP-based security logs are retained for up to 30 days under `/logs/security`.
- Aggregated analytics and structured feedback are retained under `/logs/analytics` and `/logs/feedback`.
- Users can explicitly attach a visible chat transcript to negative feedback; those transcripts are stored separately for up to 30 days.
- Google Analytics is optional and receives structured metrics only. No free-text user queries or model responses are sent.
- Production fails closed when explicit `APPROVED_ELM_*` values are configured and do not match the active gateway/model.

## Logging Model

The app now uses a 3-layer logging model rooted at `LOG_ROOT_DIR`:

- Layer A: `/logs/security`
  - JSONL security events
  - blocked-site audit events
  - rate-limit state with raw IP retention capped at 30 days
- Layer B: `/logs/analytics`
  - daily aggregated service metrics only
  - no raw prompts or raw responses
- Layer C: `/logs/feedback`
  - structured thumbs up/down feedback plus fixed reason codes
  - no free-text feedback comments
- Feedback transcript attachments: `/logs/feedback-transcripts`
  - stored only when a user explicitly attaches a conversation to negative feedback
  - short retention, capped at 30 days

## Reviewed Site Search

The reviewed documentation search path uses two server-side sources:

- a seed index from `config/reviewed-docs-index.json`
- a domain-restricted discovery path for approved `virtualflybrain.org`, `neurofly.org`, and `vfb-connect.readthedocs.io` pages using configured sitemap and robots sources

This keeps search scoped to approved domains while avoiding a hand-maintained list of every VFB news or documentation page.

Environment variable:

- `REVIEWED_DOCS_INDEX_FILE`
- `REVIEWED_DOCS_DISCOVERY_URLS`
- `REVIEWED_DOCS_CACHE_MINUTES`
- `REVIEWED_DOCS_MAX_URLS`
- `REVIEWED_DOCS_FETCH_TIMEOUT_MS`

## Runtime Configuration

Required for production:

- `ELM_API_KEY` (or `OPENAI_API_KEY` as backward-compatible fallback)
- `ELM_BASE_URL` (or `OPENAI_BASE_URL`) or `APPROVED_ELM_BASE_URL`
- `ELM_MODEL` (or `OPENAI_MODEL`) or `APPROVED_ELM_MODEL`
- `LOG_ROOT_DIR=/logs`

Optional:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `APPROVED_ELM_BASE_URL`
- `APPROVED_ELM_MODEL`
- `RATE_LIMIT_PER_IP`
- `SEARCH_ALLOWLIST`
- `OUTBOUND_ALLOWLIST`
- `REVIEWED_DOCS_INDEX_FILE`
- `GA_MEASUREMENT_ID`
- `GA_API_SECRET`

When `APPROVED_ELM_BASE_URL` and/or `APPROVED_ELM_MODEL` are provided, production enforces that they exactly match the active configured gateway/model (resolved from `ELM_*` first, then `OPENAI_*`). If they are omitted, the app uses the active gateway/model as the approved baseline so existing single-config deployments continue to work.

Default allow-lists:

- Search allow-list: `virtualflybrain.org`, `*.virtualflybrain.org`, `flybase.org`, `neurofly.org`, `*.neurofly.org`, `vfb-connect.readthedocs.io`
- Outbound allow-list: `virtualflybrain.org`, `*.virtualflybrain.org`, `flybase.org`, `neurofly.org`, `*.neurofly.org`, `vfb-connect.readthedocs.io`, `doi.org`, `pubmed.ncbi.nlm.nih.gov`, `biorxiv.org`, `medrxiv.org`

## Local Development

Create `.env.local` with explicit values:

```bash
ELM_API_KEY=elm-xxxxxxxx-xxxxxxxxxxxxxxxx
ELM_BASE_URL=https://elm.edina.ac.uk/api/v1
ELM_MODEL=meta-llama/Llama-3.3-70B-Instruct
LOG_ROOT_DIR=./logs
```

Optional hardening:

```bash
APPROVED_ELM_BASE_URL=https://your-elm-gateway.example/v1
APPROVED_ELM_MODEL=your-approved-model
```

Then run:

```bash
npm install
npm run dev
```

The local default for `LOG_ROOT_DIR` falls back to `./logs` when not running in production.

## Docker

The provided `docker-compose.yml` mounts a named volume at `/logs`:

```bash
docker-compose up --build
```

This keeps security, analytics, and feedback logs outside the application filesystem.

## API Surface

- `POST /api/chat`
  - Streams assistant responses over SSE
  - emits `result` events with `requestId` and `responseId`
  - approved site search uses `search_reviewed_docs`
  - approved page extraction uses `get_reviewed_page`
- `GET /api/rate-info`
  - returns the current per-IP daily usage counters
- `POST /api/feedback`
  - accepts `{ request_id, response_id, rating, reason_code }`
  - negative feedback may also include `{ attach_conversation: true, conversation }`
- `GET /privacy`
  - serves the VFB Chat privacy addendum page

## UI Notes

- The welcome text and footer now reflect the launch privacy position.
- Assistant messages with IDs support structured feedback:
  - thumbs up submits `helpful`
  - thumbs down requires a fixed reason code
  - thumbs down can optionally attach the visible conversation transcript for short-term investigation

## Verification Notes

- `npm run lint` should be used for local verification after changes.
- `npm run build` may fail in restricted sandboxes because Next.js attempts to bind a local IPC port during build; rerun it in the target environment before release.
