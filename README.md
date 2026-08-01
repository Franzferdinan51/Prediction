# Signal / Forecast

Standalone prediction app extracted from the prediction mode in `council-source` (the local clone of `Franzferdinan51/AI-Bot-Council-Concensus`). It is intentionally separate from the council app and has not been committed or pushed to GitHub.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

For the built-in local orchestration API, run a second process:

```bash
npm run dev:api
```

It binds to `127.0.0.1:8787` by default. Set `SIGNAL_API_PORT` to change the port. The API is localhost-only by default and supports:

If the API uses a non-default port, set `VITE_SIGNAL_API_URL` in `.env.local` before starting Vite. See [.env.example](/Users/duckets/Desktop/Prediction/.env.example).

- `POST /api/forecast` with `{ "mode": "single" | "local-moa", "event": "...", "deadline": "..." }`.
- `POST /api/agent/openclaw` with `{ "prompt": "...", "agentId?": "...", "sessionKey?": "..." }`.
- `POST /api/agent/hermes` with `{ "prompt": "...", "model?": "...", "provider?": "..." }`.
- `GET /api/connectors` for local MoA/OpenClaw/Hermes discovery.

Set `SIGNAL_API_TOKEN` and send `Authorization: Bearer <token>` before exposing the API beyond localhost. The OpenClaw adapter uses `openclaw agent --json --message` without `--deliver`; Hermes uses its `-z/--oneshot` mode. Neither connector sends an external message by default.

## Providers

- **LM Studio**: defaults to `http://localhost:1234/v1`, uses the OpenAI-compatible `/models` endpoint for auto-connect, and does not require a key for a local server.
- **MiniMax**: defaults to `https://api.minimax.io/v1` with `MiniMax-M2.7`.
- **Grok (xAI)**: defaults to `https://api.x.ai/v1` with `grok-3-mini`.
- **OpenAI**: defaults to `https://api.openai.com/v1` with `gpt-4o-mini`.

Provider keys and endpoints are stored in this browser's `localStorage`. The app calls each selected provider's OpenAI-compatible `/chat/completions` endpoint directly. Keep this browser-only approach for local use; a production deployment should proxy provider calls server-side so API keys never reach the browser.

OAuth is represented for OpenAI when a server callback is configured through `VITE_OPENAI_OAUTH_URL`. The current local app does not invent an OAuth flow for providers that expose API-key authentication instead. Add a server callback before enabling OAuth in a published deployment.

Demo fallback is enabled by default so the forecast flow can be tested without credentials. Disable it in Providers to use connected providers only.

The **LM Studio · local MoA** strategy calls the bundled `integrations/local-moa-advisors-mcp` adapter, which follows its bounded Planner → Skeptic → Aggregator pipeline against the already-loaded LM Studio model. It requires `npm run dev:api` and a loaded LM Studio model.

## Search and research

SearXNG is the default search provider. Set `SEARXNG_URL` to a local or private SearXNG instance; it uses the instance's JSON `/search?q=...&format=json` API. Tavily and Brave are available when `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` is configured. The app never fans out to all providers automatically.

`POST /api/search` accepts `provider`, `query` or `queries`, `depth: "quick" | "deep"`, and `maxResults`. Quick mode allows up to 3 queries; deep mode allows up to 6. Results are cached for five minutes, deduplicated by URL, and capped at 10 results per query. `POST /api/research` creates three focused queries for an event: the event itself, macro factors, and latest news.

## Verification

```bash
npm run build
```

The end-to-end browser check covers editing the event, running the demo forecast, opening provider settings, saving a local provider configuration, and desktop/mobile rendering.
