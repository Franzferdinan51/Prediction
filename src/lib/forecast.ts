export type ProviderId = "lmstudio" | "minimax" | "grok" | "openai";
export type ForecastMode = "ensemble" | "single" | "local-moa";
export type ForecastQuestionType =
  "binary" | "timing" | "numeric" | "categorical";

export type ForecastBrief = {
  question: string;
  deadline: string;
  questionType?: ForecastQuestionType;
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

export type SearchConfig = {
  provider: "searxng" | "tavily" | "brave";
  searxngUrl: string;
  tavilyApiKey: string;
  braveApiKey: string;
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
  answer?: string;
  reasoning: string;
  status: "live" | "demo" | "error";
  error?: string;
  readout?: Partial<ForecastReadout>;
};

export type ForecastResult = {
  probability: number;
  confidence: string;
  questionType: ForecastQuestionType;
  answer: string;
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

export type ForecastProgress = {
  level: "info" | "success" | "error";
  message: string;
  provider?: ProviderId;
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
    // Grok Build OAuth exposes its own model catalogue; grok-4.5 is the
    // current stable default reported by the local CLI.
    model: "grok-4.5",
    apiKey: "",
    connected: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "codex-default",
    apiKey: "",
    connected: false,
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
  const questionType = brief.questionType || "binary";
  const answerInstruction =
    questionType === "timing"
      ? "Give the most likely month, quarter, or date window in <forecast_answer>."
      : questionType === "numeric"
        ? "Give the most likely numeric range with units in <forecast_answer>."
        : questionType === "categorical"
          ? "Give the most likely outcome or scenario in <forecast_answer>."
          : "Give Yes or No in <forecast_answer>.";
  return [
    "You are a calibrated superforecaster. Analyze the event precisely and avoid pretending uncertain evidence is certain.",
    `Question:\n${brief.question.trim()}`,
    `Question type: ${questionType}`,
    `Resolution deadline: ${brief.deadline}`,
    brief.resolutionCriteria?.trim()
      ? `Resolution criteria:\n${brief.resolutionCriteria.trim()}`
      : "",
    brief.context?.trim()
      ? `Context, constraints, and known evidence:\n${brief.context.trim()}`
      : "",
    `Return XML only. ${answerInstruction} Use <probability>0-100</probability> for confidence that the central answer is correct, <confidence>High|Medium|Low</confidence>, <reasoning>a nuanced 3-6 sentence readout</reasoning>, <drivers>semicolon-separated key drivers</drivers>, <counter_signals>semicolon-separated disconfirming signals</counter_signals>, <update_triggers>semicolon-separated facts that would change the estimate</update_triggers>, and <assumptions>semicolon-separated assumptions</assumptions>.`,
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
    answer: extractTag(text, "forecast_answer") || extractTag(text, "answer"),
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
  const text = (await response.json()).choices?.[0]?.message?.content || "";
  if (!String(text).trim())
    throw new Error(`${provider.name} returned an empty forecast response.`);
  return parseOpinion(provider.id, text);
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
    body: JSON.stringify({
      provider: provider.id,
      model: provider.model,
      brief,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `${provider.name} CLI forecast failed.`);
  if (!String(data.output || "").trim())
    throw new Error(
      `${provider.name} returned an empty CLI forecast response.`,
    );
  return parseOpinion(provider.id, data.output);
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
  const questionType = brief.questionType || "binary";
  const centralAnswer = aggregateAnswer(brief, opinions);
  return {
    thesis:
      firstWithReadout?.reasoning ||
      (questionType === "binary"
        ? `${probability}% is the current aggregate likelihood for this event before ${brief.deadline}.`
        : `${centralAnswer} is the central forecast, with ${probability}% confidence before ${brief.deadline}.`),
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

function aggregateAnswer(brief: ForecastBrief, opinions: ForecastOpinion[]) {
  const answers = opinions
    .map((opinion) => opinion.answer?.trim())
    .filter((answer): answer is string => Boolean(answer));
  if (answers.length) {
    const frequency = new Map<string, number>();
    answers.forEach((answer) =>
      frequency.set(answer, (frequency.get(answer) || 0) + 1),
    );
    return [...frequency.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return (brief.questionType || "binary") === "binary"
    ? "No central answer returned"
    : "No central window returned";
}

function demoAnswer(questionType: ForecastQuestionType) {
  if (questionType === "timing") return "July–December 2027 (demo window)";
  if (questionType === "numeric") return "45–55 (demo range)";
  if (questionType === "categorical") return "Base-case scenario (demo)";
  return "Yes";
}

export async function runForecast(
  brief: ForecastBrief,
  providers: ProviderConfig[],
  demoMode: boolean,
  options: {
    mode?: ForecastMode;
    providerId?: ProviderId;
    apiBase?: string;
    searchConfig?: SearchConfig;
    onProgress?: (progress: ForecastProgress) => void;
  } = {},
): Promise<ForecastResult> {
  const mode = options.mode || "ensemble";
  const progress = options.onProgress || (() => undefined);
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
          questionType: brief.questionType || "binary",
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
          searchConfig: options.searchConfig,
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
      answer: remote.answer || remote.opinions?.[0]?.answer,
      reasoning: remote.summary || "Local MoA forecast returned.",
      status: remote.opinions?.[0]?.status || "live",
    };
    return {
      probability: remote.probability,
      confidence: remote.confidence || "Medium",
      questionType: brief.questionType || "binary",
      answer:
        remote.answer ||
        remote.opinions?.[0]?.answer ||
        "Local MoA answer pending",
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
  const questionType = brief.questionType || "binary";
  const opinions = demoMode
    ? mode === "single"
      ? demoOpinions
          .filter(
            (opinion) =>
              opinion.provider === (options.providerId || "lmstudio"),
          )
          .map((opinion) => ({ ...opinion, answer: demoAnswer(questionType) }))
      : demoOpinions.map((opinion) => ({
          ...opinion,
          answer: demoAnswer(questionType),
        }))
    : await Promise.all(
        selected.map(async (provider) => {
          progress({
            level: "info",
            provider: provider.id,
            message: `Sending full brief to ${provider.name} (${provider.model})…`,
          });
          try {
            const opinion =
              provider.authMode === "cli-oauth"
                ? await askCliProvider(
                    provider,
                    brief,
                    options.apiBase ||
                      import.meta.env.VITE_SIGNAL_API_URL ||
                      "http://127.0.0.1:8787",
                  )
                : await askProvider(provider, brief);
            progress({
              level: "success",
              provider: provider.id,
              message: `${provider.name} returned ${opinion.probability}%${opinion.answer ? ` · ${opinion.answer}` : ""}.`,
            });
            return opinion;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown provider error";
            progress({ level: "error", provider: provider.id, message });
            return {
              provider: provider.id,
              probability: 50,
              confidence: "Unavailable",
              reasoning: "Provider did not return a forecast.",
              status: "error" as const,
              error: message,
            };
          }
        }),
      );
  if (!opinions.length && !demoMode)
    throw new Error(
      "No providers are connected. Connect a provider or enable demo fallback.",
    );
  const successfulOpinions = opinions.filter(
    (opinion) => opinion.status !== "error",
  );
  if (!demoMode && !successfulOpinions.length)
    throw new Error(
      "All selected providers failed to return a readable forecast. See the Run log for each provider error.",
    );
  const usable = successfulOpinions.length ? successfulOpinions : demoOpinions;
  const probability = Math.round(
    usable.reduce((sum, opinion) => sum + opinion.probability, 0) /
      usable.length,
  );
  const spread =
    Math.max(...usable.map((opinion) => opinion.probability)) -
    Math.min(...usable.map((opinion) => opinion.probability));
  const confidence = spread <= 10 ? "High" : spread <= 22 ? "Medium" : "Low";
  const readout = defaultReadout(brief, usable, probability);
  const answer = aggregateAnswer(brief, usable);
  return {
    probability,
    confidence,
    questionType,
    answer,
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
    summary:
      questionType === "binary"
        ? `${probability}% aggregate likelihood before ${brief.deadline}. The council is ${confidence.toLowerCase()} confidence because provider estimates span ${Math.min(...usable.map((opinion) => opinion.probability))}–${Math.max(...usable.map((opinion) => opinion.probability))}%.`
        : `${probability}% confidence in the central forecast: ${answer}. The council is ${confidence.toLowerCase()} confidence because provider estimates span ${Math.min(...usable.map((opinion) => opinion.probability))}–${Math.max(...usable.map((opinion) => opinion.probability))}%.`,
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
