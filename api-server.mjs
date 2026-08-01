import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.SIGNAL_API_PORT || 8787);
const HOST = process.env.SIGNAL_API_HOST || "127.0.0.1";
const API_TOKEN = process.env.SIGNAL_API_TOKEN || "";
const ROOT = new URL(".", import.meta.url).pathname;
const SEARXNG_URL = (
  process.env.SEARXNG_URL || "http://127.0.0.1:8080"
).replace(/\/$/, "");
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const MAX_BODY_BYTES = 1024 * 1024;
const searchCache = new Map();
const searchInFlight = new Map();
const agentInFlight = new Set();
const cliAuthSessions = new Map();

const cliCommands = {
  minimax: process.env.MINIMAX_CLI_COMMAND || "mmx",
  grok: process.env.GROK_BUILD_COMMAND || "grok",
  openai: process.env.OPENAI_CODEX_COMMAND || "codex",
};

const providers = {
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "local-model",
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    endpoint: "https://api.minimax.io/v1",
    model: "MiniMax-M2.7",
  },
  grok: {
    id: "grok",
    name: "Grok",
    endpoint: "https://api.x.ai/v1",
    model: "grok-4.5",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "codex-default",
  },
};

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES)
      throw Object.assign(new Error("Request body exceeds 1 MiB."), {
        status: 413,
      });
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function isLoopback(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
}

function authorized(req) {
  return (
    !API_TOKEN ||
    isLoopback(req) ||
    req.headers.authorization === `Bearer ${API_TOKEN}`
  );
}

function textFromCompletion(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.message?.reasoning_content ||
    data?.choices?.[0]?.text ||
    ""
  );
}

function parseProbability(text) {
  const tag = text.match(/<probability>\s*(\d{1,3})\s*<\/probability>/i)?.[1];
  const prose = text.match(
    /(?:probability|chance|likely)\D{0,20}(\d{1,3})\s*%/i,
  )?.[1];
  return Math.max(0, Math.min(100, Number(tag || prose || 50)));
}

function parseForecastAnswer(text) {
  return (
    text
      .match(/<forecast_answer>\s*([\s\S]*?)\s*<\/forecast_answer>/i)?.[1]
      ?.trim() || ""
  );
}

async function providerForecast(provider, event, deadline) {
  const endpoint = (provider.endpoint || "").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey
        ? { Authorization: `Bearer ${provider.apiKey}` }
        : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: `Forecast this binary future event: "${event}". Resolution deadline: ${deadline}. Return only XML: <probability>0-100</probability><confidence>High|Medium|Low</confidence><reasoning>2-3 concise sentences with base rates, evidence, and disconfirming signals.</reasoning>`,
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`${provider.name} returned ${response.status}`);
  const text = textFromCompletion(await response.json());
  return {
    provider: provider.id,
    probability: parseProbability(text),
    confidence:
      text.match(/<confidence>([\s\S]*?)<\/confidence>/i)?.[1]?.trim() ||
      "Medium",
    reasoning: text.replace(/<[^>]+>/g, "").trim(),
    status: "live",
  };
}

function normalizeResults(provider, data) {
  const raw = provider === "searxng" ? data.results : data.results;
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      title: item.title || "Untitled result",
      url: item.url || item.link || "",
      snippet: item.content || item.description || "",
      score: typeof item.score === "number" ? item.score : undefined,
      source: provider,
    }))
    .filter((item) => item.url);
}

function searchErrorMessage(provider, error) {
  const code = error?.cause?.code || error?.code;
  if (code === "ECONNREFUSED")
    return `${provider === "searxng" ? "SearXNG" : provider} rejected the connection. The host is reachable, but no service is listening on that port; bind the service to its LAN/Tailscale interface and check its firewall.`;
  if (code === "ETIMEDOUT" || error?.name === "TimeoutError")
    return `${provider === "searxng" ? "SearXNG" : provider} timed out. Check routing, firewall rules, and whether the service is healthy.`;
  if (code === "ENOTFOUND")
    return `${provider === "searxng" ? "SearXNG" : provider} host could not be resolved.`;
  return error instanceof Error ? error.message : "Search failed";
}

