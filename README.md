# Signal / Forecast

Signal / Forecast is a standalone web application for structured future-event forecasting. It handles binary events, timing questions such as “When will event X end?”, numeric ranges, and competing scenarios—returning a central answer, calibrated confidence, provider opinions, supporting signals, and disconfirming evidence.

The project was separated from the prediction workflow in [AI-Bot-Council-Concensus](https://github.com/Franzferdinan51/AI-Bot-Council-Concensus). It is designed to run locally first, while exposing a small HTTP API that external agents and automation can call when needed.

> Forecasts are estimates, not guarantees or financial, legal, medical, or investment advice. Always record the resolution criteria and revisit forecasts as evidence changes.

## What it includes

- Binary, timing/date-window, numeric-range, and categorical-scenario forecasts.
- A visible central answer (for example, a likely end window) plus calibrated confidence for non-binary questions.
- Ensemble forecasting across LM Studio, MiniMax, Grok/xAI, and OpenAI.
- Single-provider mode for focused forecasts.
- LM Studio local MoA mode using the bundled `local-moa-advisors-mcp` adapter.
- Bounded Planner → Skeptic → Aggregator orchestration for local MoA runs.
- Automatic LM Studio discovery through its OpenAI-compatible `/models` endpoint.
- API-key configuration for remote providers and local endpoints that require authentication.
- Optional OpenAI OAuth redirect configuration through a separately hosted callback.
- Persistent local forecast history with pinning and two-forecast comparison.
- Research mode with SearXNG as the default search provider.
- Optional Tavily and Brave Search integrations.
- Search budgets, five-minute caching, URL deduplication, and bounded query depth.
- OpenClaw and Hermes Agent connectors for external agent-assisted research and forecasting.
- A local HTTP API for forecasts, research, search, connector discovery, and agent calls.
- Demo mode so the interface can be exercised without credentials or network services.

## Architecture

The application has two processes:

```text
Browser UI (Vite + React)
        |
        | direct provider calls for local development
        | local API calls for MoA, search, and agents
        v
Signal API (Node HTTP server, 127.0.0.1:8787)
        |
        +--> LM Studio / local-moa-advisors-mcp
        +--> SearXNG, Tavily, or Brave Search
        +--> OpenClaw CLI
        +--> Hermes CLI
```

The browser stores provider configuration and forecast history in its own `localStorage`. In local development, provider API keys are sent directly from the browser to the configured OpenAI-compatible endpoint. For a hosted deployment, move provider calls behind an authenticated server-side proxy so secrets are never exposed to browser JavaScript.

## Requirements

- Node.js 20 or newer.
- npm.
- A modern browser.
- Optional: LM Studio with a loaded model.
- Optional: a reachable SearXNG instance.
- Optional: Tavily or Brave API credentials.
- Optional: installed `openclaw` and/or `hermes` CLIs.

## Install and run

Install dependencies:

```bash
npm install
```

Start the browser application:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

For local MoA, search, connector discovery, and external agent calls, start the API in a second terminal:

```bash
npm run dev:api
```

The API listens on `127.0.0.1:8787` by default. If you change the port, create `.env.local` before starting Vite:

```bash
VITE_SIGNAL_API_URL=http://127.0.0.1:8788
```

You can also run the API in a production-like process with:

```bash
npm run start:api
```

Build and preview the frontend:

```bash
npm run build
npm run preview
```

## Configuration

Copy the example environment file when you need server integrations:

```bash
cp .env.example .env.local
```

### Server environment variables

| Variable               | Default                    | Purpose                                                                                            |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `SIGNAL_API_PORT`      | `8787`                     | Port for the local API server.                                                                     |
| `SIGNAL_API_HOST`      | `127.0.0.1`                | Bind address. Keep loopback for local use.                                                         |
| `SIGNAL_API_TOKEN`     | empty                      | Bearer token required from non-loopback callers.                                                   |
| `SEARXNG_URL`          | `http://127.0.0.1:8080`    | SearXNG base URL.                                                                                  |
| `TAVILY_API_KEY`       | empty                      | Enables Tavily search.                                                                             |
| `BRAVE_SEARCH_API_KEY` | empty                      | Enables Brave Search.                                                                              |
| `OPENCLAW_COMMAND`     | `openclaw`                 | Override the OpenClaw executable.                                                                  |
| `HERMES_COMMAND`       | `hermes`                   | Override the Hermes executable.                                                                    |
| `LOCAL_MOA_COMMAND`    | bundled adapter            | Override the local MoA MCP entrypoint.                                                             |
| `LM_STUDIO_URL`        | `http://127.0.0.1:1234/v1` | LM Studio URL passed to the bundled adapter.                                                       |
| `LM_API_TOKEN`         | empty                      | Optional LM Studio API token for the local MoA adapter when LM Studio token protection is enabled. |
| `MINIMAX_CLI_COMMAND`  | `mmx`                      | Path to the official MiniMax CLI used for local OAuth-backed forecasts.                            |
| `GROK_BUILD_COMMAND`   | `grok`                     | Path to the official Grok Build CLI used for local OAuth-backed forecasts.                         |
| `OPENAI_CODEX_COMMAND` | `codex`                    | Path to the Codex CLI used for local ChatGPT OAuth-backed forecasts.                               |

### Browser environment variables

| Variable              | Default                 | Purpose                           |
| --------------------- | ----------------------- | --------------------------------- |
| `VITE_SIGNAL_API_URL` | `http://127.0.0.1:8787` | API base URL used by the browser. |

Vite exposes `VITE_*` values to the browser. Do not put private API keys in a `VITE_*` variable.

## Provider setup

Open the **Providers** view in the app. Each provider has an editable endpoint, model, and API-key field.

Default configurations:

| Provider   | Endpoint                    | Model          | Authentication                             |
| ---------- | --------------------------- | -------------- | ------------------------------------------ |
| LM Studio  | `http://localhost:1234/v1`  | `local-model`  | Usually none; auto-connect uses `/models`. |
| MiniMax    | `https://api.minimax.io/v1` | `MiniMax-M2.7` | API key or official MiniMax CLI OAuth.     |
| Grok / xAI | `https://api.x.ai/v1`       | `grok-4.5`  | API key or official Grok Build CLI OAuth.  |
| OpenAI     | `https://api.openai.com/v1` | `gpt-4o-mini`  | API key or local Codex/ChatGPT OAuth.      |

### OAuth and model selection

The provider controls do not copy OAuth credentials into the browser. Instead,
they start and inspect the official local CLI session, then call that CLI for a
forecast. This gives each authenticated CLI a real model dropdown:

- MiniMax: click **MiniMax OAuth** or use an API key, then choose a supported
  MiniMax model.
- Grok: click **Grok OAuth**, check the session, and click **Load models** to
  populate the dropdown from `grok models`.
- OpenAI: click **ChatGPT OAuth** to run `codex login`, check the session, and
  choose **Codex CLI default** or a GPT-5.6, GPT-5.5, GPT-5.4, GPT-5.4 mini,
  or other supported text/reasoning model. OpenAI's Platform API itself
  continues to use API keys; the OAuth path is for the local Codex/ChatGPT
  session.

The separate **Settings** view controls forecast strategy, the default single
provider, and demo fallback. It is deliberately separate from **Providers**,
which holds endpoint, model, API-key, OAuth, and model-list controls.

### Guided forecast input and provider output

The Forecast view keeps its full free-form brief while adding a **Load guided
example** action for each forecast type. It loads an editable, structured brief
for binary, timing, numeric, or scenario forecasts so providers receive clear
resolution criteria and response instructions.

MiniMax CLI JSON output is normalized before the app parses the requested XML
tags. For the best results, preserve the guided question, horizon, resolution
criteria, and context structure, then edit it with your own evidence.

### Research and run diagnostics

Every live forecast starts with a bounded research pre-pass using the selected
search provider. Returned sources are appended to the provider brief as fresh
context. The **Run log** shows the research result, each provider request and
response, plus actionable errors. Failed provider responses are excluded from
the aggregate; if every selected provider fails, the app stops with an error
instead of displaying a fabricated 50% forecast.

### Search providers

Open **Settings → Search providers** to configure research. The configuration is
stored locally in the browser, like provider API keys, and passed only to the
local API with the request that uses it.

- **SearXNG** is the default. Enter the base URL of your self-hosted instance
  and use **Test SearXNG**; it does not require a key.
- **Tavily** and **Brave Search** each have an API-key field and a test button.
- Choose the default provider to use it in the Agents research loop and in
  Local MoA research. The search API stays bounded to avoid runaway querying.

Server-side `SEARXNG_URL`, `TAVILY_API_KEY`, and `BRAVE_SEARCH_API_KEY`
environment variables remain available as fallbacks for headless/API use.

The provider adapters use the OpenAI-compatible `/chat/completions` contract. Prompts ask providers to return `<probability>`, `<confidence>`, and `<reasoning>` tags. The app clamps parsed probabilities to 0–100 and keeps each provider opinion visible in the result.

### MiniMax and Grok OAuth through their official CLIs

The app supports provider-owned CLI OAuth without copying access or refresh tokens into browser storage:

- **MiniMax:** install `mmx-cli`, then select **MiniMax OAuth**. The local API starts `mmx auth login --recommend --region=global`, which uses the official PKCE device authorization flow. After completing it in the browser, select **Check OAuth session**.
- **Grok / xAI:** install Grok Build, then select **Grok OAuth**. The local API starts `grok login --oauth`, which opens the official `auth.x.ai` login. After completion, select **Check OAuth session**.

When a provider is connected through its CLI session, forecast prompts run through that authenticated local CLI instead of direct browser API calls. The app reports only authentication state and never reads, displays, or persists provider OAuth tokens.

### Demo mode

Demo fallback is enabled on first launch. It returns deterministic sample opinions so the UI, history, pinning, and comparison features can be tested without credentials. Disable **Demo fallback** in Providers before running live forecasts.

## Forecast modes

### Ensemble

Queries the configured provider set and aggregates their opinions. This is the default council-style workflow.

### Single provider

Runs one selected provider. Use this when you want to compare a provider against the ensemble or isolate a provider’s reasoning.

### LM Studio local MoA

Runs the bundled [`local-moa-advisors-mcp`](./integrations/local-moa-advisors-mcp) adapter through MCP stdio. The adapter uses the loaded LM Studio model in a bounded sequence:

1. Planner proposes a base-rate forecast and research plan.
2. Skeptic challenges assumptions and identifies disconfirming signals.
3. Aggregator produces the final probability and reasoning.

The local MoA route requires the API process and a loaded LM Studio model. If LM Studio API-token protection is enabled, either enter the token in the LM Studio provider field (the local API forwards it only to the local MoA process) or set `LM_API_TOKEN` for the API process. It can attach bounded SearXNG research context before the MoA run.

## Search and research

SearXNG is the default provider because it can be self-hosted and does not require a commercial API key. Configure it with `SEARXNG_URL`.

Tavily and Brave are optional alternatives. The app only calls the provider selected by the user; it does not automatically fan out to every provider.

Search controls:

- `quick` depth: up to 3 focused queries.
- `deep` depth: up to 6 focused queries.
- Maximum 10 results per query.
- Five-minute in-memory cache.
- URL deduplication across queries.
- Search errors are returned alongside successful results.

Research mode generates three event-focused queries:

1. The event itself.
2. The event’s macro factors.
3. The event’s latest news.

This gives connected agents useful context without allowing an unbounded search loop.

## Hermes Agent and OpenClaw connectors

The **Agents** view checks whether the local MoA adapter, OpenClaw, and Hermes are available. Agent actions first gather bounded SearXNG research context, then pass that context into the selected connector.

### OpenClaw

The API invokes:

```text
openclaw agent --json --message "..."
```

Optional request fields add `--agent <id>` and `--session-key <key>`. The connector deliberately does not add `--deliver`, so a forecast request does not send a message to an external channel by default.

### Hermes

The API invokes Hermes in one-shot mode:

```text
hermes -z "..."
```

Optional request fields add `--model <model>` and `--provider <provider>`.

Each connector allows one active turn per agent process. This prevents accidental concurrent runs from flooding a local agent or its downstream tools. Set `OPENCLAW_COMMAND` or `HERMES_COMMAND` when the executable is not on `PATH`.

## HTTP API

All API responses are JSON. The server returns CORS headers for local browser use. If `SIGNAL_API_TOKEN` is set, loopback requests remain available to the local UI; non-loopback callers must send:

```http
Authorization: Bearer <token>
```

### Health

```bash
curl http://127.0.0.1:8787/api/health
```

### Connector discovery

```bash
curl http://127.0.0.1:8787/api/connectors
```

The response reports whether the bundled MoA adapter, OpenClaw CLI, and Hermes CLI are available.

### CLI OAuth state and launch

```bash
curl http://127.0.0.1:8787/api/cli-auth/minimax/status
curl http://127.0.0.1:8787/api/cli-auth/grok/status

curl -X POST http://127.0.0.1:8787/api/cli-auth/minimax/login \
  -H 'content-type: application/json' \
  -d '{"flow":"browser"}'
```

The status routes expose installation and authentication state only; they do not return credential material. `POST /api/cli-forecast` accepts `{ "provider": "minimax" | "grok", "brief": { ... } }` and runs the forecast through the corresponding authenticated local CLI.

### Forecast

```bash
curl -X POST http://127.0.0.1:8787/api/forecast \
  -H 'content-type: application/json' \
  -d '{
    "mode": "single",
    "event": "Will inflation be below 3% before December 2026?",
    "deadline": "December 31, 2026",
    "provider": {
      "id": "lmstudio",
      "name": "LM Studio",
      "endpoint": "http://127.0.0.1:1234/v1",
      "model": "local-model"
    }
  }'
```

For a local MoA forecast, use `"mode": "local-moa"`. Set `"search": false` to skip the research pre-pass. Set `"demo": true` to receive the deterministic demo result.

### Search

```bash
curl -X POST http://127.0.0.1:8787/api/search \
  -H 'content-type: application/json' \
  -d '{
    "provider": "searxng",
    "query": "Federal Reserve rate cut macro factors",
    "depth": "deep",
    "maxResults": 5
  }'
```

The response includes `results`, any per-query `errors`, and a `budget` object showing query limits and usage.

### Research bundle

```bash
curl -X POST http://127.0.0.1:8787/api/research \
  -H 'content-type: application/json' \
  -d '{"event":"Will the Federal Reserve cut rates before December 2026?"}'
```

### External agent calls

```bash
curl -X POST http://127.0.0.1:8787/api/agent/openclaw \
  -H 'content-type: application/json' \
  -d '{"prompt":"Assess this forecast and list disconfirming signals."}'

curl -X POST http://127.0.0.1:8787/api/agent/hermes \
  -H 'content-type: application/json' \
  -d '{"prompt":"Assess this forecast and list disconfirming signals."}'
```

## Security and operational limits

- Bind the API to `127.0.0.1` unless you intentionally operate it behind a trusted network boundary.
- Set `SIGNAL_API_TOKEN` for non-loopback access.
- Never commit `.env.local`, provider keys, or OAuth client secrets.
- Request bodies are limited to 1 MiB.
- Search queries and result counts are bounded and cached.
- Agent subprocesses have a maximum output buffer and one active turn per agent.
- OpenClaw connector calls do not deliver messages by default.
- Browser `localStorage` is convenient for local use but is not a production secrets vault.
- For deployment, use server-side provider calls, HTTPS, authenticated users, encrypted secret storage, and an allowlist for callable agents.

## Testing and verification

Run the production type check and build:

```bash
npm run build
```

Check production dependencies:

```bash
npm audit --omit=dev --audit-level=high
```

The verified end-to-end coverage includes:

- Demo forecast execution.
- Provider settings and local persistence.
- Forecast history, loading, pinning, and comparison.
- Agents view and bounded search flow.
- API health and connector discovery.
- OpenClaw and Hermes connector argument contracts using harmless local stubs.
- Request-size rejection and token-aware local API behavior.
- Production browser rendering with Playwright.

## Project layout

```text
.
├── api-server.mjs                         # Local orchestration/search/agent API
├── src/
│   ├── App.tsx                            # Main UI and views
│   ├── lib/forecast.ts                     # Provider and forecast logic
│   ├── main.tsx                            # React entrypoint
│   └── styles.css                          # Application styling
├── integrations/local-moa-advisors-mcp/   # Bundled MCP adapter
├── .env.example                            # Configuration template
├── index.html
├── package.json
└── vite.config.ts
```

## Troubleshooting

### The app says the API is unavailable

Start `npm run dev:api` and confirm `VITE_SIGNAL_API_URL` matches its port. Check the health endpoint:

```bash
curl http://127.0.0.1:8787/api/health
```

### LM Studio cannot be detected

Start LM Studio’s local server, load a model, confirm the endpoint is reachable, and use **Auto-connect** in Providers. The default endpoint is `http://localhost:1234/v1`.

### Search returns errors

Confirm SearXNG is running at `SEARXNG_URL` and supports JSON output. For a local default setup, the expected endpoint is:

```text
http://127.0.0.1:8080/search?q=your-query&format=json
```

Tavily and Brave require their corresponding server environment variables.

### OpenClaw or Hermes is shown as unavailable

Run the CLI’s version command directly, then set an absolute executable path if necessary:

```bash
openclaw --version
hermes --version
```

```bash
OPENCLAW_COMMAND=/absolute/path/to/openclaw \
HERMES_COMMAND=/absolute/path/to/hermes \
npm run dev:api
```

### A live provider rejects the request

Check the endpoint, model name, API key, and provider-specific account permissions. The app expects an OpenAI-compatible `/chat/completions` endpoint and a response containing a probability or a `<probability>` tag.

## License and related projects

This application is maintained as a separate project from the source council application. The bundled `local-moa-advisors-mcp` integration retains its upstream license and attribution in its own directory.

Related projects:

- [AI-Bot-Council-Concensus](https://github.com/Franzferdinan51/AI-Bot-Council-Concensus)
- [local-moa-advisors-mcp](https://github.com/Franzferdinan51/local-moa-advisors-mcp)
- [Hermes Agent](https://github.com/nousresearch/hermes-agent)
- [OpenClaw](https://github.com/openclaw/openclaw)
