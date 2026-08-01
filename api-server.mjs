import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.SIGNAL_API_PORT || 8787);
const HOST = process.env.SIGNAL_API_HOST || '127.0.0.1';
const API_TOKEN = process.env.SIGNAL_API_TOKEN || '';
const ROOT = new URL('.', import.meta.url).pathname;
const SEARXNG_URL = (process.env.SEARXNG_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const MAX_BODY_BYTES = 1024 * 1024;
const searchCache = new Map();
const searchInFlight = new Map();
const agentInFlight = new Set();

const providers = {
  lmstudio: { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  minimax: { id: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.io/v1', model: 'MiniMax-M2.7' },
  grok: { id: 'grok', name: 'Grok', endpoint: 'https://api.x.ai/v1', model: 'grok-3-mini' },
  openai: { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 });
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function authorized(req) {
  return !API_TOKEN || isLoopback(req) || req.headers.authorization === `Bearer ${API_TOKEN}`;
}

function textFromCompletion(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.text || '';
}

function parseProbability(text) {
  const tag = text.match(/<probability>\s*(\d{1,3})\s*<\/probability>/i)?.[1];
  const prose = text.match(/(?:probability|chance|likely)\D{0,20}(\d{1,3})\s*%/i)?.[1];
  return Math.max(0, Math.min(100, Number(tag || prose || 50)));
}

async function providerForecast(provider, event, deadline) {
  const endpoint = (provider.endpoint || '').replace(/\/$/, '');
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: JSON.stringify({ model: provider.model, temperature: 0.2, messages: [{ role: 'user', content: `Forecast this binary future event: "${event}". Resolution deadline: ${deadline}. Return only XML: <probability>0-100</probability><confidence>High|Medium|Low</confidence><reasoning>2-3 concise sentences with base rates, evidence, and disconfirming signals.</reasoning>` }] }),
  });
  if (!response.ok) throw new Error(`${provider.name} returned ${response.status}`);
  const text = textFromCompletion(await response.json());
  return { provider: provider.id, probability: parseProbability(text), confidence: text.match(/<confidence>([\s\S]*?)<\/confidence>/i)?.[1]?.trim() || 'Medium', reasoning: text.replace(/<[^>]+>/g, '').trim(), status: 'live' };
}

function normalizeResults(provider, data) {
  const raw = provider === 'searxng' ? data.results : data.results;
  return (Array.isArray(raw) ? raw : []).map((item) => ({ title: item.title || 'Untitled result', url: item.url || item.link || '', snippet: item.content || item.description || '', score: typeof item.score === 'number' ? item.score : undefined, source: provider })).filter((item) => item.url);
}

async function providerSearch(provider, query, options) {
  if (provider === 'searxng') {
    const url = new URL(`${SEARXNG_URL}/search`);
    url.searchParams.set('q', query); url.searchParams.set('format', 'json'); url.searchParams.set('safesearch', String(options.safeSearch ?? 1));
    if (options.timeRange) url.searchParams.set('time_range', options.timeRange);
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
    return { provider, results: normalizeResults(provider, await response.json()) };
  }
  if (provider === 'tavily') {
    if (!TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is not configured');
    const response = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_API_KEY}` }, body: JSON.stringify({ query, search_depth: options.depth === 'deep' ? 'advanced' : 'basic', topic: options.topic || 'general', max_results: Math.min(options.maxResults, 10), include_answer: false, include_raw_content: false }) , signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Tavily returned ${response.status}`);
    return { provider, results: normalizeResults(provider, await response.json()) };
  }
  if (provider === 'brave') {
    if (!BRAVE_SEARCH_API_KEY) throw new Error('BRAVE_SEARCH_API_KEY is not configured');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query); url.searchParams.set('count', String(Math.min(options.maxResults, 10))); url.searchParams.set('safesearch', options.safeSearch ? 'moderate' : 'off');
    const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_SEARCH_API_KEY }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Brave returned ${response.status}`);
    const data = await response.json();
    return { provider, results: normalizeResults(provider, { results: data.web?.results || [] }) };
  }
  throw new Error(`Unknown search provider: ${provider}`);
}

async function searchWeb(input) {
  const provider = input.provider || 'searxng';
  const depth = input.depth === 'deep' ? 'deep' : 'quick';
  const maxQueries = Math.min(Math.max(depth === 'deep' ? 6 : 3, 1), 6);
  const queries = (Array.isArray(input.queries) ? input.queries : [input.query]).map((query) => String(query || '').trim().slice(0, 400)).filter(Boolean).slice(0, maxQueries);
  if (!queries.length) throw new Error('query or queries is required');
  const maxResults = Math.min(Math.max(Number(input.maxResults) || 5, 1), 10);
  const results = [];
  const errors = [];
  for (const query of queries) {
    const cacheKey = JSON.stringify({ provider, query, maxResults, depth, topic: input.topic || 'general', timeRange: input.timeRange || '' });
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) { results.push(...cached.results); continue; }
    try {
      let promise = searchInFlight.get(cacheKey);
      if (!promise) { promise = providerSearch(provider, query, { ...input, depth, maxResults }); searchInFlight.set(cacheKey, promise); }
      const response = await promise;
      searchInFlight.delete(cacheKey); searchCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, results: response.results }); results.push(...response.results.map((result) => ({ ...result, query })));
    } catch (error) { searchInFlight.delete(cacheKey); errors.push({ provider, query, error: error instanceof Error ? error.message : 'Search failed' }); }
  }
  const unique = [...new Map(results.map((result) => [result.url, result])).values()].slice(0, queries.length * maxResults);
  return { provider, depth, queries, results: unique, errors, budget: { maxQueries, usedQueries: queries.length, maxResultsPerQuery: maxResults, cacheTtlSeconds: 300 } };
}

function nextLine(reader, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reader.stream.off('data', onData);
      reader.stream.off('error', onError);
      reject(new Error('Local MoA timed out waiting for MCP response.'));
    }, timeoutMs);
    const onData = (chunk) => {
      reader.buffer += chunk.toString();
      const newline = reader.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = reader.buffer.slice(0, newline).trim();
      reader.buffer = reader.buffer.slice(newline + 1);
      reader.stream.off('data', onData);
      reader.stream.off('error', onError);
      clearTimeout(timeout);
      if (!line) return nextLine(reader).then(resolve, reject);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    const onError = (error) => { reader.stream.off('data', onData); clearTimeout(timeout); reject(error); };
    reader.stream.on('data', onData);
    reader.stream.on('error', onError);
  });
}

async function callLocalMoa(task, context = '') {
  const command = process.env.LOCAL_MOA_COMMAND || `${ROOT}integrations/local-moa-advisors-mcp/index.js`;
  const child = spawn(process.execPath, [command], { cwd: ROOT, env: { ...process.env, LM_STUDIO_URL: process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = { stream: child.stdout, buffer: '' };
  let requestId = 0;
  const send = (method, params = {}) => { const id = ++requestId; child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return id; };
  try {
    send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'signal-forecast', version: '0.1.0' } });
    await nextLine(reader);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const id = send('tools/call', { name: 'moa_advice', arguments: { task, context } });
    let message;
    for (;;) { message = await nextLine(reader); if (message.id === id) break; }
    const text = message.result?.content?.find((item) => item.type === 'text')?.text || message.error?.message || 'Local MoA returned no text.';
    return { text, probability: parseProbability(text), status: message.result?.isError ? 'error' : 'live' };
  } finally {
    child.kill();
  }
}

async function runForecast(input) {
  const event = String(input.event || '').trim();
  const deadline = String(input.deadline || 'not specified');
  if (!event) throw new Error('event is required');
  const mode = input.mode || 'single';
  if (input.demo === true) return { mode: 'demo', probability: 68, confidence: 'Medium', opinions: [{ provider: 'lmstudio', probability: 64, confidence: 'Medium', reasoning: 'Demo planner signal.', status: 'demo' }, { provider: 'minimax', probability: 70, confidence: 'High', reasoning: 'Demo base-rate signal.', status: 'demo' }, { provider: 'grok', probability: 62, confidence: 'Medium', reasoning: 'Demo disconfirming-signal check.', status: 'demo' }, { provider: 'openai', probability: 76, confidence: 'Medium', reasoning: 'Demo synthesis signal.', status: 'demo' }], summary: `Demo forecast for ${event} before ${deadline}.` };
  if (mode === 'local-moa') {
    let researchContext = input.context || '';
    if (input.search !== false) {
      try { const research = await searchWeb({ provider: 'searxng', depth: 'deep', queries: [event, `${event} macro factors`, `${event} latest news`], maxResults: 5 }); researchContext += `\n\nSearch context:\n${research.results.map((item) => `- ${item.title}: ${item.snippet} (${item.url})`).join('\n')}`; } catch (error) { researchContext += `\n\nSearch context unavailable: ${error instanceof Error ? error.message : 'search failed'}`; }
    }
    const moa = await callLocalMoa(`Produce a calibrated probability forecast for this binary event: ${event}. Resolution deadline: ${deadline}. Include <probability>0-100</probability> and explain evidence and disconfirming signals.`, researchContext);
    return { mode, probability: moa.probability, confidence: 'Medium', opinions: [{ provider: 'lmstudio', probability: moa.probability, confidence: 'MoA', reasoning: moa.text, status: moa.status }], summary: moa.text };
  }
  const configured = input.provider || providers.lmstudio;
  const opinion = await providerForecast({ ...configured, name: providers[configured.id]?.name || configured.name || configured.id }, event, deadline);
  return { mode: 'single', probability: opinion.probability, confidence: opinion.confidence, opinions: [opinion], summary: opinion.reasoning };
}

async function commandStatus(command) {
  try { await execFileAsync(command, ['--version'], { timeout: 5000 }); return { installed: true, command }; }
  catch { return { installed: false, command }; }
}

async function runAgent(kind, input) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (agentInFlight.has(kind)) throw Object.assign(new Error(`${kind} connector is already running.`), { status: 429 });
  agentInFlight.add(kind);
  try {
    if (kind === 'openclaw') {
      const args = ['agent', '--json', '--message', prompt];
      if (input.agentId) args.push('--agent', String(input.agentId));
      if (input.sessionKey) args.push('--session-key', String(input.sessionKey));
      const result = await execFileAsync(process.env.OPENCLAW_COMMAND || 'openclaw', args, { timeout: 600000, maxBuffer: 1024 * 1024 });
      return { agent: 'openclaw', output: result.stdout.trim() };
    }
    const args = ['-z', prompt];
    if (input.model) args.push('--model', String(input.model));
    if (input.provider) args.push('--provider', String(input.provider));
    const result = await execFileAsync(process.env.HERMES_COMMAND || 'hermes', args, { timeout: 600000, maxBuffer: 1024 * 1024 });
    return { agent: 'hermes', output: result.stdout.trim() };
  } finally {
    agentInFlight.delete(kind);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, service: 'signal-forecast-api', host: HOST, port: PORT });
    if (req.method === 'GET' && req.url === '/api/connectors') return json(res, 200, { localMoa: { installed: await access(`${ROOT}integrations/local-moa-advisors-mcp/index.js`).then(() => true).catch(() => false), protocol: 'MCP stdio', tool: 'moa_advice' }, openclaw: await commandStatus(process.env.OPENCLAW_COMMAND || 'openclaw'), hermes: await commandStatus(process.env.HERMES_COMMAND || 'hermes') });
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    const input = await body(req);
    if (req.url === '/api/forecast') return json(res, 200, await runForecast(input));
    if (req.url === '/api/search') return json(res, 200, await searchWeb(input));
    if (req.url === '/api/research') return json(res, 200, await searchWeb({ ...input, provider: input.provider || 'searxng', depth: input.depth || 'deep', queries: input.queries || [input.event, `${input.event} macro factors`, `${input.event} latest news`] }));
    if (req.url === '/api/agent/openclaw') return json(res, 200, await runAgent('openclaw', input));
    if (req.url === '/api/agent/hermes') return json(res, 200, await runAgent('hermes', input));
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, error?.status || 502, { error: error instanceof Error ? error.message : 'Request failed' }); }
});

server.listen(PORT, HOST, () => console.log(`Signal Forecast API listening at http://${HOST}:${PORT}`));
