import { useMemo, useState, type CSSProperties } from "react";
import {
  defaultProviders,
  type ForecastBrief,
  type ForecastMode,
  type ForecastResult,
  type ProviderConfig,
  type ProviderId,
  type SearchConfig,
  probeProvider,
  runForecast,
} from "./lib/forecast";

const providerMeta: Record<ProviderId, { mark: string; tone: string }> = {
  lmstudio: { mark: "▤", tone: "violet" },
  minimax: { mark: "∿", tone: "rose" },
  grok: { mark: "↗", tone: "black" },
  openai: { mark: "◉", tone: "gray" },
};
const initialBrief: ForecastBrief = {
  question: "Will the Federal Reserve cut rates before December 2026?",
  deadline: "Dec 31, 2026",
  resolutionCriteria:
    "Resolve Yes if the Federal Reserve announces and implements at least one reduction to its target federal funds rate before the deadline.",
  context:
    "Consider inflation, labor conditions, growth, financial conditions, and the risk of an inflation re-acceleration.",
};
const API_BASE = import.meta.env.VITE_SIGNAL_API_URL || "http://127.0.0.1:8787";
type CliOAuthProvider = "minimax" | "grok" | "openai";
type SearchProviderId = "searxng" | "tavily" | "brave";
type HistoryItem = {
  id: string;
  brief: ForecastBrief;
  result: ForecastResult;
  createdAt: string;
  pinned: boolean;
};

function storedProviders(): ProviderConfig[] {
  try {
    return (
      JSON.parse(localStorage.getItem("signal-providers") || "null") ||
      defaultProviders
    );
  } catch {
    return defaultProviders;
  }
}

function storedHistory(): HistoryItem[] {
  try {
    return (
      JSON.parse(localStorage.getItem("signal-history") || "[]") as Array<
        HistoryItem & { event?: string; deadline?: string }
      >
    ).map((item) => ({
      ...item,
      brief: item.brief || {
        question: item.event || initialBrief.question,
        deadline: item.deadline || initialBrief.deadline,
      },
    }));
  } catch {
    return [];
  }
}

function storedSearchConfig(): SearchConfig {
  try {
    return {
      provider: "searxng",
      searxngUrl: "http://127.0.0.1:8080",
      tavilyApiKey: "",
      braveApiKey: "",
      ...(JSON.parse(localStorage.getItem("signal-search-config") || "{}") ||
        {}),
    };
  } catch {
    return {
      provider: "searxng",
      searxngUrl: "http://127.0.0.1:8080",
      tavilyApiKey: "",
      braveApiKey: "",
    };
  }
}

