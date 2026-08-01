export type ProviderId = 'lmstudio' | 'minimax' | 'grok' | 'openai';
export type ForecastMode = 'ensemble' | 'single' | 'local-moa';

export type ProviderConfig = {
  id: ProviderId;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  connected: boolean;
  oauthConfigured?: boolean;
};

export type ForecastOpinion = {
  provider: ProviderId;
  probability: number;
  confidence: string;
  reasoning: string;
  status: 'live' | 'demo' | 'error';
  error?: string;
};

export type ForecastResult = {
  probability: number;
  confidence: string;
  confidenceRange: [number, number];
  summary: string;
  timeline: string;
  bestCase: string;
  worstCase: string;
  indicators: string[];
  reasoning: string;
  opinions: ForecastOpinion[];
};

export const defaultProviders: ProviderConfig[] = [
  { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://localhost:1234/v1', model: 'local-model', apiKey: '', connected: false },
  { id: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.io/v1', model: 'MiniMax-M2.7', apiKey: '', connected: false },
  { id: 'grok', name: 'Grok', endpoint: 'https://api.x.ai/v1', model: 'grok-3-mini', apiKey: '', connected: false },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', connected: false, oauthConfigured: Boolean(import.meta.env.VITE_OPENAI_OAUTH_URL) },
];

const demoOpinions: ForecastOpinion[] = [
  { provider: 'lmstudio', probability: 64, confidence: 'Medium', reasoning: 'Recent inflation prints and softening labor data make a cut plausible, but the path remains data-dependent.', status: 'demo' },
  { provider: 'minimax', probability: 70, confidence: 'High', reasoning: 'The base rate and forward guidance favor a cut if inflation continues its gradual normalization.', status: 'demo' },
  { provider: 'grok', probability: 62, confidence: 'Medium', reasoning: 'Market pricing leans toward a cut, though geopolitical and energy shocks are meaningful counter-signals.', status: 'demo' },
  { provider: 'openai', probability: 76, confidence: 'Medium', reasoning: 'A cooling labor market with stable growth is the most likely setup for a measured policy pivot.', status: 'demo' },
];

function extractTag(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1]?.trim() || '';
}

function parseOpinion(provider: ProviderId, text: string): ForecastOpinion {
  const rawProbability = extractTag(text, 'probability') || text.match(/(?:probability|chance|likely)\D{0,20}(\d{1,3})\s*%/i)?.[1] || '50';
  const probability = Math.max(0, Math.min(100, Number.parseInt(rawProbability, 10) || 50));
  return {
    provider,
    probability,
    confidence: extractTag(text, 'confidence') || 'Medium',
    reasoning: extractTag(text, 'reasoning') || extractTag(text, 'summary') || text.replace(/<[^>]+>/g, '').trim().slice(0, 320),
    status: 'live',
  };
}

async function askProvider(provider: ProviderConfig, event: string, deadline: string): Promise<ForecastOpinion> {
  const prompt = `You are a calibrated superforecaster. Forecast this binary future event: "${event}". Resolution deadline: ${deadline}. Return only concise XML: <probability>0-100</probability><confidence>High|Medium|Low</confidence><reasoning>2-3 sentences with base rates, evidence, and disconfirming signals.</reasoning>`;
  const base = provider.endpoint.replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: JSON.stringify({ model: provider.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const json = await response.json();
  return parseOpinion(provider.id, json.choices?.[0]?.message?.content || '');
}

export async function probeProvider(provider: ProviderConfig): Promise<boolean> {
  const base = provider.endpoint.replace(/\/$/, '');
  const response = await fetch(`${base}/models`, { headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {} });
  return response.ok;
}

export async function runForecast(event: string, deadline: string, providers: ProviderConfig[], demoMode: boolean, options: { mode?: ForecastMode; providerId?: ProviderId; apiBase?: string } = {}): Promise<ForecastResult> {
  const mode = options.mode || 'ensemble';
  if (!demoMode && mode === 'local-moa') {
    const response = await fetch(`${options.apiBase || import.meta.env.VITE_SIGNAL_API_URL || 'http://127.0.0.1:8787'}/api/forecast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, event, deadline, search: true }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Local MoA API unavailable. Start npm run dev:api.');
    const remote = await response.json();
    const opinions = remote.opinions as ForecastOpinion[];
    return { probability: remote.probability, confidence: remote.confidence || 'Medium', confidenceRange: [Math.max(0, remote.probability - 16), Math.min(100, remote.probability + 16)], summary: remote.summary || 'Local MoA forecast returned.', timeline: `Resolution by ${deadline}`, bestCase: 'The evidence supporting the forecast continues to accumulate.', worstCase: 'A disconfirming signal invalidates the current assumptions.', indicators: ['Planner synthesis', 'Skeptic challenge', 'Aggregator judgment'], reasoning: remote.summary || '', opinions };
  }
  const selected = mode === 'single' ? providers.filter(p => p.id === (options.providerId || 'lmstudio')) : providers.filter(p => p.connected);
  const opinions = demoMode ? (mode === 'single' ? demoOpinions.filter(opinion => opinion.provider === (options.providerId || 'lmstudio')) : demoOpinions) : await Promise.all(selected.map(async (provider) => {
    try { return await askProvider(provider, event, deadline); }
    catch (error) { return { provider: provider.id, probability: 50, confidence: 'Unavailable', reasoning: 'Provider did not return a forecast.', status: 'error' as const, error: error instanceof Error ? error.message : 'Unknown provider error' }; }
  }));
  const usable = opinions.length ? opinions : demoOpinions;
  const probability = Math.round(usable.reduce((sum, opinion) => sum + opinion.probability, 0) / usable.length);
  const spread = Math.max(...usable.map(o => o.probability)) - Math.min(...usable.map(o => o.probability));
  const confidence = spread <= 10 ? 'High' : spread <= 22 ? 'Medium' : 'Low';
  return {
    probability,
    confidence,
    confidenceRange: [Math.max(0, probability - (confidence === 'High' ? 10 : confidence === 'Medium' ? 16 : 24)), Math.min(100, probability + (confidence === 'High' ? 10 : confidence === 'Medium' ? 16 : 24))],
    summary: `${probability}% aggregate likelihood before ${deadline}. The council is ${confidence.toLowerCase()} confidence because provider estimates span ${Math.min(...usable.map(o => o.probability))}–${Math.max(...usable.map(o => o.probability))}%.`,
    timeline: `Resolution by ${deadline}`,
    bestCase: 'Inflation and labor data continue to cool without a material growth shock.',
    worstCase: 'A renewed inflation or energy shock delays the expected policy change.',
    indicators: ['Latest inflation trend and breadth', 'Labor-market cooling without recession', 'Forward market pricing and guidance', 'Unexpected energy or geopolitical shock'],
    reasoning: 'The aggregation weighs independent provider estimates equally. Treat this as a calibrated probability, not a fact or financial recommendation; update it as new evidence arrives.',
    opinions: usable,
  };
}
