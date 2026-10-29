import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import "./style.css";

type Connection = {
  name: string;
  provider: string;
  default?: boolean;
  defaultDatabase?: string;
};
type Alias = { name: string; connection: string; database: string };
type Environment = {
  name: string;
  defaultConnection?: string;
  connections: Connection[];
  databases: Alias[];
};
type Settings = { idleTimeoutMs: number; scriptTimeoutMs: number; historyEnabled: boolean };
type Configuration = {
  revision: string;
  schemaVersion: number;
  settings: Settings;
  limits: Record<"idleTimeoutMs" | "scriptTimeoutMs", { minimum: number; maximum: number }>;
  applies: Record<keyof Settings, string>;
  environments: Environment[];
};
type Status = {
  running: boolean;
  pid?: number;
  version?: string;
  worker?: { state: string; pid?: number; active: boolean; queued: number };
};
type Operation = Record<string, unknown> & { action: string; env?: string; connection?: string };
type Sheet =
  | { kind: "register" }
  | { kind: "connection"; env: string }
  | { kind: "rotate"; env: string; connection: string }
  | { kind: "alias"; env: string }
  | { kind: "rename"; env: string; alias: string }
  | { kind: "removeConnection"; env: string; connection: string }
  | { kind: "removeAlias"; env: string; alias: string }
  | { kind: "stopDaemon" }
  | { kind: "stopManager" };
const field = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim();
function takeUri(form: HTMLFormElement) {
  const input = form.elements.namedItem("uri") as HTMLInputElement;
  const uri = input.value;
  input.value = "";
  return uri;
}
function clearSecrets() {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    input.value = "";
}
function duration(ms: number) {
  if (ms === 0) return "disabled";
  return ms % 60000 === 0 ? `${ms / 60000} min` : `${ms} ms`;
}