function App() {
  const [brief, setBrief] = useState<ForecastBrief>(initialBrief);
  const [providers, setProviders] = useState<ProviderConfig[]>(storedProviders);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [running, setRunning] = useState(false);
  const [demoMode, setDemoMode] = useState(true);
  const [activeView, setActiveView] = useState("Forecasts");
  const [forecastMode, setForecastMode] = useState<ForecastMode>("ensemble");
  const [singleProvider, setSingleProvider] = useState<ProviderId>("lmstudio");
  const [history, setHistory] = useState<HistoryItem[]>(storedHistory);
  const [notice, setNotice] = useState(
    "Demo mode is on — write a detailed brief or connect a provider for live forecasts.",
  );
  const [providerIssues, setProviderIssues] = useState<Record<string, string>>(
    {},
  );
  const [discoveredModels, setDiscoveredModels] = useState<
    Record<string, string[]>
  >({});
  const [searchConfig, setSearchConfig] =
    useState<SearchConfig>(storedSearchConfig);

  const connectedCount = providers.filter(
    (provider) => provider.connected,
  ).length;
  const displayed = result || demoResult();
  const rangeStyle = useMemo(
    () =>
      ({
        left: `${displayed.probability}%`,
        "--probability-label": `'${displayed.probability}%'`,
      }) as CSSProperties,
    [displayed.probability],
  );
  const updateBrief = (field: keyof ForecastBrief, value: string) =>
    setBrief((current) => ({ ...current, [field]: value }));
  const updateProvider = (id: ProviderId, patch: Partial<ProviderConfig>) =>
    setProviders((current) =>
      current.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    );
  const saveProviders = () => {
    localStorage.setItem("signal-providers", JSON.stringify(providers));
    setNotice("Provider settings saved locally in this browser.");
  };
  const saveSearchConfig = () => {
    localStorage.setItem("signal-search-config", JSON.stringify(searchConfig));
    setNotice("Search provider settings saved locally in this browser.");
  };
  const recordForecast = (forecast: ForecastResult) =>
    setHistory((current) => {
      const next = [
        {
          id: `f_${Date.now()}`,
          brief: { ...brief },
          result: forecast,
          createdAt: new Date().toISOString(),
          pinned: false,
        },
        ...current,
      ].slice(0, 50);
      localStorage.setItem("signal-history", JSON.stringify(next));
      return next;
    });
  const pinCurrent = () =>
    setHistory((current) => {
      const target = current.find((item) => item.result === result);
      if (!target) return current;
      const next = current.map((item) =>
        item.id === target.id ? { ...item, pinned: !item.pinned } : item,
      );
      localStorage.setItem("signal-history", JSON.stringify(next));
      return next;
    });

  const connect = async (provider: ProviderConfig) => {
    setNotice(`Checking ${provider.name}…`);
    const probe = await probeProvider(provider);
    if (!probe.ok) {
      updateProvider(provider.id, { connected: false });
      setProviderIssues((current) => ({
        ...current,
        [provider.id]: probe.error || "Connection failed.",
      }));
      setNotice(probe.error || `Could not connect to ${provider.name}.`);
      return;
    }
    const nextModel =
      probe.models.includes(provider.model) || !probe.models.length
        ? provider.model
        : probe.models[0];
    updateProvider(provider.id, { connected: true, model: nextModel });
    setDiscoveredModels((current) => ({
      ...current,
      [provider.id]: probe.models,
    }));
    setProviderIssues((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    setNotice(
      `${provider.name} connected${probe.models.length ? ` — ${probe.models.length} model${probe.models.length === 1 ? "" : "s"} discovered.` : "."}`,
    );
  };

  const run = async () => {
    if (brief.question.trim().length < 12) {
      setNotice(
        "Write a specific, resolvable event question before running a forecast.",
      );
      return;
    }
    setRunning(true);
    setNotice(
      demoMode
        ? "Building a detailed demo readout…"
        : forecastMode === "local-moa"
          ? "Running Planner → Skeptic → Aggregator in LM Studio…"
          : forecastMode === "single"
            ? `Querying ${providers.find((provider) => provider.id === singleProvider)?.name}…`
            : `Querying ${connectedCount} connected provider${connectedCount === 1 ? "" : "s"}…`,
    );
    try {
      const forecast = await runForecast(brief, providers, demoMode, {
        mode: forecastMode,
        providerId: singleProvider,
        apiBase: API_BASE,
        searchConfig,
      });
      setResult(forecast);
      recordForecast(forecast);
      setNotice(
        "Forecast updated just now. Read the thesis, counter-signals, and update triggers below.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to run forecast.",
      );
    } finally {
      setRunning(false);
    }
  };
  const cliProviderLabel = (provider: CliOAuthProvider) =>
    provider === "minimax"
      ? "MiniMax"
      : provider === "grok"
        ? "Grok Build"
        : "OpenAI / Codex";
  const loadCliModels = async (provider: CliOAuthProvider) => {
    const label = cliProviderLabel(provider);
    try {
      const response = await fetch(
        `${API_BASE}/api/cli-auth/${provider}/models`,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Could not load ${label} models.`);
      const models = Array.isArray(data.models)
        ? data.models.filter(
            (model: unknown): model is string => typeof model === "string",
          )
        : [];
      setDiscoveredModels((current) => ({ ...current, [provider]: models }));
      setNotice(
        models.length
          ? `${label} model list loaded — choose a model from its dropdown.`
          : `${label} did not report a model list. You can still use its configured default.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : `Could not load ${label} models.`,
      );
    }
  };
  const connectCliOAuth = async (provider: CliOAuthProvider) => {
    const label = cliProviderLabel(provider);
    try {
      const response = await fetch(
        `${API_BASE}/api/cli-auth/${provider}/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flow: "browser" }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Could not start ${label} OAuth.`);
      updateProvider(provider, { authMode: "cli-oauth", connected: false });
      setNotice(
        `${label} OAuth started in your browser. Complete login there, then select Check CLI session.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : `Could not start ${label} OAuth.`,
      );
    }
  };
  const checkCliOAuth = async (provider: CliOAuthProvider) => {
    const label = cliProviderLabel(provider);
    try {
      const response = await fetch(
        `${API_BASE}/api/cli-auth/${provider}/status`,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Could not check ${label} OAuth.`);
      updateProvider(provider, {
        authMode: "cli-oauth",
        connected: Boolean(data.authenticated),
      });
      if (data.authenticated) void loadCliModels(provider);
      setNotice(
        data.authenticated
          ? `${label} CLI session is ready for forecasts.`
          : `${label} OAuth is not complete yet. ${data.session?.output || data.detail || "Finish the local CLI login, then check again."}`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : `Could not check ${label} OAuth.`,
      );
    }
  };

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand">SIGNAL</div>
        <nav>
          {["Forecasts", "History", "Providers", "Agents", "Settings"].map(
            (item) => (
              <button
                className={activeView === item ? "nav-item active" : "nav-item"}
                onClick={() => setActiveView(item)}
                key={item}
              >
                <span className="nav-glyph">
                  {item === "Forecasts"
                    ? "⌁"
                    : item === "History"
                      ? "◷"
                      : item === "Providers"
                        ? "◇"
                        : item === "Agents"
                          ? "↗"
                          : "⚙"}
                </span>
                {item}
              </button>
            ),
          )}
        </nav>
      </aside>
      <main className="content">
        <header>
          <div>
            <h1>Signal / Forecast</h1>
            <p>Calibrated forecasts for nuanced future events.</p>
          </div>
          <div className="header-status">
            <span className="status-dot" />
            {connectedCount} live ·{" "}
            {demoMode ? "demo fallback on" : "live mode"}
          </div>
        </header>
        {activeView === "Settings" ? (
          <SettingsView
            providers={providers}
            forecastMode={forecastMode}
            setForecastMode={setForecastMode}
            singleProvider={singleProvider}
            setSingleProvider={setSingleProvider}
            demoMode={demoMode}
            setDemoMode={setDemoMode}
            apiBase={API_BASE}
            notice={notice}
            searchConfig={searchConfig}
            setSearchConfig={setSearchConfig}
            saveSearchConfig={saveSearchConfig}
            setNotice={setNotice}
          />
        ) : activeView === "Providers" ? (
          <ProviderSettings
            providers={providers}
            updateProvider={updateProvider}
            connect={connect}
            connectCliOAuth={connectCliOAuth}
            checkCliOAuth={checkCliOAuth}
            loadCliModels={loadCliModels}
            demoMode={demoMode}
            setDemoMode={setDemoMode}
            notice={notice}
            providerIssues={providerIssues}
            discoveredModels={discoveredModels}
            saveProviders={saveProviders}
          />
        ) : activeView === "Agents" ? (
          <AgentSettings
            brief={brief}
            notice={notice}
            setNotice={setNotice}
            searchConfig={searchConfig}
          />
        ) : activeView === "History" ? (
          <HistoryView
            history={history}
            load={(item) => {
              setBrief(item.brief);
              setResult(item.result);
              setActiveView("Forecasts");
            }}
            setHistory={setHistory}
          />
        ) : (
          <>
            <section className="workspace-grid">
              <div className="composer panel">
                <div className="section-label">
                  Forecast brief <span>{brief.question.length} / 6000</span>
                </div>
                <textarea
                  aria-label="Forecast question"
                  maxLength={6000}
                  value={brief.question}
                  onChange={(event) =>
                    updateBrief("question", event.target.value)
                  }
                  placeholder="State a precise, resolvable future event…"
                />
                <div className="brief-grid">
                  <label>
                    <span className="section-label">Resolution deadline</span>
                    <input
                      aria-label="Resolution deadline"
                      maxLength={120}
                      value={brief.deadline}
                      onChange={(event) =>
                        updateBrief("deadline", event.target.value)
                      }
                      placeholder="e.g. December 31, 2026"
                    />
                  </label>
                  <label>
                    <span className="section-label">
                      Resolution criteria{" "}
                      <span>
                        {(brief.resolutionCriteria || "").length} / 2000
                      </span>
                    </span>
                    <textarea
                      aria-label="Resolution criteria"
                      maxLength={2000}
                      value={brief.resolutionCriteria || ""}
                      onChange={(event) =>
                        updateBrief("resolutionCriteria", event.target.value)
                      }
                      placeholder="What specifically counts as Yes or No?"
                    />
                  </label>
                </div>
                <label className="context-field">
                  <span className="section-label">
                    Context, constraints, and known evidence{" "}
                    <span>{(brief.context || "").length} / 4000</span>
                  </span>
                  <textarea
                    aria-label="Forecast context"
                    maxLength={4000}
                    value={brief.context || ""}
                    onChange={(event) =>
                      updateBrief("context", event.target.value)
                    }
                    placeholder="Add assumptions, relevant facts, scenarios, sources, definitions, or what you want the forecaster to weigh."
                  />
                </label>
                <div className="composer-metrics">
                  <div className="metric">
                    <span className="section-label">Strategy</span>
                    <select
                      aria-label="Forecast strategy"
                      value={forecastMode}
                      onChange={(event) =>
                        setForecastMode(event.target.value as ForecastMode)
                      }
                    >
                      <option value="ensemble">
                        Ensemble · connected providers
                      </option>
                      <option value="single">Single provider</option>
                      <option value="local-moa">LM Studio · local MoA</option>
                    </select>
                  </div>
                  {forecastMode === "single" && (
                    <div className="metric">
                      <span className="section-label">Provider</span>
                      <select
                        aria-label="Single provider"
                        value={singleProvider}
                        onChange={(event) =>
                          setSingleProvider(event.target.value as ProviderId)
                        }
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="metric">
                    <span className="section-label">Confidence (80% CI)</span>
                    <b>
                      {displayed.confidenceRange[0]}% –{" "}
                      {displayed.confidenceRange[1]}%
                    </b>
                  </div>
                </div>
                <div className="composer-actions">
                  <span className="input-help">
                    Long-form questions, criteria, and evidence are included in
                    every live provider prompt.
                  </span>
                  <button
                    className="primary"
                    onClick={run}
                    disabled={running || !brief.question.trim()}
                  >
                    {running ? "Running…" : "Run forecast"} <span>▶</span>
                  </button>
                </div>
              </div>
              <ProviderRail
                providers={providers}
                onManage={() => setActiveView("Providers")}
              />
            </section>
            <ResultView
              result={displayed}
              providers={providers}
              notice={notice}
              rangeStyle={rangeStyle}
              pinCurrent={pinCurrent}
              hasResult={Boolean(result)}
            />
          </>
        )}
      </main>
    </div>
  );
}

function ResultView({
  result,
  providers,
  notice,
  rangeStyle,
  pinCurrent,
  hasResult,
}: {
  result: ForecastResult;
  providers: ProviderConfig[];
  notice: string;
  rangeStyle: CSSProperties;
  pinCurrent: () => void;
  hasResult: boolean;
}) {
  return (
    <section className="result panel">
      <div className="result-head">
        <span className="section-label">
          Forecast readout <em>{result.timeline}</em>
        </span>
        <span className="updated">
          {notice}{" "}
          <button
            className="pin-button"
            onClick={pinCurrent}
            disabled={!hasResult}
          >
            ⌖ Pin / compare
          </button>
        </span>
      </div>
      <div className="result-top">
        <div className="probability-block">
          <span className="section-label">Aggregate probability</span>
          <div className="big-probability">{result.probability}%</div>
          <div className="probability-bar">
            <i style={rangeStyle} />
          </div>
          <div className="bar-labels">
            <span>0%</span>
            <span>25</span>
            <span>50</span>
            <span>75</span>
            <span>100</span>
          </div>
          <p className="probability-summary">{result.summary}</p>
        </div>
        <div className="opinions">
          <span className="section-label">Provider opinions</span>
          {result.opinions.map((opinion, index) => (
            <div className="opinion" key={opinion.provider}>
              <span>
                {providers.find((provider) => provider.id === opinion.provider)
                  ?.name || opinion.provider}
              </span>
              <div className="opinion-line">
                <i style={{ left: `${opinion.probability}%` }} />
              </div>
              <b
                className={
                  index % 3 === 0 ? "blue" : index % 3 === 1 ? "lime" : "amber"
                }
              >
                {opinion.probability}%
              </b>
            </div>
          ))}
        </div>
      </div>
      <div className="readout-lead">
        <span className="section-label">Thesis</span>
        <p>{result.readout.thesis}</p>
      </div>
      <div className="readout-grid">
        <ReadoutList
          title="Why this could happen"
          items={result.readout.drivers}
        />
        <ReadoutList
          title="What could prove it wrong"
          items={result.readout.counterSignals}
        />
        <ReadoutList
          title="What would change the estimate"
          items={result.readout.updateTriggers}
        />
        <ReadoutList
          title="Key assumptions"
          items={result.readout.assumptions}
        />
      </div>
    </section>
  );
}

function ReadoutList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="readout-card">
      <span className="section-label">{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ProviderRail({
  providers,
  onManage,
}: {
  providers: ProviderConfig[];
  onManage: () => void;
}) {
  return (
    <aside className="provider-rail panel">
      <div className="section-label">Providers</div>
      {providers.map((provider) => (
        <div className="provider-card" key={provider.id}>
          <div className={`provider-mark ${providerMeta[provider.id].tone}`}>
            {providerMeta[provider.id].mark}
          </div>
          <div>
            <strong>{provider.name}</strong>
            <small>
              <i className={provider.connected ? "connected" : ""} />
              {provider.connected ? provider.model : "Not connected"}
            </small>
          </div>
        </div>
      ))}
      <button className="manage" onClick={onManage}>
        ⚙ &nbsp; Manage providers
      </button>
      <div className="about">
        <span className="section-label">How to use this</span>
        <hr />
        <p>1. Write a resolvable question.</p>
        <p>2. Define what counts as Yes.</p>
        <p>3. Add the context the models should weigh.</p>
        <p>4. Review counter-signals before acting.</p>
      </div>
    </aside>
  );
}

function ProviderSettings({
  providers,
  updateProvider,
  connect,
  connectCliOAuth,
  checkCliOAuth,
  loadCliModels,
  demoMode,
  setDemoMode,
  notice,
  providerIssues,
  discoveredModels,
  saveProviders,
}: {
  providers: ProviderConfig[];
  updateProvider: (id: ProviderId, patch: Partial<ProviderConfig>) => void;
  connect: (provider: ProviderConfig) => void;
  connectCliOAuth: (provider: CliOAuthProvider) => void;
  checkCliOAuth: (provider: CliOAuthProvider) => void;
  loadCliModels: (provider: CliOAuthProvider) => void;
  demoMode: boolean;
  setDemoMode: (value: boolean) => void;
  notice: string;
  providerIssues: Record<string, string>;
  discoveredModels: Record<string, string[]>;
  saveProviders: () => void;
}) {
  return (
    <section className="settings-view">
      <div className="settings-intro">
        <span className="section-label">Provider connections</span>
        <h2>Connect the models you actually use.</h2>
        <p>
          LM Studio works with or without API-token protection. If your server
          returns 401, paste its token below; successful auto-connect discovers
          models and selects the first available model.
        </p>
      </div>
      <div className="lm-help">
        <strong>LM Studio quick fix</strong>
        <span>
          Use the OpenAI-compatible server URL, then select <b>Auto-connect</b>.
          If API-token protection is enabled in LM Studio, paste its token into
          the LM Studio API token field first. No token is stored outside this
          browser.
        </span>
      </div>
      <div className="settings-list">
        {providers.map((provider) => (
          <div className="settings-row" key={provider.id}>
            <div className={`provider-mark ${providerMeta[provider.id].tone}`}>
              {providerMeta[provider.id].mark}
            </div>
            <div className="settings-fields">
              <div className="settings-name">
                <strong>{provider.name}</strong>
                <span
                  className={
                    provider.connected ? "connection live" : "connection"
                  }
                >
                  {provider.connected ? "Connected" : "Not connected"}
                </span>
              </div>
              <input
                aria-label={`${provider.name} endpoint`}
                value={provider.endpoint}
                onChange={(event) =>
                  updateProvider(provider.id, { endpoint: event.target.value })
                }
                placeholder="OpenAI-compatible endpoint"
              />
              <div className="field-pair">
                <select
                  aria-label={`${provider.name} model`}
                  value={provider.model}
                  onChange={(event) =>
                    updateProvider(provider.id, { model: event.target.value })
                  }
                >
                  {[provider.model, ...(discoveredModels[provider.id] || [])]
                    .filter(
                      (model, index, values) =>
                        model && values.indexOf(model) === index,
                    )
                    .map((model) => (
                      <option key={model} value={model}>
                        {model === "codex-default"
                          ? "Codex CLI default"
                          : model}
                      </option>
                    ))}
                </select>
                <input
                  aria-label={`${provider.name} API key`}
                  type="password"
                  value={provider.apiKey}
                  onChange={(event) =>
                    updateProvider(provider.id, { apiKey: event.target.value })
                  }
                  placeholder={
                    provider.id === "lmstudio"
                      ? "LM Studio API token (only if enabled)"
                      : "API key"
                  }
                />
              </div>
              {(provider.id === "minimax" ||
                provider.id === "grok" ||
                provider.id === "openai") && (
                <p className="oauth-note">
                  {provider.authMode === "cli-oauth"
                    ? "Using the authenticated local CLI session; no OAuth token is copied into this app. Use the model dropdown after checking the session."
                    : provider.id === "openai"
                      ? "Use an OpenAI API key above, or connect your local Codex CLI through ChatGPT OAuth."
                      : "Use an API key above, or connect through the provider's local OAuth CLI."}
                </p>
              )}
              {provider.id === "openai" &&
                provider.authMode === "cli-oauth" && (
                  <p className="oauth-note">
                    The OAuth dropdown includes the full supported text and
                    reasoning catalog. Codex verifies plan-specific access when
                    the forecast runs; use an API key and <b>Test API key</b>
                    for the exact account-enabled API list.
                  </p>
                )}
              {providerIssues[provider.id] && (
                <p className="connection-error" role="alert">
                  {providerIssues[provider.id]}
                </p>
              )}
            </div>
            <div className="provider-actions">
              <button className="secondary" onClick={() => connect(provider)}>
                {provider.id === "lmstudio" ? "Auto-connect" : "Test API key"}
              </button>
              {(provider.id === "minimax" ||
                provider.id === "grok" ||
                provider.id === "openai") && (
                <>
                  <button
                    className="oauth"
                    onClick={() =>
                      connectCliOAuth(provider.id as CliOAuthProvider)
                    }
                  >
                    {provider.id === "minimax"
                      ? "MiniMax OAuth"
                      : provider.id === "grok"
                        ? "Grok OAuth"
                        : "ChatGPT OAuth"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      checkCliOAuth(provider.id as CliOAuthProvider)
                    }
                  >
                    Check CLI session
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      loadCliModels(provider.id as CliOAuthProvider)
                    }
                  >
                    Load models
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        <div className="settings-footer">
          <label className="toggle">
            <input
              type="checkbox"
              checked={demoMode}
              onChange={(event) => setDemoMode(event.target.checked)}
            />
            <span />
            Demo fallback
          </label>
          <span>{notice}</span>
          <button className="primary" onClick={saveProviders}>
            Save connections
          </button>
        </div>
      </div>
    </section>
  );
}

function SettingsView({
  providers,
  forecastMode,
  setForecastMode,
  singleProvider,
  setSingleProvider,
  demoMode,
  setDemoMode,
  apiBase,
  notice,
  searchConfig,
  setSearchConfig,
  saveSearchConfig,
  setNotice,
}: {
  providers: ProviderConfig[];
  forecastMode: ForecastMode;
  setForecastMode: (value: ForecastMode) => void;
  singleProvider: ProviderId;
  setSingleProvider: (value: ProviderId) => void;
  demoMode: boolean;
  setDemoMode: (value: boolean) => void;
  apiBase: string;
  notice: string;
  searchConfig: SearchConfig;
  setSearchConfig: (value: SearchConfig) => void;
  saveSearchConfig: () => void;
  setNotice: (value: string) => void;
}) {
  const updateSearchConfig = (patch: Partial<SearchConfig>) =>
    setSearchConfig({ ...searchConfig, ...patch });
  const testSearchProvider = async (provider: SearchProviderId) => {
    setNotice(`Testing ${provider === "searxng" ? "SearXNG" : provider}…`);
    try {
      const response = await fetch(`${apiBase}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          query: "forecasting calibration",
          maxResults: 1,
          searchConfig,
        }),
      });
      const data = await response.json();
      const error = data.errors?.[0]?.error;
      setNotice(
        response.ok && !error
          ? `${provider === "searxng" ? "SearXNG" : provider} connected — ${data.results?.length || 0} result${data.results?.length === 1 ? "" : "s"} returned.`
          : error || data.error || `${provider} connection failed.`,
      );
    } catch {
      setNotice("Search connector API is unavailable. Start npm run dev:api.");
    }
  };
  return (
    <section className="settings-view">
      <div className="settings-intro">
        <span className="section-label">Application settings</span>
        <h2>Set how forecasts run by default.</h2>
        <p>
          These controls affect the next forecast. Provider credentials, OAuth
          sessions, and model choices remain in Providers.
        </p>
      </div>
      <div className="settings-list app-settings-list">
        <label className="app-setting">
          <span>
            <strong>Forecast strategy</strong>
            <small>Choose the default execution path.</small>
          </span>
          <select
            aria-label="Default forecast strategy"
            value={forecastMode}
            onChange={(event) =>
              setForecastMode(event.target.value as ForecastMode)
            }
          >
            <option value="ensemble">Ensemble of connected providers</option>
            <option value="single">One selected provider</option>
            <option value="local-moa">LM Studio local MoA</option>
          </select>
        </label>
        <label className="app-setting">
          <span>
            <strong>Single-provider choice</strong>
            <small>Used whenever Single provider is selected.</small>
          </span>
          <select
            aria-label="Default single provider"
            value={singleProvider}
            onChange={(event) =>
              setSingleProvider(event.target.value as ProviderId)
            }
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.connected ? " · connected" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="app-setting">
          <span>
            <strong>Demo fallback</strong>
            <small>
              Use sample forecasts until you deliberately switch to live mode.
            </small>
          </span>
          <span className="toggle">
            <input
              aria-label="Demo fallback"
              type="checkbox"
              checked={demoMode}
              onChange={(event) => setDemoMode(event.target.checked)}
            />
            <span />
          </span>
        </label>
        <div className="app-setting app-setting-note">
          <span>
            <strong>Local connector API</strong>
            <small>
              {apiBase} · used for CLI OAuth, research, MoA, and agent
              connectors.
            </small>
          </span>
          <span className="connection live">Ready</span>
        </div>
      </div>
      <div className="settings-intro search-settings-intro">
        <span className="section-label">Search providers</span>
        <h2>Connect the research sources you use.</h2>
        <p>
          SearXNG is the default. Keys stay in this browser and are sent only to
          the local connector when you run a search; they are never returned by
          the API.
        </p>
      </div>
      <div className="settings-list app-settings-list search-provider-list">
        <label className="app-setting">
          <span>
            <strong>Default research provider</strong>
            <small>
              Used by the in-app agent research loop and local MoA research.
            </small>
          </span>
          <select
            aria-label="Default search provider"
            value={searchConfig.provider}
            onChange={(event) =>
              updateSearchConfig({
                provider: event.target.value as SearchProviderId,
              })
            }
          >
            <option value="searxng">SearXNG</option>
            <option value="tavily">Tavily</option>
            <option value="brave">Brave Search</option>
          </select>
        </label>
        <div className="app-setting search-provider-setting">
          <span>
            <strong>SearXNG endpoint</strong>
            <small>Self-hosted SearXNG base URL. No API key required.</small>
          </span>
          <div className="search-provider-action">
            <input
              aria-label="SearXNG endpoint"
              value={searchConfig.searxngUrl}
              onChange={(event) =>
                updateSearchConfig({ searxngUrl: event.target.value })
              }
              placeholder="http://127.0.0.1:8080"
            />
            <button
              className="secondary"
              onClick={() => testSearchProvider("searxng")}
            >
              Test SearXNG
            </button>
          </div>
        </div>
        <div className="app-setting search-provider-setting">
          <span>
            <strong>Tavily API key</strong>
            <small>Optional web-research provider.</small>
          </span>
          <div className="search-provider-action">
            <input
              aria-label="Tavily API key"
              type="password"
              value={searchConfig.tavilyApiKey}
              onChange={(event) =>
                updateSearchConfig({ tavilyApiKey: event.target.value })
              }
              placeholder="tvly-…"
            />
            <button
              className="secondary"
              onClick={() => testSearchProvider("tavily")}
            >
              Test Tavily
            </button>
          </div>
        </div>
        <div className="app-setting search-provider-setting">
          <span>
            <strong>Brave Search API key</strong>
            <small>Optional web-search provider.</small>
          </span>
          <div className="search-provider-action">
            <input
              aria-label="Brave Search API key"
              type="password"
              value={searchConfig.braveApiKey}
              onChange={(event) =>
                updateSearchConfig({ braveApiKey: event.target.value })
              }
              placeholder="BSA…"
            />
            <button
              className="secondary"
              onClick={() => testSearchProvider("brave")}
            >
              Test Brave
            </button>
          </div>
        </div>
        <div className="settings-footer">
          <span>{notice}</span>
          <button className="primary" onClick={saveSearchConfig}>
            Save search settings
          </button>
        </div>
      </div>
    </section>
  );
}

function HistoryView({
  history,
  load,
  setHistory,
}: {
  history: HistoryItem[];
  load: (item: HistoryItem) => void;
  setHistory: (value: HistoryItem[]) => void;
}) {
  const pinned = history.filter((item) => item.pinned);
  const togglePin = (id: string) => {
    const next = history.map((item) =>
      item.id === id ? { ...item, pinned: !item.pinned } : item,
    );
    localStorage.setItem("signal-history", JSON.stringify(next));
    setHistory(next);
  };
  return (
    <section className="history-view">
      <div className="settings-intro">
        <span className="section-label">Forecast archive</span>
        <h2>Keep the signal. Compare the drift.</h2>
        <p>
          Forecast briefs and readouts persist locally so you can return to the
          question, its criteria, and the evidence you used.
        </p>
      </div>
      {pinned.length >= 2 && (
        <div className="compare-panel">
          <span className="section-label">Pinned comparison</span>
          <div className="compare-grid">
            {pinned.slice(0, 2).map((item) => (
              <div key={item.id}>
                <strong>{item.result.probability}%</strong>
                <span>{item.createdAt.slice(0, 16).replace("T", " · ")}</span>
                <p>{item.brief.question}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="history-list">
        {history.length === 0 ? (
          <div className="empty-state">
            No forecasts archived yet. Run one and it will appear here.
          </div>
        ) : (
          history.map((item) => (
            <div className="history-row" key={item.id}>
              <div>
                <strong>{item.result.probability}%</strong>
                <span>{item.brief.question}</span>
                <small>
                  {item.brief.deadline} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </small>
              </div>
              <div>
                <button
                  className="secondary"
                  onClick={() => togglePin(item.id)}
                >
                  {item.pinned ? "Unpin" : "Pin"}
                </button>
                <button className="primary" onClick={() => load(item)}>
                  Load
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function AgentSettings({
  brief,
  notice,
  setNotice,
  searchConfig,
}: {
  brief: ForecastBrief;
  notice: string;
  setNotice: (value: string) => void;
  searchConfig: SearchConfig;
}) {
  const [connectorStatus, setConnectorStatus] = useState<Record<
    string,
    boolean
  > | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(
    `${brief.question} macro factors`,
  );
  const [searchProvider, setSearchProvider] = useState<SearchProviderId>(
    searchConfig.provider,
  );
  const [searchDepth, setSearchDepth] = useState("quick");
  const [searchResults, setSearchResults] = useState<
    Array<{ title: string; url: string; snippet: string; source: string }>
  >([]);
  const inspect = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/connectors`);
      const data = await response.json();
      setConnectorStatus({
        localMoa: data.localMoa?.installed,
        openclaw: data.openclaw?.installed,
        hermes: data.hermes?.installed,
      });
      setNotice("Connector status refreshed.");
    } catch {
      setNotice("Start npm run dev:api to enable local agent connectors.");
    }
  };
  const callAgent = async (agent: "openclaw" | "hermes") => {
    setBusy(agent);
    try {
      const response = await fetch(`${API_BASE}/api/agent/${agent}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Forecast brief:\nQuestion: ${brief.question}\nDeadline: ${brief.deadline}\nResolution criteria: ${brief.resolutionCriteria || "Not specified"}\nContext: ${brief.context || "Not specified"}\n\nReturn a calibrated probability, a nuanced thesis, counter-signals, and update triggers.`,
        }),
      });
      const data = await response.json();
      setNotice(
        response.ok
          ? `${agent === "openclaw" ? "OpenClaw" : "Hermes"} completed a local agent turn.`
          : data.error || "Agent request failed.",
      );
    } catch {
      setNotice("Agent API is unavailable. Start npm run dev:api.");
    } finally {
      setBusy(null);
    }
  };
  const search = async () => {
    setBusy("search");
    try {
      const response = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: searchProvider,
          depth: searchDepth,
          query: searchQuery,
          maxResults: 5,
          searchConfig,
        }),
      });
      const data = await response.json();
      setSearchResults(data.results || []);
      setNotice(
        response.ok
          ? `Search complete: ${data.results?.length || 0} unique sources.`
          : data.error || "Search failed.",
      );
    } catch {
      setNotice("Search API is unavailable. Start npm run dev:api.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="settings-view">
      <div className="settings-intro">
        <span className="section-label">External agents + research</span>
        <h2>Give every agent the full brief.</h2>
        <p>
          OpenClaw and Hermes receive the question, deadline, resolution
          criteria, and context you wrote—not a shortened substitute.
        </p>
      </div>
      <div className="agent-grid">
        <AgentCard
          name="Local MoA Advisors"
          detail="LM Studio MCP · Planner → Skeptic → Aggregator"
          state={connectorStatus?.localMoa ? "Ready" : "MCP"}
          action="Check MoA status"
          onClick={inspect}
        />
        <AgentCard
          name="OpenClaw"
          detail="Local agent turn · no delivery by default"
          state={connectorStatus?.openclaw ? "Installed" : "CLI"}
          action={busy === "openclaw" ? "Waiting…" : "Ask OpenClaw"}
          onClick={() => callAgent("openclaw")}
          disabled={busy === "openclaw"}
        />
        <AgentCard
          name="Hermes Agent"
          detail="One-shot local agent turn"
          state={connectorStatus?.hermes ? "Installed" : "CLI"}
          action={busy === "hermes" ? "Waiting…" : "Ask Hermes"}
          onClick={() => callAgent("hermes")}
          disabled={busy === "hermes"}
        />
      </div>
      <div className="search-card">
        <div>
          <span className="section-label">Research loop</span>
          <h3>Search the signal, then go deeper.</h3>
          <p>
            SearXNG is the default. The bounded search layer keeps research
            useful without exhausting provider quotas.
          </p>
        </div>
        <div className="search-controls">
          <input
            aria-label="Search query"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <select
            aria-label="Search provider"
            value={searchProvider}
            onChange={(event) =>
              setSearchProvider(event.target.value as SearchProviderId)
            }
          >
            <option value="searxng">SearXNG · default</option>
            <option value="tavily">Tavily · API key</option>
            <option value="brave">Brave · API key</option>
          </select>
          <select
            aria-label="Search depth"
            value={searchDepth}
            onChange={(event) => setSearchDepth(event.target.value)}
          >
            <option value="quick">Quick · 3 queries max</option>
            <option value="deep">Deep · 6 queries max</option>
          </select>
          <button
            className="primary"
            disabled={busy === "search" || !searchQuery.trim()}
            onClick={search}
          >
            {busy === "search" ? "Searching…" : "Search signals"}
          </button>
        </div>
        {searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map((searchResult) => (
              <a
                href={searchResult.url}
                target="_blank"
                rel="noreferrer"
                key={searchResult.url}
              >
                <strong>{searchResult.title}</strong>
                <span>{searchResult.snippet}</span>
                <small>
                  {searchResult.source} · {searchResult.url}
                </small>
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="agent-api-note">
        <strong>External API</strong>
        <span>
          POST <code>{API_BASE}/api/forecast</code>, <code>/api/search</code>,{" "}
          <code>/api/agent/openclaw</code>, or <code>/api/agent/hermes</code>.
        </span>
        <span>{notice}</span>
      </div>
    </section>
  );
}

function AgentCard({
  name,
  detail,
  state,
  action,
  onClick,
  disabled,
}: {
  name: string;
  detail: string;
  state: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-icon">{name[0]}</span>
        <div>
          <h3>{name}</h3>
          <p>{detail}</p>
        </div>
        <span className="connection">{state}</span>
      </div>
      <button className="secondary" disabled={disabled} onClick={onClick}>
        {action}
      </button>
    </div>
  );
}

function demoResult(): ForecastResult {
  return {
    probability: 68,
    confidence: "Medium",
    confidenceRange: [54, 80],
    summary:
      "68% aggregate likelihood before the selected deadline. Demo mode keeps the workflow usable while you configure live providers.",
    timeline: `Resolution by ${initialBrief.deadline}`,
    bestCase: "Cooling inflation and labor data support the policy pivot.",
    worstCase: "Inflation or energy shocks force policy to stay restrictive.",
    indicators: [
      "Inflation trend",
      "Labor-market cooling",
      "Forward guidance",
      "Energy and geopolitical risk",
    ],
    reasoning:
      "The base case supports a measured cut, but the forecast depends on continued disinflation and a labor market that cools without a recession.",
    opinions: [
      {
        provider: "lmstudio",
        probability: 64,
        confidence: "Medium",
        reasoning: "",
        status: "demo",
      },
      {
        provider: "minimax",
        probability: 70,
        confidence: "High",
        reasoning: "",
        status: "demo",
      },
      {
        provider: "grok",
        probability: 62,
        confidence: "Medium",
        reasoning: "",
        status: "demo",
      },
      {
        provider: "openai",
        probability: 76,
        confidence: "Medium",
        reasoning: "",
        status: "demo",
      },
    ],
    readout: {
      thesis:
        "The base case supports a measured cut, but the forecast depends on continued disinflation and a labor market that cools without a recession.",
      drivers: [
        "Cooling inflation and labor data",
        "Forward guidance becoming less restrictive",
        "Market pricing supporting a policy pivot",
      ],
      counterSignals: [
        "Energy or geopolitical shocks reignite inflation",
        "Labor conditions remain too strong for a cut",
      ],
      updateTriggers: [
        "A material CPI or PCE surprise",
        "A change in Federal Reserve guidance",
        "A sudden change in employment conditions",
      ],
      assumptions: [
        "The resolution criteria are clear and observable",
        "The deadline remains the relevant decision window",
      ],
    },
  };
}

export default App;
