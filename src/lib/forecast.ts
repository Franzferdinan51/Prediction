export type ProviderId = "lmstudio" | "minimax" | "grok" | "openai";
export type ForecastMode = "ensemble" | "single" | "local-moa";

export type ForecastBrief = {
  question: string;
  deadline: string;
  context?: string;
  resolutionCriteria?: string;
};

export type ProviderConfig = {
  id: ProviderId;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  connected: boolean;
  authMode?: "api-key" | "cli-oauth";
  oauthConfigured?: boolean;
};

export type ForecastReadout = {
  thesis: string;
  drivers: string[];
  counterSignals: string[];
  updateTriggers: string[];
  assumptions: string[];
};

export type ForecastOpinion = {
  provider: ProviderId;
  probability: number;
  confidence: string;
  reasoning: string;
  status: "live" | "demo" | "error";
  error?: string;
  readout?: Partial<ForecastReadout>;
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
  readout: ForecastReadout;
};

export type ProviderProbe = {
  ok: boolean;
  models: string[];
  error?: string;
  needsApiKey?: boolean;
};

export const defaultProviders: ProviderConfig[] = [
  {
    id: "lmstudio",
    name: "LM Studio",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "local-model",
    apiKey: "",
    connected: false,
  },
  {
    id: "minimax",
    name: "MiniMax",
    endpoint: "https://api.minimax.io/v1",
    model: "MiniMax-M2.7",
    apiKey: "",
    connected: false,
  },
  {
    id: "grok",
    name: "Grok",
    endpoint: "https://api.x.ai/v1",
    model: "grok-3-mini",
    apiKey: "",
    connected: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
    connected: false,
    oauthConfigured: Boolean(import.meta.env.VITE_OPENAI_OAUTH_URL),
  },
];

const demoOpinions: ForecastOpinion[] = [
  {
    provider: "lmstudio",
    probability: 64,
    confidence: "Medium",
    reasoning:
      "Cooling inflation and softer labor data make a cut plausible, but the path remains data-dependent.",
    status: "demo",
  },
  {
    provider: "minimax",
    probability: 70,
    confidence: "High",
    reasoning:
      "Base rates and forward guidance favor a cut if inflation continues to normalize.",
    status: "demo",
  },
  {
    provider: "grok",
    probability: 62,
    confidence: "Medium",
    reasoning:
      "Market pricing leans toward a cut, though geopolitical and energy shocks are meaningful counter-signals.",
    status: "demo",
  },
  {
    provider: "openai",
    probability: 76,
    confidence: "Medium",
    reasoning:
      "A cooling labor market with stable growth is the most likely setup for a measured policy pivot.",
    status: "demo",
  },
];

function extractTag(text: string, tag: string): string {
  return (
    text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() ||
    ""
  );
}