function App() {
  const [phase, setPhase] = createSignal<"pairing" | "locked" | "ready" | "stopped">("pairing");
  const [view, setView] = createSignal<"connections" | "settings" | "runtime">("connections");
  const [config, setConfig] = createSignal<Configuration>();
  const [status, setStatus] = createSignal<Status>({ running: false });
  const [selection, setSelection] = createSignal("");
  const [sheet, setSheet] = createSignal<Sheet>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [inspection, setInspection] = createSignal<{
    env: string;
    connection: string;
    discovery: boolean;
    databases: string[];
    truncated: boolean;
  }>();
  const [expiresAt, setExpiresAt] = createSignal(0);
  const selected = createMemo(() =>
    config()?.environments.find((environment) => environment.name === selection())
  );
  const sheetEnvironment = createMemo(() => {
    const active = sheet();
    return active && "env" in active
      ? config()?.environments.find((environment) => environment.name === active.env)
      : undefined;
  });
  let token = "";
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let pairingAttempt = 0;
  const requests = new Set<AbortController>();

  function lock() {
    pairingAttempt++;
    token = "";
    clearSecrets();
    setSheet(undefined);
    setPhase("locked");
    for (const controller of requests) controller.abort();
    requests.clear();
    if (expiryTimer) clearTimeout(expiryTimer);
  }
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      const result = (await response.json()) as T & {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || result.ok === false) {
        if (response.status === 401) lock();
        if (response.status === 409)
          throw new Error(
            "Configuration changed elsewhere. Refresh it before making another change."
          );
        throw new Error(result.error?.message ?? "The manager could not complete this request.");
      }
      return result;
    } finally {
      requests.delete(controller);
    }
  }
  async function refresh() {
    const configuration = await request<Configuration>("/api/configuration");
    setConfig(configuration);
    if (!configuration.environments.some((environment) => environment.name === selection()))
      setSelection(configuration.environments[0]?.name ?? "");
    setStatus(await request<Status>("/api/status"));
  }
  async function refreshClicked() {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await refresh();
      setMessage("Configuration and status refreshed. No database connection was opened.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh configuration.");
    } finally {
      setBusy(false);
    }
  }
  async function operate(input: Operation, success: string, close = true) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { result, warning } = await request<{
        ok: true;
        result: unknown;
        warning?: { message: string };
      }>("/api/operation", {
        ...input,
        ...(["test", "discover", "stopDaemon", "stopManager"].includes(input.action)
          ? {}
          : { revision: config()?.revision }),
      });
      if (input.action === "stopManager") {
        lock();
        setPhase("stopped");
        return;
      }
      if (input.action === "test" || input.action === "discover") {
        const output = result as { databases?: string[]; truncated?: boolean };
        setInspection({
          env: String(input.env),
          connection: String(input.connection),
          discovery: input.action === "discover",
          databases: output.databases ?? [],
          truncated: output.truncated ?? false,
        });
      }
      if (close) setSheet(undefined);
      setMessage(warning ? `${success} ${warning.message}` : success);
      await refresh();
    } catch (cause) {
      const details =
        cause instanceof Error ? cause.message : "The request ended without a result.";
      setError(
        `${details} If the response was lost, the change may have completed. Refresh configuration before trying again. Nothing was retried automatically.`
      );
    } finally {
      setBusy(false);
    }
  }
  function openSheet(next: Sheet) {
    setError("");
    setMessage("");
    setSheet(next);
  }
  function closeSheet() {
    if (busy()) return;
    clearSecrets();
    setSheet(undefined);
  }
  function submitSheet(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const active = sheet();
    if (!active || busy()) return;
    if (active.kind === "register") {
      const env = field(form, "env");
      void operate(
        { action: "registerEnvironment", env, uri: takeUri(form) },
        `Environment ${env} saved. Registration did not contact MongoDB.`
      );
    } else if (active.kind === "connection") {
      void operate(
        {
          action: "registerConnection",
          env: active.env,
          connection: field(form, "connection"),
          uri: takeUri(form),
          makeDefault: false,
          aliases: [],
        },
        "Connection saved without contacting MongoDB."
      );
    } else if (active.kind === "rotate") {
      void operate(
        {
          action: "replaceCredential",
          env: active.env,
          connection: active.connection,
          uri: takeUri(form),
        },
        "Credential replaced after explicit live validation."
      );
    } else if (active.kind === "alias") {
      void operate(
        {
          action: "addDatabase",
          env: active.env,
          alias: field(form, "alias"),
          connection: field(form, "connection"),
          database: field(form, "database"),
        },
        "Optional database alias saved."
      );
    } else if (active.kind === "rename") {
      void operate(
        {
          action: "renameDatabase",
          env: active.env,
          alias: active.alias,
          name: field(form, "name"),
        },
        "Database alias renamed."
      );
    } else if (active.kind === "removeConnection") {
      void operate(
        { action: "removeConnection", env: active.env, connection: active.connection },
        "Connection removed."
      );
    } else if (active.kind === "removeAlias") {
      void operate(
        { action: "removeDatabase", env: active.env, alias: active.alias },
        "Database alias removed."
      );
    } else if (active.kind === "stopDaemon") {
      void operate({ action: "stopDaemon" }, "Database daemon stopped. The manager is still open.");
    } else {
      void operate({ action: "stopManager" }, "Manager stopped.");
    }
  }

  function consumePairing() {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("pair");
    window.history.replaceState(null, "", window.location.pathname);
    lock();
    if (!code) return;
    const attempt = pairingAttempt;
    setError("");
    setMessage("");
    setPhase("pairing");
    void request<{ token: string; expiresAt: number }>("/api/session", { code })
      .then(async (session) => {
        if (attempt !== pairingAttempt) return;
        token = session.token;
        setExpiresAt(session.expiresAt);
        expiryTimer = setTimeout(lock, Math.max(0, session.expiresAt - Date.now()));
        setPhase("ready");
        await refresh();
      })
      .catch(() => {
        if (attempt !== pairingAttempt) return;
        lock();
        setError(
          "This pairing link expired or was already used. Request a new link in the terminal."
        );
      });
  }

  onMount(() => {
    consumePairing();
    window.addEventListener("hashchange", consumePairing);
    const interval = setInterval(() => {
      if (phase() !== "ready" || document.visibilityState !== "visible" || polling || busy())
        return;
      polling = true;
      void request<Status>("/api/status")
        .then(setStatus)
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, 10000);
    const unload = lock;
    window.addEventListener("pagehide", unload);
    onCleanup(() => {
      clearInterval(interval);
      if (expiryTimer) clearTimeout(expiryTimer);
      window.removeEventListener("pagehide", unload);
      window.removeEventListener("hashchange", consumePairing);
      unload();
      token = "";
    });
  });

  return (
    <div class="workbench">
      <aside class="sidebar" aria-label="Manager navigation">
        <div class="sidebar-inner">
          <div class="brand">
            Runnel <span>Local manager</span>
          </div>
          <nav>
            <For
              each={[
                { key: "connections" as const, label: "Environments", icon: "◈" },
                { key: "settings" as const, label: "Settings", icon: "≡" },
                { key: "runtime" as const, label: "Runtime", icon: "○" },
              ]}
            >
              {(item) => (
                <button
                  type="button"
                  classList={{ "nav-item": true, active: view() === item.key }}
                  aria-current={view() === item.key ? "page" : undefined}
                  onClick={() => {
                    setView(item.key);
                    setMessage("");
                    setError("");
                  }}
                >
                  <span class="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              )}
            </For>
          </nav>
        </div>
      </aside>
      <main>
        <header class="topbar">
          <span class="crumb">
            Runnel <span aria-hidden="true">/</span>{" "}
            {view() === "connections"
              ? "Environments"
              : view() === "settings"
                ? "Settings"
                : "Runtime"}
          </span>
          <span class="local-badge">
            <span /> Local session
          </span>
        </header>
        <Show
          when={phase() === "ready"}
          fallback={
            <div class="locked-state">
              <p class="eyebrow">YOUR LOCAL WORKBENCH</p>
              <h1>
                {phase() === "pairing"
                  ? "Opening your session."
                  : phase() === "stopped"
                    ? "Manager stopped."
                    : "A fresh link, please."}
              </h1>
              <p>
                {phase() === "pairing"
                  ? "Pairing this page with the manager in your terminal."
                  : phase() === "stopped"
                    ? "This manager has stopped. The database daemon has its own lifecycle. Start runnel ui again when you need it."
                    : "Open the one-use pairing link printed by runnel ui. For a new link, press Enter in that terminal. Refreshing this page requires a fresh link."}
              </p>
              <Show when={error()}>
                <p class="notice error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="privacy-line">
                No browser cookies. No stored session. No remote requests.
              </div>
            </div>
          }
        >
          <div class="page-content">
            <div class="page-heading">
              <div>
                <h1>
                  {view() === "connections"
                    ? "Environments"
                    : view() === "settings"
                      ? "Settings"
                      : "Runtime"}
                </h1>
                <p class="page-description">
                  {view() === "connections"
                    ? "Register an environment and MongoDB URI."
                    : view() === "settings"
                      ? "Configure database worker behavior."
                      : "The manager and database daemon run independently. Status checks do not keep database pools alive."}
                </p>
              </div>
              <button
                type="button"
                class="button subtle refresh-button"
                disabled={busy()}
                onClick={() => void refreshClicked()}
              >
                <span aria-hidden="true">↻</span>
                <span>Refresh</span>
              </button>
            </div>
            <div class="messages" aria-live="polite">
              <Show when={message()}>
                <p class="notice success">{message()}</p>
              </Show>
              <Show when={error()}>
                <p class="notice error" role="alert">
                  {error()}
                </p>
              </Show>
            </div>
            <Show when={view() === "connections"}>
              <div class="environment-toolbar">
                <span class="section-caption">
                  REGISTERED ENVIRONMENTS <span>{config()?.environments.length ?? 0}</span>
                </span>
                <button
                  type="button"
                  class="button primary"
                  disabled={busy()}
                  onClick={() => openSheet({ kind: "register" })}
                >
                  + Add environment
                </button>
              </div>
              <Show
                when={(config()?.environments.length ?? 0) > 0}
                fallback={
                  <section class="empty-state">
                    <div class="empty-symbol" aria-hidden="true">
                      ◈
                    </div>
                    <p class="eyebrow">GET STARTED</p>
                    <h2>No environments</h2>
                    <p>
                      Start with an environment such as <code>local</code> or <code>staging</code>{" "}
                      and its MongoDB URI. Saving is offline. No database list or alias is required.
                    </p>
                    <button
                      type="button"
                      class="button primary"
                      onClick={() => openSheet({ kind: "register" })}
                    >
                      Add your first environment{" "}
                      <span class="button-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                    <div class="empty-footnote">
                      The URI is hidden while you type and stored only in your OS vault.
                    </div>
                  </section>
                }
              >
                <div class="environment-layout">
                  <label class="environment-picker">
                    <span>Environment</span>
                    <select
                      aria-label="Selected environment"
                      value={selection()}
                      onChange={(event) => {
                        setSelection(event.currentTarget.value);
                        setInspection(undefined);
                      }}
                    >
                      <For each={config()?.environments}>
                        {(environment) => (
                          <option
                            value={environment.name}
                            selected={selection() === environment.name}
                          >
                            {environment.name}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <section class="environment-list" aria-label="Registered environments">
                    <For each={config()?.environments}>
                      {(environment) => (
                        <button
                          type="button"
                          classList={{
                            "environment-tab": true,
                            selected: selection() === environment.name,
                          }}
                          onClick={() => {
                            setSelection(environment.name);
                            setInspection(undefined);
                          }}
                        >
                          <span class="environment-initial" aria-hidden="true">
                            {environment.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{environment.name}</strong>
                            <small>
                              {environment.connections.length}{" "}
                              {environment.connections.length === 1 ? "connection" : "connections"}
                            </small>
                          </span>
                          <span class="environment-arrow" aria-hidden="true">
                            ↗
                          </span>
                        </button>
                      )}
                    </For>
                  </section>
                  <Show when={selected()} keyed>
                    {(environment) => (
                      <section
                        class="environment-detail"
                        aria-label={`${environment.name} configuration`}
                      >
                        <div class="detail-heading">
                          <div>
                            <p class="eyebrow">ENVIRONMENT</p>
                            <h2>
                              <details class="object-name">
                                <summary>
                                  <span>{environment.name}</span>
                                </summary>
                                <code>{environment.name}</code>
                              </details>
                            </h2>
                          </div>
                          <span class="outline-badge">MongoDB</span>
                        </div>
                        <details class="cli-help">
                          <summary>CLI usage</summary>
                          <p>
                            Use <code>-e {environment.name} -d database_name</code> to select a
                            physical database. Aliases can refer to a connection and database.
                          </p>
                        </details>
                        <div class="section-heading">
                          <h3>Connections</h3>
                          <button
                            type="button"
                            class="text-button"
                            disabled={busy()}
                            onClick={() => openSheet({ kind: "connection", env: environment.name })}
                          >
                            Add advanced connection
                          </button>
                        </div>
                        <For each={environment.connections}>
                          {(connection) => (
                            <div class="connection-row">
                              <div class="connection-info">
                                <div>
                                  <div class="connection-title">
                                    <strong>
                                      <details class="object-name">
                                        <summary>
                                          <span>{connection.name}</span>
                                        </summary>
                                        <code>{connection.name}</code>
                                      </details>
                                    </strong>
                                    <Show when={connection.default}>
                                      <span class="default-badge">Default</span>
                                    </Show>
                                  </div>
                                  <p>
                                    {connection.defaultDatabase ? (
                                      <>
                                        URI database <code>{connection.defaultDatabase}</code>
                                      </>
                                    ) : (
                                      "Choose a physical database at operation time"
                                    )}
                                  </p>
                                </div>
                              </div>
                              <div class="connection-actions">
                                <button
                                  type="button"
                                  class="text-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    void operate(
                                      {
                                        action: "test",
                                        env: environment.name,
                                        connection: connection.name,
                                      },
                                      "Connection test completed.",
                                      false
                                    )
                                  }
                                >
                                  Test connection
                                </button>
                                <button
                                  type="button"
                                  class="text-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    void operate(
                                      {
                                        action: "discover",
                                        env: environment.name,
                                        connection: connection.name,
                                      },
                                      "Explicit database discovery completed.",
                                      false
                                    )
                                  }
                                >
                                  Discover databases
                                </button>
                                <Show when={!connection.default}>
                                  <button
                                    type="button"
                                    class="text-button"
                                    disabled={busy()}
                                    onClick={() =>
                                      void operate(
                                        {
                                          action: "defaultConnection",
                                          env: environment.name,
                                          connection: connection.name,
                                        },
                                        "Default connection updated.",
                                        false
                                      )
                                    }
                                  >
                                    Make default
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class="text-button"
                                  disabled={busy()}
                                  onClick={() =>
                                    openSheet({
                                      kind: "rotate",
                                      env: environment.name,
                                      connection: connection.name,
                                    })
                                  }
                                >
                                  Replace credential
                                </button>
                                <button
                                  type="button"
                                  class="text-button danger-text"
                                  disabled={busy()}
                                  onClick={() =>
                                    openSheet({
                                      kind: "removeConnection",
                                      env: environment.name,
                                      connection: connection.name,
                                    })
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                        <Show
                          when={inspection()?.env === environment.name ? inspection() : undefined}
                          keyed
                        >
                          {(result) => {
                            return (
                              <section class="inspection-result" aria-live="polite">
                                <h4>
                                  {result.connection} ·{" "}
                                  {result.discovery ? "Database discovery" : "Connection test"}
                                </h4>
                                <Show
                                  when={result.discovery}
                                  fallback={<p>The bounded connection test succeeded.</p>}
                                >
                                  <Show
                                    when={result.databases.length > 0}
                                    fallback={
                                      <p>
                                        No database names were returned. Database-user permissions
                                        determine what can be listed. A user may still access an
                                        explicitly named database.
                                      </p>
                                    }
                                  >
                                    <ul>
                                      <For each={result.databases}>
                                        {(database) => (
                                          <li>
                                            <code>{database}</code>
                                          </li>
                                        )}
                                      </For>
                                    </ul>
                                  </Show>
                                  <Show when={result.truncated}>
                                    <p>The list reached its bound and may be incomplete.</p>
                                  </Show>
                                </Show>
                              </section>
                            );
                          }}
                        </Show>
                        <div class="section-heading alias-heading">
                          <h3>
                            Database aliases <span class="muted">optional</span>
                          </h3>
                          <button
                            type="button"
                            class="text-button"
                            disabled={busy() || environment.connections.length === 0}
                            onClick={() => openSheet({ kind: "alias", env: environment.name })}
                          >
                            + Add alias
                          </button>
                        </div>
                        <Show
                          when={environment.databases.length > 0}
                          fallback={<p class="quiet-empty">No aliases configured.</p>}
                        >
                          <For each={environment.databases}>
                            {(alias) => (
                              <div class="alias-row">
                                <div>
                                  <strong>
                                    <details class="object-name">
                                      <summary>
                                        <span>{alias.name}</span>
                                      </summary>
                                      <code>{alias.name}</code>
                                    </details>
                                  </strong>
                                  <span class="alias-arrow" aria-hidden="true">
                                    {" "}
                                    →{" "}
                                  </span>
                                  <details class="object-name">
                                    <summary>
                                      <span>{alias.database}</span>
                                    </summary>
                                    <code>{alias.database}</code>
                                  </details>
                                  <small>
                                    via{" "}
                                    <details class="object-name">
                                      <summary>
                                        <span>{alias.connection}</span>
                                      </summary>
                                      <code>{alias.connection}</code>
                                    </details>
                                  </small>
                                </div>
                                <div class="row-actions">
                                  <button
                                    type="button"
                                    class="text-button"
                                    disabled={busy()}
                                    onClick={() =>
                                      openSheet({
                                        kind: "rename",
                                        env: environment.name,
                                        alias: alias.name,
                                      })
                                    }
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    class="text-button danger-text"
                                    disabled={busy()}
                                    onClick={() =>
                                      openSheet({
                                        kind: "removeAlias",
                                        env: environment.name,
                                        alias: alias.name,
                                      })
                                    }
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            )}
                          </For>
                        </Show>
                        <p class="detail-footnote">
                          Saving configuration never opens a database connection. Test and discovery
                          run only when you choose them.
                        </p>
                      </section>
                    )}
                  </Show>
                </div>
              </Show>
            </Show>
            <Show when={view() === "settings" && config()}>
              <form
                class="settings-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  void operate(
                    {
                      action: "settings",
                      patch: {
                        idleTimeoutMs: Number(field(form, "idleTimeoutMs")),
                        scriptTimeoutMs: Number(field(form, "scriptTimeoutMs")),
                        historyEnabled: (
                          form.elements.namedItem("historyEnabled") as HTMLInputElement
                        ).checked,
                      },
                    },
                    "Settings saved.",
                    false
                  );
                }}
              >
                <div class="panel-title">
                  <h2>Database worker</h2>
                  <p>Changes do not interrupt work already in progress.</p>
                </div>
                <label class="setting-row">
                  <span>
                    <strong>Idle shutdown</strong>
                    <small>
                      Milliseconds of database inactivity before the daemon stops. Applies at the
                      next daemon start. The default is five minutes. Zero disables idle shutdown.
                    </small>
                  </span>
                  <input
                    name="idleTimeoutMs"
                    type="number"
                    required
                    min={0}
                    max={config()?.limits.idleTimeoutMs.maximum}
                    step={1}
                    value={config()?.settings.idleTimeoutMs}
                    disabled={busy()}
                  />
                </label>
                <label class="setting-row">
                  <span>
                    <strong>Script timeout</strong>
                    <small>
                      Default milliseconds for the next submitted script without a timeout override.
                      Zero disables the script deadline.
                    </small>
                  </span>
                  <input
                    name="scriptTimeoutMs"
                    type="number"
                    required
                    min={0}
                    max={config()?.limits.scriptTimeoutMs.maximum}
                    step={1}
                    value={config()?.settings.scriptTimeoutMs}
                    disabled={busy()}
                  />
                </label>
                <label class="setting-row checkbox-row">
                  <span>
                    <strong>Operation history</strong>
                    <small>
                      Applies to the next submitted operation. Turning it off does not erase
                      existing history. Setup, credential replacement and connection inspection are
                      excluded.
                    </small>
                  </span>
                  <input
                    name="historyEnabled"
                    type="checkbox"
                    checked={config()?.settings.historyEnabled}
                    disabled={busy()}
                  />
                  <span class="sr-only">Enable operation history</span>
                </label>
                <div class="panel-footer">
                  <p>
                    CLI equivalent: <code>runnel settings set</code>
                  </p>
                  <button type="submit" class="button primary" disabled={busy()}>
                    {busy() ? "Saving…" : "Save settings"}
                  </button>
                </div>
              </form>
            </Show>
            <Show when={view() === "runtime"}>
              <div class="runtime-grid">
                <section class="runtime-card">
                  <div class="runtime-heading">
                    <span class="section-caption">Manager status</span>
                    <span class="status-pill">
                      <span class="status-dot" /> Running
                    </span>
                  </div>
                  <h2>Manager</h2>
                  <p>
                    The foreground manager serves the bundled interface. Closing a tab does not stop
                    it.
                  </p>
                  <dl>
                    <div>
                      <dt>Session</dt>
                      <dd>Memory only</dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{new Date(expiresAt()).toLocaleTimeString()}</dd>
                    </div>
                    <div>
                      <dt>Browser opening</dt>
                      <dd>Explicit opt-in</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    class="button secondary"
                    disabled={busy()}
                    onClick={() => openSheet({ kind: "stopManager" })}
                  >
                    Stop manager
                  </button>
                  <small>
                    Revokes browser sessions and finishes committed configuration transactions. The
                    database daemon is separate.
                  </small>
                </section>
                <section class="runtime-card">
                  <div class="runtime-heading">
                    <span class="section-caption">Daemon status</span>
                    <span classList={{ "status-pill": true, stopped: !status().running }}>
                      <span class="status-dot" /> {status().running ? "Running" : "Stopped"}
                    </span>
                  </div>
                  <h2>Database daemon</h2>
                  <p>
                    Only explicit database operations start the daemon and its worker. Opening this
                    manager does not.
                  </p>
                  <dl>
                    <div>
                      <dt>Daemon process</dt>
                      <dd>{status().pid ?? "None"}</dd>
                    </div>
                    <div>
                      <dt>Worker</dt>
                      <dd>
                        {status().worker
                          ? `${status().worker?.state}${status().worker?.pid ? ` · PID ${status().worker?.pid}` : ""}`
                          : "Not started"}
                      </dd>
                    </div>
                    <div>
                      <dt>Work in progress</dt>
                      <dd>
                        {status().worker?.active ? "Active" : "None"}
                        {status().worker?.queued ? ` · ${status().worker?.queued} queued` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Configured idle shutdown</dt>
                      <dd>{duration(config()?.settings.idleTimeoutMs ?? 300000)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    class="button secondary"
                    disabled={busy() || !status().running}
                    onClick={() => openSheet({ kind: "stopDaemon" })}
                  >
                    Stop database daemon
                  </button>
                  <small>
                    Stopping cancels active or queued database work. This manager stays open. On
                    Windows, worker termination can be forced.
                  </small>
                </section>
              </div>
              <div class="runtime-note">
                <span class="runtime-arrow" aria-hidden="true">
                  ↳
                </span>
                <p>
                  Status polling reads process metadata. It does not access the credential vault,
                  connect to MongoDB or renew database idle time.
                </p>
              </div>
            </Show>
          </div>
        </Show>
      </main>
      <Show when={sheet()} keyed>
        {(active) => (
          <dialog
            ref={(element) => queueMicrotask(() => element.isConnected && element.showModal())}
            class="sheet"
            aria-labelledby="sheet-title"
            onCancel={(event) => {
              event.preventDefault();
              closeSheet();
            }}
          >
            <form onSubmit={submitSheet} autocomplete="off">
              <div class="sheet-header">
                <span class="eyebrow">
                  {active.kind === "register" ? "NEW ENVIRONMENT" : "MANAGE CONFIGURATION"}
                </span>
                <button
                  type="button"
                  class="close-button"
                  aria-label="Close dialog"
                  disabled={busy()}
                  onClick={closeSheet}
                >
                  ×
                </button>
              </div>
              <h2 id="sheet-title">
                {active.kind === "register"
                  ? "Add environment"
                  : active.kind === "connection"
                    ? "Add connection"
                    : active.kind === "rotate"
                      ? "Replace credential"
                      : active.kind === "alias"
                        ? "Add alias"
                        : active.kind === "rename"
                          ? "Rename alias"
                          : active.kind === "removeConnection"
                            ? "Remove this connection?"
                            : active.kind === "removeAlias"
                              ? "Remove this alias?"
                              : active.kind === "stopDaemon"
                                ? "Stop database work?"
                                : "Close the local manager?"}
              </h2>
              <Show when={"env" in active}>
                <p class="sheet-context">
                  {"env" in active ? active.env : ""}
                  {"connection" in active
                    ? ` / ${active.connection}`
                    : "alias" in active
                      ? ` / ${active.alias}`
                      : ""}
                </p>
              </Show>
              <Show when={active.kind === "register"}>
                <p>Save an environment and connection without contacting MongoDB.</p>
                <label class="field-label">
                  Environment name
                  <input
                    name="env"
                    required
                    maxlength={64}
                    pattern={"[A-Za-z0-9_\\-]{1,64}"}
                    placeholder="e.g. staging"
                    autocomplete="off"
                    disabled={busy()}
                  />
                </label>
              </Show>
              <Show when={active.kind === "connection"}>
                <p>
                  Advanced: add another connection to this environment. Its current default stays
                  unchanged.
                </p>
                <label class="field-label">
                  Connection name
                  <input
                    name="connection"
                    required
                    maxlength={64}
                    pattern={"[A-Za-z0-9_\\-]{1,64}"}
                    placeholder="e.g. analytics"
                    disabled={busy()}
                  />
                </label>
              </Show>
              <Show when={active.kind === "rotate"}>
                <p class="callout">
                  This action explicitly validates the replacement URI against MongoDB before
                  saving. It can start the database daemon. A permission-denied ping does not block
                  replacement. Database-user permissions still determine subsequent access.
                </p>
              </Show>
              <Show when={["register", "connection", "rotate"].includes(active.kind)}>
                <label class="field-label">
                  {active.kind === "rotate" ? "Replacement MongoDB URI" : "MongoDB URI"}
                  <input
                    name="uri"
                    type="password"
                    required
                    maxlength={16384}
                    autocomplete="new-password"
                    spellcheck={false}
                    autocapitalize="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    placeholder="mongodb://…"
                    disabled={busy()}
                  />
                </label>
                <p class="field-note">
                  Hidden while entered. Cleared on submit. Stored only in your OS vault and never
                  returned to this page.
                </p>
              </Show>
              <Show when={active.kind === "alias"}>
                <p>
                  Aliases are optional. Agents can already select physical database names directly.
                </p>
                <label class="field-label">
                  Alias name
                  <input
                    name="alias"
                    required
                    maxlength={64}
                    pattern={"[A-Za-z0-9_\\-]{1,64}"}
                    disabled={busy()}
                  />
                </label>
                <label class="field-label">
                  Connection
                  <select name="connection" aria-label="Connection" required disabled={busy()}>
                    <For each={sheetEnvironment()?.connections}>
                      {(connection) => (
                        <option value={connection.name}>
                          {connection.name}
                          {connection.default ? " · default" : ""}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <label class="field-label">
                  Physical database name
                  <input name="database" required maxlength={63} disabled={busy()} />
                </label>
              </Show>
              <Show when={active.kind === "rename"}>
                <label class="field-label">
                  New alias name
                  <input
                    name="name"
                    required
                    maxlength={64}
                    pattern={"[A-Za-z0-9_\\-]{1,64}"}
                    disabled={busy()}
                  />
                </label>
                <p>
                  Existing agent commands using the old alias will need the new name. The physical
                  database is unchanged.
                </p>
              </Show>
              <Show when={active.kind === "removeConnection"}>
                <p>
                  This removes the catalog registration and its unused stored credential. Remove
                  aliases that refer to this connection first. No database content is deleted.
                </p>
              </Show>
              <Show when={active.kind === "removeAlias"}>
                <p>
                  This removes the name from the catalog. It does not delete a database or
                  connection.
                </p>
              </Show>
              <Show when={active.kind === "stopDaemon"}>
                <p class="callout">
                  Active or queued database operations will be cancelled and never replayed. A
                  mutation may already have occurred. Windows worker termination can be forced and
                  does not establish graceful driver cleanup.
                </p>
                <p>
                  The manager will remain open. A later explicit database operation can start the
                  daemon again.
                </p>
              </Show>
              <Show when={active.kind === "stopManager"}>
                <p>
                  All browser sessions will end. Already committed credential and catalog
                  transactions will finish before the process exits.
                </p>
                <p>
                  The database daemon is separate. Stop it first if you also want its pools closed.
                </p>
              </Show>
              <Show when={error()}>
                <p class="notice error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="sheet-actions">
                <button type="button" class="button subtle" disabled={busy()} onClick={closeSheet}>
                  Cancel
                </button>
                <button
                  type="submit"
                  classList={{
                    button: true,
                    primary: ![
                      "removeConnection",
                      "removeAlias",
                      "stopDaemon",
                      "stopManager",
                    ].includes(active.kind),
                    danger: [
                      "removeConnection",
                      "removeAlias",
                      "stopDaemon",
                      "stopManager",
                    ].includes(active.kind),
                  }}
                  disabled={busy()}
                >
                  {busy()
                    ? "Working…"
                    : active.kind === "rotate"
                      ? "Validate & replace"
                      : active.kind === "stopDaemon"
                        ? "Stop database daemon"
                        : active.kind === "stopManager"
                          ? "Stop manager"
                          : active.kind === "removeConnection"
                            ? "Remove connection"
                            : active.kind === "removeAlias"
                              ? "Remove alias"
                              : "Save"}
                </button>
              </div>
            </form>
          </dialog>
        )}
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
