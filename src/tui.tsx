/** @jsxImportSource @opentui/solid */
import { appendFileSync, mkdirSync } from "node:fs";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { Show, createEffect, createSignal } from "solid-js";
import { pickProviderId } from "./tui-detect";
import { fetchVerifiedGatewayJson, readGatewayToken } from "./tui-gateway";

// The TUI plugin runs in a SEPARATE process from the server plugin, so they do
// NOT share globalThis or module state. The bar therefore:
//   - detects the active provider via the TUI api (api.state.session), and
//   - reads usage over HTTP from the gateway (which lives in the server
//     process) at /dashboard/api/usage.
const GATEWAY_ORIGIN = "http://127.0.0.1:7438";
const USAGE_REFRESH_MS = 30_000;
const DETECT_POLL_MS = 2_000;
const FETCH_TIMEOUT_MS = 3_000;
const LOG_FILE = "/tmp/kiro-logs/tui.log";

let logDirOk = false;
function log(msg: string, extra?: unknown): void {
  try {
    if (!/^(1|true|yes|on)$/i.test(process.env.KIRO_FILE_LOG?.trim() ?? "")) return;
    if (!logDirOk) { mkdirSync("/tmp/kiro-logs", { recursive: true, mode: 0o700 }); logDirOk = true; }
    const e = { ts: new Date().toISOString(), msg, ...(extra !== undefined ? { data: extra } : {}) };
    appendFileSync(LOG_FILE, JSON.stringify(e) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch { /* silent — logging must never crash the TUI */ }
}

type Usage = {
  percentage: number;
  creditsUsed: number;
  creditsTotal: number;
  planTitle: string | null;
  monthlyResetsIn: string | null;
  error?: string;
};

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

type Theme = TuiPluginApi["theme"]["current"];

// ≥90% error, ≥70% warning, else success — same thresholds as pi-usage-bars.
function colorFor(percent: number, t: Theme): RGBA {
  if (percent >= 90) return t.error;
  if (percent >= 70) return t.warning;
  return t.success;
}

function bar(percent: number, width: number): string {
  const v = clamp(percent);
  const filled = Math.round((v / 100) * width);
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, width - filled));
}

// Pure provider resolver lives in ./tui-detect (unit tested). The session
// object carries the currently-selected providerID in runtime; we fall back to
// the most recent message's providerID when the session field is absent.

function activeSessionId(api: TuiPluginApi): string | undefined {
  const r = api.route.current as any;
  return r?.params?.sessionID ?? r?.params?.session_id ?? r?.params?.id;
}

// True only while the active session's provider is "kiro".
function createKiroDetector(api: TuiPluginApi) {
  const [isKiro, setIsKiro] = createSignal(false);

  const check = (reason: string) => {
    const sid = activeSessionId(api);
    if (!sid) {
      if (isKiro()) log("detector", { reason, sid: null, kiro: false });
      setIsKiro(false);
      return;
    }
    const session = api.state.session.get(sid) as any;
    const messages = (api.state.session.messages(sid) ?? []) as any[];
    const pid = pickProviderId(session, messages);
    const kiro = pid === "kiro";
    if (kiro !== isKiro()) log("detector", { reason, sid, pid, kiro });
    setIsKiro(kiro);
  };

  check("init");
  const id = setInterval(() => check("poll"), DETECT_POLL_MS);
  (id as unknown as { unref?: () => void }).unref?.();
  const offSession = api.event.on("session.updated", () => check("session.updated"));
  const offMessage = api.event.on("message.updated", () => check("message.updated"));
  api.lifecycle.onDispose(() => {
    clearInterval(id);
    offSession();
    offMessage();
  });

  return isKiro;
}

// Polls usage over HTTP, but only while `enabled()` is true (i.e. on kiro).
// The gateway lazy-starts in the server process when kiro is first used, so it
// is up by the time we detect kiro and start fetching.
function createUsageStore(api: TuiPluginApi, enabled: () => boolean) {
  const [u, setU] = createSignal<Usage | null>(null);
  let activeController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    if (!enabled() || api.lifecycle.signal.aborted) return;
    const ctrl = new AbortController();
    activeController = ctrl;
    const signal = AbortSignal.any([
      ctrl.signal,
      api.lifecycle.signal,
      AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ]);
    try {
      const token = readGatewayToken();
      if (!token) throw new Error("Gateway token unavailable");
      const data = await fetchVerifiedGatewayJson<Usage>(
        GATEWAY_ORIGIN,
        "/dashboard/api/usage",
        token,
        signal,
      );
      log("usage", { pct: data.percentage, error: data.error });
      setU(data);
    } catch (err) {
      if (!api.lifecycle.signal.aborted) {
        log("usage-error", { error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (activeController === ctrl) activeController = null;
    }
  };

  const scheduleTick = () => {
    if (inFlight) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };

  const id = setInterval(scheduleTick, USAGE_REFRESH_MS);
  (id as unknown as { unref?: () => void }).unref?.();

  // Fetch immediately whenever we transition into the kiro provider.
  createEffect(() => {
    if (enabled()) scheduleTick();
    else activeController?.abort(new Error("Kiro usage polling disabled"));
  });

  api.lifecycle.onDispose(() => {
    clearInterval(id);
    activeController?.abort(new Error("Kiro TUI plugin disposed"));
  });

  return u;
}

function KiroUsageBar(props: { api: TuiPluginApi; justify: "center" | "flex-end"; usage: () => Usage | null }) {
  const t = () => props.api.theme.current;

  const line = (): string => {
    const data = props.usage();
    if (!data) return "Kiro …";
    if (data.error) return `Kiro: ${data.error}`;
    if (data.creditsTotal === 0) return "Kiro —";
    const pct = clamp(data.percentage);
    const plan = data.planTitle ? `${data.planTitle} ` : "";
    const reset = data.monthlyResetsIn ? ` ⟳ ${data.monthlyResetsIn}` : "";
    const count = ` (${data.creditsUsed}/${data.creditsTotal})`;
    return `Kiro ${plan}C ${bar(pct, 10)} ${pct.toFixed(2).padStart(5)}%${reset}${count}`;
  };

  const lineColor = (): RGBA => {
    const data = props.usage();
    if (!data || data.error || data.creditsTotal === 0) return t().textMuted;
    return colorFor(clamp(data.percentage), t());
  };

  return (
    <box flexDirection="row" justifyContent={props.justify}>
      <text fg={lineColor()} wrapMode="none">
        {line()}
      </text>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  log("tui-plugin-enter");
  try {
    const isKiro = createKiroDetector(api);
    const usage = createUsageStore(api, isKiro);

    api.slots.register({
      order: 100,
      slots: {
        session_prompt_right: () => (
          <Show when={isKiro()} fallback={null}>
            <KiroUsageBar api={api} justify="flex-end" usage={usage} />
          </Show>
        ),
      },
    });
    log("slots-registered", { slots: ["session_prompt_right"] });
  } catch (err) {
    log("slots-register-error", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
};

log("module-eval");

const pluginModule: TuiPluginModule & { id: string } = {
  id: "opencode-kiro",
  tui,
};

export default pluginModule;