async function providerSearch(provider, query, options) {
  if (provider === "searxng") {
    const baseUrl = String(
      options.searchConfig?.searxngUrl || SEARXNG_URL,
    ).replace(/\/$/, "");
    let url;
    try {
      url = new URL(`${baseUrl}/search`);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("SearXNG endpoint must use http or https.");
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes("http")
          ? error.message
          : "Enter a valid SearXNG base URL.",
      );
    }
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", String(options.safeSearch ?? 1));
    if (options.timeRange)
      url.searchParams.set("time_range", options.timeRange);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
    return {
      provider,
      results: normalizeResults(provider, await response.json()),
    };
  }
  if (provider === "tavily") {
    const apiKey = String(
      options.searchConfig?.tavilyApiKey || TAVILY_API_KEY,
    ).trim();
    if (!apiKey)
      throw new Error("Add a Tavily API key in Settings → Search providers.");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: options.depth === "deep" ? "advanced" : "basic",
        topic: options.topic || "general",
        max_results: Math.min(options.maxResults, 10),
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Tavily returned ${response.status}`);
    return {
      provider,
      results: normalizeResults(provider, await response.json()),
    };
  }
  if (provider === "brave") {
    const apiKey = String(
      options.searchConfig?.braveApiKey || BRAVE_SEARCH_API_KEY,
    ).trim();
    if (!apiKey)
      throw new Error(
        "Add a Brave Search API key in Settings → Search providers.",
      );
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(options.maxResults, 10)));
    url.searchParams.set("safesearch", options.safeSearch ? "moderate" : "off");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Brave returned ${response.status}`);
    const data = await response.json();
    return {
      provider,
      results: normalizeResults(provider, { results: data.web?.results || [] }),
    };
  }
  throw new Error(`Unknown search provider: ${provider}`);
}