function listTag(text: string, tag: string): string[] {
  return extractTag(text, tag)
    .split(/\n|;|•/)
    .map((value) => value.replace(/^[-*\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function textFromError(status: number, payload: unknown): string {
  const message =
    typeof payload === "object" && payload
      ? (payload as { error?: { message?: string } | string }).error
      : undefined;
  const detail = typeof message === "string" ? message : message?.message;
  if (status === 401)
    return "LM Studio requires an API token. Paste the token from LM Studio into its “API token” field, then auto-connect again.";
  return detail ? `${status}: ${detail}` : `Request failed (${status}).`;
}

function buildPrompt(brief: ForecastBrief): string {
  return [
    "You are a calibrated superforecaster. Analyze the event precisely and avoid pretending uncertain evidence is certain.",
    `Question:\n${brief.question.trim()}`,
    `Resolution deadline: ${brief.deadline}`,
    brief.resolutionCriteria?.trim()
      ? `Resolution criteria:\n${brief.resolutionCriteria.trim()}`
      : "",
    brief.context?.trim()
      ? `Context, constraints, and known evidence:\n${brief.context.trim()}`
      : "",
    "Return XML only. Be concise but substantive. Use <probability>0-100</probability>, <confidence>High|Medium|Low</confidence>, <reasoning>a nuanced 3-6 sentence readout</reasoning>, <drivers>semicolon-separated key drivers</drivers>, <counter_signals>semicolon-separated disconfirming signals</counter_signals>, <update_triggers>semicolon-separated facts that would change the estimate</update_triggers>, and <assumptions>semicolon-separated assumptions</assumptions>.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseOpinion(provider: ProviderId, text: string): ForecastOpinion {
  const rawProbability =
    extractTag(text, "probability") ||
    text.match(/(?:probability|chance|likely)\D{0,20}(\d{1,3})\s*%/i)?.[1] ||
    "50";
  return {
    provider,
    probability: Math.max(
      0,
      Math.min(100, Number.parseInt(rawProbability, 10) || 50),
    ),
    confidence: extractTag(text, "confidence") || "Medium",
    reasoning:
      extractTag(text, "reasoning") ||
      extractTag(text, "summary") ||
      text
        .replace(/<[^>]+>/g, "")
        .trim()
        .slice(0, 1600),
    status: "live",
    readout: {
      drivers: listTag(text, "drivers"),
      counterSignals: listTag(text, "counter_signals"),
      updateTriggers: listTag(text, "update_triggers"),
      assumptions: listTag(text, "assumptions"),
    },
  };
}

function providerHeaders(provider: ProviderConfig, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(provider.apiKey.trim()
      ? { Authorization: `Bearer ${provider.apiKey.trim()}` }
      : {}),
  };
}

async function askProvider(
  provider: ProviderConfig,
  brief: ForecastBrief,
): Promise<ForecastOpinion> {
  const response = await fetch(
    `${provider.endpoint.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: providerHeaders(provider, true),
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        messages: [{ role: "user", content: buildPrompt(brief) }],
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      textFromError(response.status, await response.json().catch(() => null)),
    );
  return parseOpinion(
    provider.id,
    (await response.json()).choices?.[0]?.message?.content || "",
  );
}

async function askCliProvider(
  provider: ProviderConfig,
  brief: ForecastBrief,
  apiBase: string,
): Promise<ForecastOpinion> {
  const response = await fetch(`${apiBase}/api/cli-forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ provider: provider.id, brief }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `${provider.name} CLI forecast failed.`);
  return parseOpinion(provider.id, data.output || "");
}

export async function probeProvider(
  provider: ProviderConfig,
): Promise<ProviderProbe> {
  try {
    const response = await fetch(
      `${provider.endpoint.replace(/\/$/, "")}/models`,
      {
        headers: providerHeaders(provider),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      return {
        ok: false,
        models: [],
        needsApiKey: response.status === 401,
        error: textFromError(
          response.status,
          await response.json().catch(() => null),
        ),
      };
    const data = await response.json();
    const models = Array.isArray(data?.data)
      ? data.data
          .map((item: { id?: unknown }) => String(item.id || ""))
          .filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error:
        error instanceof Error
          ? error.message
          : "Could not reach the provider.",
    };
  }
}

function defaultReadout(
  brief: ForecastBrief,
  opinions: ForecastOpinion[],
  probability: number,
): ForecastReadout {
  const firstWithReadout = opinions.find(
    (opinion) =>
      opinion.readout &&
      Object.values(opinion.readout).some(
        (value) => Array.isArray(value) && value.length,
      ),
  );
  const readout = firstWithReadout?.readout;
  return {
    thesis:
      firstWithReadout?.reasoning ||
      `${probability}% is the current aggregate likelihood for this event before ${brief.deadline}.`,
    drivers: readout?.drivers?.length
      ? readout.drivers
      : [
          "Base rates and comparable historical cases",
          "Current evidence supplied in the forecast brief",
          "The timeline and resolution definition",
        ],
    counterSignals: readout?.counterSignals?.length
      ? readout.counterSignals
      : [
          "New evidence can invalidate the initial narrative",
          "The event may resolve differently than the stated criteria",
        ],
    updateTriggers: readout?.updateTriggers?.length
      ? readout.updateTriggers
      : [
          "A material change in the event’s leading indicators",
          "New evidence relevant to the resolution criteria",
        ],
    assumptions: readout?.assumptions?.length
      ? readout.assumptions
      : [
          brief.resolutionCriteria?.trim() ||
            "The event resolves according to the stated deadline and question wording",
        ],
  };
}

export async function runForecast(
  brief: ForecastBrief,
  providers: ProviderConfig[],
  demoMode: boolean,
  options: {
    mode?: ForecastMode;
    providerId?: ProviderId;
    apiBase?: string;
  } = {},
): Promise<ForecastResult> {
  const mode = options.mode || "ensemble";
  if (!demoMode && mode === "local-moa") {
    const lmStudio = providers.find((provider) => provider.id === "lmstudio");
    const response = await fetch(
      `${options.apiBase || import.meta.env.VITE_SIGNAL_API_URL || "http://127.0.0.1:8787"}/api/forecast`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          event: brief.question,
          deadline: brief.deadline,
          context: [
            brief.resolutionCriteria &&
              `Resolution criteria:\n${brief.resolutionCriteria}`,
            brief.context && `Context:\n${brief.context}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          provider: lmStudio,
          search: true,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        (await response.json().catch(() => ({}))).error ||
          "Local MoA API unavailable. Start npm run dev:api.",
      );
    const remote = await response.json();
    if (remote.opinions?.[0]?.status === "error") {
      const message = String(
        remote.summary ||
          "LM Studio local MoA could not complete the forecast.",
      );
      throw new Error(
        message.includes("LM_API_TOKEN") || message.includes("(401)")
          ? "LM Studio local MoA needs its API token. Enter it in Providers → LM Studio API token, auto-connect, then retry."
          : message,
      );
    }
    const opinion: ForecastOpinion = {
      provider: "lmstudio",
      probability: remote.probability,
      confidence: remote.confidence || "Medium",
      reasoning: remote.summary || "Local MoA forecast returned.",
      status: remote.opinions?.[0]?.status || "live",
    };
    return {
      probability: remote.probability,
      confidence: remote.confidence || "Medium",
      confidenceRange: [
        Math.max(0, remote.probability - 16),
        Math.min(100, remote.probability + 16),
      ],
      summary: remote.summary || "Local MoA forecast returned.",
      timeline: `Resolution by ${brief.deadline}`,
      bestCase: "The evidence supporting the forecast continues to accumulate.",
      worstCase: "A disconfirming signal invalidates the current assumptions.",
      indicators: [
        "Planner synthesis",
        "Skeptic challenge",
        "Aggregator judgment",
      ],
      reasoning: remote.summary || "",
      opinions: [opinion],
      readout: defaultReadout(brief, [opinion], remote.probability),
    };
  }

  const selected =
    mode === "single"
      ? providers.filter(
          (provider) => provider.id === (options.providerId || "lmstudio"),
        )
      : providers.filter((provider) => provider.connected);
  const opinions = demoMode
    ? mode === "single"
      ? demoOpinions.filter(
          (opinion) => opinion.provider === (options.providerId || "lmstudio"),
        )
      : demoOpinions
    : await Promise.all(
        selected.map(async (provider) => {
          try {
            return provider.authMode === "cli-oauth"
              ? await askCliProvider(
                  provider,
                  brief,
                  options.apiBase ||
                    import.meta.env.VITE_SIGNAL_API_URL ||
                    "http://127.0.0.1:8787",
                )
              : await askProvider(provider, brief);
          } catch (error) {
            return {
              provider: provider.id,
              probability: 50,
              confidence: "Unavailable",
              reasoning: "Provider did not return a forecast.",
              status: "error" as const,
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown provider error",
            };
          }
        }),
      );
  if (!opinions.length && !demoMode)
    throw new Error(
      "No providers are connected. Connect a provider or enable demo fallback.",
    );
  const usable = opinions.length ? opinions : demoOpinions;
  const probability = Math.round(
    usable.reduce((sum, opinion) => sum + opinion.probability, 0) /
      usable.length,
  );
  const spread =
    Math.max(...usable.map((opinion) => opinion.probability)) -
    Math.min(...usable.map((opinion) => opinion.probability));
  const confidence = spread <= 10 ? "High" : spread <= 22 ? "Medium" : "Low";
  const readout = defaultReadout(brief, usable, probability);
  return {
    probability,
    confidence,
    confidenceRange: [
      Math.max(
        0,
        probability -
          (confidence === "High" ? 10 : confidence === "Medium" ? 16 : 24),
      ),
      Math.min(
        100,
        probability +
          (confidence === "High" ? 10 : confidence === "Medium" ? 16 : 24),
      ),
    ],
    summary: `${probability}% aggregate likelihood before ${brief.deadline}. The council is ${confidence.toLowerCase()} confidence because provider estimates span ${Math.min(...usable.map((opinion) => opinion.probability))}–${Math.max(...usable.map((opinion) => opinion.probability))}%.`,
    timeline: `Resolution by ${brief.deadline}`,
    bestCase:
      readout.drivers[0] ||
      "The evidence supporting the forecast continues to accumulate.",
    worstCase:
      readout.counterSignals[0] ||
      "A disconfirming signal invalidates the current assumptions.",
    indicators: readout.drivers,
    reasoning: readout.thesis,
    opinions: usable,
    readout,
  };
}
