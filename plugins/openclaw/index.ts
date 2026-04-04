/**
 * HiveRelay OpenClaw Plugin
 *
 * Provides in-process control of a HiveRelay node for OpenClaw agents.
 * Falls back to HTTP API calls if the node is running as a separate process.
 *
 * Tools exposed:
 *   hiverelay_start   — Start relay node
 *   hiverelay_stop    — Stop relay node
 *   hiverelay_seed    — Seed a Pear app
 *   hiverelay_status  — Get node stats
 *   hiverelay_metrics — Get Prometheus metrics
 */

const API_BASE = 'http://127.0.0.1:9100';

interface RelayConfig {
  storage?: string;
  region?: string;
  maxStorage?: string;
  port?: number;
}

interface StatusResponse {
  running: boolean;
  publicKey: string | null;
  seededApps: number;
  connections: number;
  relay: {
    activeCircuits: number;
    totalCircuitsServed: number;
    totalBytesRelayed: number;
    capacityUsedPct: number;
  } | null;
  seeder: {
    coresSeeded: number;
    totalBytesStored: number;
    totalBytesServed: number;
    capacityUsedPct: number;
  } | null;
}

interface SeedResult {
  ok: boolean;
  discoveryKey?: string;
  error?: string;
}

interface HealthResponse {
  ok: boolean;
  running: boolean;
  uptime: {
    ms: number;
    hours: number;
    human: string;
  } | null;
}

// ─── API Helpers ────────────────────────────────────────────────────

async function apiGet<T>(path: string, port: number = 9100): Promise<T> {
  const base = port === 9100 ? API_BASE : `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: object, port: number = 9100): Promise<T> {
  const base = port === 9100 ? API_BASE : `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tools ──────────────────────────────────────────────────────────

/**
 * Start a HiveRelay node.
 * Launches the relay daemon as a background process via CLI.
 */
export async function hiverelay_start(config: RelayConfig = {}): Promise<string> {
  const args = ['hiverelay', 'start', '--quiet'];
  if (config.storage) args.push('--storage', config.storage);
  if (config.region) args.push('--region', config.region);
  if (config.maxStorage) args.push('--max-storage', config.maxStorage);
  if (config.port) args.push('--port', String(config.port));

  // Use child_process to spawn in background
  const { execSync } = await import('child_process');
  execSync(
    `nohup ${args.join(' ')} > ~/.hiverelay/relay.log 2>&1 &` +
    ` && echo $! > ~/.hiverelay/relay.pid`,
    { shell: '/bin/bash' }
  );

  // Wait briefly for startup
  await new Promise(r => setTimeout(r, 2000));

  try {
    const health = await apiGet<HealthResponse>('/health', config.port);
    return `Relay node started. Running: ${health.running}, Uptime: ${health.uptime?.human || 'starting'}`;
  } catch {
    return 'Relay node process started. Waiting for it to become ready...';
  }
}

/**
 * Stop a running HiveRelay node.
 */
export async function hiverelay_stop(): Promise<string> {
  try {
    const { execSync } = await import('child_process');
    execSync(
      'kill $(cat ~/.hiverelay/relay.pid 2>/dev/null) 2>/dev/null; rm -f ~/.hiverelay/relay.pid',
      { shell: '/bin/bash' }
    );
    return 'Relay node stopped.';
  } catch {
    return 'No running relay node found (or already stopped).';
  }
}

/**
 * Seed a Pear app by its public key.
 */
export async function hiverelay_seed(appKey: string, opts?: { port?: number }): Promise<SeedResult> {
  return apiPost<SeedResult>('/seed', { appKey }, opts?.port);
}

/**
 * Get current relay node status.
 */
export async function hiverelay_status(opts?: { port?: number }): Promise<StatusResponse> {
  return apiGet<StatusResponse>('/status', opts?.port);
}

/**
 * Get Prometheus-formatted metrics.
 */
export async function hiverelay_metrics(opts?: { port?: number }): Promise<string> {
  const port = opts?.port || 9100;
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  return res.text();
}

/**
 * Health check.
 */
export async function hiverelay_health(opts?: { port?: number }): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/health', opts?.port);
}