async function visualSearch(input) {
  const provider = input.provider || "searxng";
  const query = `${String(input.event || "").slice(0, 300)} visual evidence maps charts imagery dashboard`;
  if (!query.trim()) return { sources: [], error: "event is required" };
  try {
    if (provider === "searxng") {
      const baseUrl = String(input.searchConfig?.searxngUrl || SEARXNG_URL).replace(/\/$/, "");
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("categories", "images");
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`SearXNG image search returned ${response.status}`);
      const data = await response.json();
      return {
        sources: (Array.isArray(data.results) ? data.results : []).slice(0, 8).map((item) => ({
          title: item.title || "Visual evidence",
          url: item.url || item.img_src || "",
          imageUrl: item.img_src || item.thumbnail_src || "",
          source: provider,
        })).filter((item) => item.url && item.imageUrl),
      };
    }
    if (provider === "brave") {
      const apiKey = String(input.searchConfig?.braveApiKey || BRAVE_SEARCH_API_KEY).trim();
      if (!apiKey) throw new Error("Add a Brave Search API key in Settings → Search providers.");
      const url = new URL("https://api.search.brave.com/res/v1/images/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "8");
      const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Brave image search returned ${response.status}`);
      const data = await response.json();
      return {
        sources: (data.results || []).slice(0, 8).map((item) => ({ title: item.title || "Visual evidence", url: item.source || item.url || "", imageUrl: item.thumbnail?.src || item.properties?.url || "", source: provider })).filter((item) => item.url && item.imageUrl),
      };
    }
    return { sources: [], error: "Tavily does not expose image search through this connector; choose SearXNG or Brave for visual evidence." };
  } catch (error) {
    return { sources: [], error: searchErrorMessage(provider, error) };
  }
}

async function searchWeb(input) {
  const provider = input.provider || "searxng";
  const depth = input.depth === "deep" ? "deep" : "quick";
  const maxQueries = Math.min(Math.max(depth === "deep" ? 6 : 3, 1), 6);
  const queries = (Array.isArray(input.queries) ? input.queries : [input.query])
    .map((query) =>
      String(query || "")
        .trim()
        .slice(0, 400),
    )
    .filter(Boolean)
    .slice(0, maxQueries);
  if (!queries.length) throw new Error("query or queries is required");
  const maxResults = Math.min(Math.max(Number(input.maxResults) || 5, 1), 10);
  const results = [];
  const errors = [];
  for (const query of queries) {
    const cacheKey = JSON.stringify({
      provider,
      query,
      maxResults,
      depth,
      topic: input.topic || "general",
      timeRange: input.timeRange || "",
    });
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      results.push(...cached.results);
      continue;
    }
    try {
      let promise = searchInFlight.get(cacheKey);
      if (!promise) {
        promise = providerSearch(provider, query, {
          ...input,
          depth,
          maxResults,
        });
        searchInFlight.set(cacheKey, promise);
      }
      const response = await promise;
      searchInFlight.delete(cacheKey);
      searchCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1000,
        results: response.results,
      });
      results.push(...response.results.map((result) => ({ ...result, query })));
    } catch (error) {
      searchInFlight.delete(cacheKey);
      errors.push({
        provider,
        query,
        error: searchErrorMessage(provider, error),
      });
    }
  }
  const unique = [
    ...new Map(results.map((result) => [result.url, result])).values(),
  ];
  // A deep pass should not be dominated by a single publisher. Keep the first
  // result from each domain before filling the remaining source budget.
  const seenDomains = new Set();
  const diverse = [];
  const remainder = [];
  for (const result of unique) {
    let domain = result.url;
    try {
      domain = new URL(result.url).hostname.replace(/^www\./, "");
    } catch {
      // Preserve malformed-but-useful provider results after valid URLs.
    }
    if (!seenDomains.has(domain)) {
      seenDomains.add(domain);
      diverse.push(result);
    } else {
      remainder.push(result);
    }
  }
  const sourceBudget = queries.length * maxResults;
  const selected = [...diverse, ...remainder].slice(0, sourceBudget);
  return {
    provider,
    depth,
    queries,
    results: selected,
    errors,
    budget: {
      maxQueries,
      usedQueries: queries.length,
      maxResultsPerQuery: maxResults,
      uniqueDomains: seenDomains.size,
      cacheTtlSeconds: 300,
    },
  };
}

function nextLine(reader, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reader.stream.off("data", onData);
      reader.stream.off("error", onError);
      reject(new Error("Local MoA timed out waiting for MCP response."));
    }, timeoutMs);
    const onData = (chunk) => {
      reader.buffer += chunk.toString();
      const newline = reader.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = reader.buffer.slice(0, newline).trim();
      reader.buffer = reader.buffer.slice(newline + 1);
      reader.stream.off("data", onData);
      reader.stream.off("error", onError);
      clearTimeout(timeout);
      if (!line) return nextLine(reader).then(resolve, reject);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      reader.stream.off("data", onData);
      clearTimeout(timeout);
      reject(error);
    };
    reader.stream.on("data", onData);
    reader.stream.on("error", onError);
  });
}

async function callLocalMoa(task, context = "", lmApiToken = "") {
  const command =
    process.env.LOCAL_MOA_COMMAND ||
    `${ROOT}integrations/local-moa-advisors-mcp/index.js`;
  const child = spawn(process.execPath, [command], {
    cwd: ROOT,
    env: {
      ...process.env,
      LM_STUDIO_URL: process.env.LM_STUDIO_URL || "http://127.0.0.1:1234/v1",
      LM_API_TOKEN: lmApiToken || process.env.LM_API_TOKEN || "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = { stream: child.stdout, buffer: "" };
  let requestId = 0;
  const send = (method, params = {}) => {
    const id = ++requestId;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return id;
  };
  try {
    send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "signal-forecast", version: "0.1.0" },
    });
    await nextLine(reader);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const id = send("tools/call", {
      name: "moa_advice",
      arguments: { task, context },
    });
    let message;
    for (;;) {
      message = await nextLine(reader);
      if (message.id === id) break;
    }
    const text =
      message.result?.content?.find((item) => item.type === "text")?.text ||
      message.error?.message ||
      "Local MoA returned no text.";
    return {
      text,
      probability: parseProbability(text),
      status: message.result?.isError ? "error" : "live",
    };
  } finally {
    child.kill();
  }
}

async function runForecast(input) {
  const event = String(input.event || "").trim();
  const deadline = String(input.deadline || "not specified");
  if (!event) throw new Error("event is required");
  const mode = input.mode || "single";
  const questionType = input.questionType || "binary";
  if (input.demo === true)
    return {
      mode: "demo",
      probability: 68,
      confidence: "Medium",
      questionType,
      answer:
        questionType === "timing"
          ? "July–December 2027 (demo window)"
          : questionType === "numeric"
            ? "45–55 (demo range)"
            : questionType === "categorical"
              ? "Base-case scenario (demo)"
              : "Yes",
      opinions: [
        {
          provider: "lmstudio",
          probability: 64,
          confidence: "Medium",
          reasoning: "Demo planner signal.",
          status: "demo",
        },
        {
          provider: "minimax",
          probability: 70,
          confidence: "High",
          reasoning: "Demo base-rate signal.",
          status: "demo",
        },
        {
          provider: "grok",
          probability: 62,
          confidence: "Medium",
          reasoning: "Demo disconfirming-signal check.",
          status: "demo",
        },
        {
          provider: "openai",
          probability: 76,
          confidence: "Medium",
          reasoning: "Demo synthesis signal.",
          status: "demo",
        },
      ],
      summary: `Demo forecast for ${event} before ${deadline}.`,
    };
  if (mode === "local-moa") {
    let researchContext = input.context || "";
    if (input.search !== false) {
      try {
        const research = await searchWeb({
          provider: input.searchConfig?.provider || "searxng",
          depth: "deep",
          queries: [event, `${event} macro factors`, `${event} latest news`],
          maxResults: 5,
          searchConfig: input.searchConfig,
        });
        researchContext += `\n\nSearch context:\n${research.results.map((item) => `- ${item.title}: ${item.snippet} (${item.url})`).join("\n")}`;
      } catch (error) {
        researchContext += `\n\nSearch context unavailable: ${error instanceof Error ? error.message : "search failed"}`;
      }
    }
    const moa = await callLocalMoa(
      `Produce a calibrated ${questionType} forecast: ${event}. Resolution deadline: ${deadline}. Return <forecast_answer> with the most likely ${questionType === "timing" ? "date or date window" : questionType === "numeric" ? "numeric range" : questionType === "categorical" ? "outcome" : "Yes or No answer"}, <probability>0-100</probability> for confidence in that answer, and explain evidence and disconfirming signals.`,
      researchContext,
      String(input.provider?.apiKey || ""),
    );
    return {
      mode,
      probability: moa.probability,
      answer: parseForecastAnswer(moa.text),
      confidence: "Medium",
      opinions: [
        {
          provider: "lmstudio",
          probability: moa.probability,
          confidence: "MoA",
          reasoning: moa.text,
          status: moa.status,
        },
      ],
      summary: moa.text,
    };
  }
  const configured = input.provider || providers.lmstudio;
  const opinion = await providerForecast(
    {
      ...configured,
      name: providers[configured.id]?.name || configured.name || configured.id,
    },
    event,
    deadline,
  );
  return {
    mode: "single",
    probability: opinion.probability,
    confidence: opinion.confidence,
    opinions: [opinion],
    summary: opinion.reasoning,
  };
}

async function commandStatus(command) {
  try {
    await execFileAsync(command, ["--version"], { timeout: 5000 });
    return { installed: true, command };
  } catch {
    return { installed: false, command };
  }
}

function cliAuthOutput(value) {
  return String(value || "")
    .replace(/(sk-|xai-)[A-Za-z0-9_-]+/g, "$1[redacted]")
    .slice(-6000);
}

async function cliAuthStatus(provider) {
  const command = cliCommands[provider];
  const installed = await commandStatus(command);
  if (!installed.installed)
    return { provider, ...installed, authenticated: false };
  if (provider === "minimax") {
    try {
      const result = await execFileAsync(command, ["auth", "status"], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const status = JSON.parse(result.stdout);
      return {
        provider,
        ...installed,
        authenticated: true,
        detail: {
          method: status.method || "configured",
          source: status.source || "local CLI config",
        },
      };
    } catch (error) {
      return {
        provider,
        ...installed,
        authenticated: false,
        detail: cliAuthOutput(error.stderr),
      };
    }
  }
  if (provider === "openai") {
    try {
      const result = await execFileAsync(command, ["login", "status"], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      return {
        provider,
        ...installed,
        authenticated: true,
        detail:
          cliAuthOutput(result.stdout).trim() ||
          "Codex CLI has a local ChatGPT session.",
      };
    } catch (error) {
      return {
        provider,
        ...installed,
        authenticated: false,
        detail: cliAuthOutput(error.stderr) || "No Codex CLI login found.",
      };
    }
  }
  const authenticated = await access(`${homedir()}/.grok/auth.json`)
    .then(() => true)
    .catch(() => false);
  return {
    provider,
    ...installed,
    authenticated,
    detail: authenticated
      ? "Grok Build has a local OAuth session."
      : "No Grok Build OAuth session found.",
  };
}

async function cliModels(provider) {
  if (!Object.hasOwn(cliCommands, provider))
    throw Object.assign(new Error("Unknown CLI provider."), { status: 404 });
  if (provider === "minimax") return ["MiniMax-M3", "MiniMax-M2.7"];
  if (provider === "openai")
    return [
      "codex-default",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
    ];
  try {
    const result = await execFileAsync(cliCommands.grok, ["models"], {
      timeout: 10000,
      maxBuffer: 256 * 1024,
    });
    return result.stdout
      .split("\n")
      .map((line) =>
        line
          .match(/^\s*(?:\*\s*)?-\s+(.+?)\s*(?:\(default\))?\s*$/)?.[1]
          ?.trim(),
      )
      .filter(Boolean);
  } catch (error) {
    throw Object.assign(
      new Error(
        cliAuthOutput(error.stderr) || "Could not load Grok Build models.",
      ),
      { status: 502 },
    );
  }
}

function cliForecastOutput(provider, output) {
  const raw = String(output || "").trim();
  if (provider !== "minimax") return raw;
  try {
    const payload = JSON.parse(raw);
    return (
      textFromCompletion(payload) ||
      payload?.data?.content ||
      payload?.data?.text ||
      payload?.output_text ||
      raw
    );
  } catch {
    return raw;
  }
}

function startCliOAuth(provider, flow = "browser") {
  if (!Object.hasOwn(cliCommands, provider))
    throw Object.assign(new Error("Unknown CLI OAuth provider."), {
      status: 404,
    });
  const existing = cliAuthSessions.get(provider);
  if (existing?.state === "running") return existing;
  const args =
    provider === "minimax"
      ? ["auth", "login", "--recommend", "--region=global"]
      : provider === "openai"
        ? ["login", ...(flow === "device" ? ["--device-auth"] : [])]
        : ["login", flow === "device" ? "--device-auth" : "--oauth"];
  const session = {
    provider,
    state: "running",
    startedAt: new Date().toISOString(),
    output: "Starting local CLI OAuth…",
  };
  const child = spawn(cliCommands[provider], args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    session.output = cliAuthOutput(`${session.output}\n${chunk.toString()}`);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    session.state = "error";
    session.output = cliAuthOutput(`${session.output}\n${error.message}`);
  });
  child.on("close", (code) => {
    session.state = code === 0 ? "complete" : "error";
    session.finishedAt = new Date().toISOString();
    session.exitCode = code;
  });
  cliAuthSessions.set(provider, session);
  return session;
}

function cliForecastPrompt(brief) {
  const questionType = String(brief.questionType || "binary");
  const answerInstruction =
    questionType === "timing"
      ? "Return the most likely date or date window in <forecast_answer>."
      : questionType === "numeric"
        ? "Return the most likely numeric range with units in <forecast_answer>."
        : questionType === "categorical"
          ? "Return the most likely outcome in <forecast_answer>."
          : "Return Yes or No in <forecast_answer>.";
  return [
    "You are a calibrated superforecaster. Return XML only.",
    `Question: ${String(brief.question || "").slice(0, 6000)}`,
    `Question type: ${questionType}`,
    `Deadline: ${String(brief.deadline || "not specified").slice(0, 120)}`,
    brief.resolutionCriteria
      ? `Resolution criteria: ${String(brief.resolutionCriteria).slice(0, 2000)}`
      : "",
    brief.context ? `Context: ${String(brief.context).slice(0, 4000)}` : "",
    `${answerInstruction} Include <probability>0-100</probability> for confidence in the central answer, <confidence>High|Medium|Low</confidence>, <reasoning>3-6 nuanced sentences</reasoning>, <drivers>semicolon-separated drivers</drivers>, <counter_signals>semicolon-separated counter-signals</counter_signals>, <update_triggers>semicolon-separated update triggers</update_triggers>, and <assumptions>semicolon-separated assumptions</assumptions>.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runCliForecast(input) {
  const provider = input.provider;
  if (provider !== "minimax" && provider !== "grok" && provider !== "openai")
    throw Object.assign(
      new Error("CLI forecasts support MiniMax, Grok, and OpenAI Codex only."),
      { status: 400 },
    );
  if (agentInFlight.has(`cli-${provider}`))
    throw Object.assign(
      new Error(`${provider} CLI forecast is already running.`),
      { status: 429 },
    );
  agentInFlight.add(`cli-${provider}`);
  let outputDirectory = "";
  try {
    const prompt = cliForecastPrompt(input.brief || {});
    let model = String(input.model || "")
      .trim()
      .slice(0, 160);
    if (provider === "grok") {
      const availableModels = await cliModels("grok");
      // Older browser settings used the xAI API's grok-3-mini identifier,
      // which is not accepted by Grok Build OAuth. Recover automatically.
      if (availableModels.length && !availableModels.includes(model))
        model = availableModels[0];
    }
    if (provider === "openai") {
      const availableModels = await cliModels("openai");
      // Saved API-only IDs such as gpt-4o-mini are not reliable through
      // ChatGPT OAuth. Let Codex select the account-approved default instead.
      if (!availableModels.includes(model)) model = "codex-default";
    }
    if (provider === "openai")
      outputDirectory = await mkdtemp(join(tmpdir(), "signal-codex-"));
    const outputPath = outputDirectory
      ? join(outputDirectory, "final.txt")
      : "";
    const args =
      provider === "minimax"
        ? [
            "text",
            "chat",
            ...(model ? ["--model", model] : []),
            "--message",
            prompt,
            "--output",
            "json",
          ]
        : provider === "grok"
          ? [
              "-p",
              prompt,
              "--output-format",
              "plain",
              ...(model ? ["--model", model] : []),
              "--max-turns",
              "1",
              "--no-subagents",
              "--disable-web-search",
            ]
          : [
              "exec",
              "--ephemeral",
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "--output-last-message",
              outputPath,
              ...(model && model !== "codex-default" ? ["--model", model] : []),
              prompt,
            ];
    const result = await execFileAsync(cliCommands[provider], args, {
      // Codex may spend longer on its first ChatGPT-OAuth request and on the
      // deliberately detailed forecast prompt. Do not turn that into a blank
      // result while shorter CLI providers remain tightly bounded.
      timeout: provider === "openai" ? 300000 : 120000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const finalOutput = outputPath
      ? await readFile(outputPath, "utf8").catch(
          () => result.stdout || result.stderr || "",
        )
      : result.stdout || result.stderr || "";
    if (!String(finalOutput).trim())
      throw new Error(
        `${provider} CLI finished without a readable final response.`,
      );
    return {
      provider,
      output: cliForecastOutput(provider, finalOutput),
    };
  } finally {
    agentInFlight.delete(`cli-${provider}`);
    if (outputDirectory)
      await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function runAgent(kind, input) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  if (agentInFlight.has(kind))
    throw Object.assign(new Error(`${kind} connector is already running.`), {
      status: 429,
    });
  agentInFlight.add(kind);
  try {
    if (kind === "openclaw") {
      const args = ["agent", "--json", "--message", prompt];
      if (input.agentId) args.push("--agent", String(input.agentId));
      if (input.sessionKey)
        args.push("--session-key", String(input.sessionKey));
      const result = await execFileAsync(
        process.env.OPENCLAW_COMMAND || "openclaw",
        args,
        { timeout: 600000, maxBuffer: 1024 * 1024 },
      );
      return { agent: "openclaw", output: result.stdout.trim() };
    }
    const args = ["-z", prompt];
    if (input.model) args.push("--model", String(input.model));
    if (input.provider) args.push("--provider", String(input.provider));
    const result = await execFileAsync(
      process.env.HERMES_COMMAND || "hermes",
      args,
      { timeout: 600000, maxBuffer: 1024 * 1024 },
    );
    return { agent: "hermes", output: result.stdout.trim() };
  } finally {
    agentInFlight.delete(kind);
  }
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
  try {
    if (req.method === "GET" && path === "/api/health")
      return json(res, 200, {
        ok: true,
        service: "signal-forecast-api",
        host: HOST,
        port: PORT,
      });
    if (req.method === "GET" && path === "/api/connectors")
      return json(res, 200, {
        localMoa: {
          installed: await access(
            `${ROOT}integrations/local-moa-advisors-mcp/index.js`,
          )
            .then(() => true)
            .catch(() => false),
          protocol: "MCP stdio",
          tool: "moa_advice",
        },
        openclaw: await commandStatus(
          process.env.OPENCLAW_COMMAND || "openclaw",
        ),
        hermes: await commandStatus(process.env.HERMES_COMMAND || "hermes"),
        minimaxCli: await cliAuthStatus("minimax"),
        grokBuild: await cliAuthStatus("grok"),
        openaiCodex: await cliAuthStatus("openai"),
      });
    const authMatch = path.match(
      /^\/api\/cli-auth\/(minimax|grok|openai)\/(login|status|models)$/,
    );
    if (authMatch && req.method === "GET" && authMatch[2] === "status")
      return json(res, 200, {
        ...(await cliAuthStatus(authMatch[1])),
        session: cliAuthSessions.get(authMatch[1]) || null,
      });
    if (authMatch && req.method === "GET" && authMatch[2] === "models")
      return json(res, 200, {
        provider: authMatch[1],
        models: await cliModels(authMatch[1]),
      });
    if (req.method !== "POST") return json(res, 404, { error: "Not found" });
    const input = await body(req);
    if (authMatch && authMatch[2] === "login")
      return json(res, 202, startCliOAuth(authMatch[1], input.flow));
    if (path === "/api/forecast")
      return json(res, 200, await runForecast(input));
    if (path === "/api/cli-forecast")
      return json(res, 200, await runCliForecast(input));
    if (path === "/api/search") return json(res, 200, await searchWeb(input));
    if (path === "/api/research") {
      const researchInput = {
          ...input,
          provider: input.provider || "searxng",
          depth: input.depth || "deep",
          queries: input.queries || [
            input.event,
            `${input.event} latest developments and current status`,
            `${input.event} macroeconomic and geopolitical drivers`,
            `${input.event} official data, primary sources, and key statistics`,
            `${input.event} risks, counterarguments, and disconfirming evidence`,
            `${input.event} scenarios, leading indicators, and forecast signals`,
          ],
        };
      const [research, visual] = await Promise.all([searchWeb(researchInput), visualSearch(researchInput)]);
      return json(res, 200, { ...research, visualSources: visual.sources, visualError: visual.error });
    }
    if (path === "/api/agent/openclaw")
      return json(res, 200, await runAgent("openclaw", input));
    if (path === "/api/agent/hermes")
      return json(res, 200, await runAgent("hermes", input));
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, error?.status || 502, {
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
});

server.listen(PORT, HOST, () =>
  console.log(`Signal Forecast API listening at http://${HOST}:${PORT}`),
);
