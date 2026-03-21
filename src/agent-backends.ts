import type { AgentBackend, Session, SessionBackendSummary } from './types.js';
import { validateClaudeCli } from './claude-cli.js';
import { validateCodexCli } from './codex-cli.js';

export const ALL_AGENT_BACKENDS: AgentBackend[] = ['claude', 'codex'];

export interface BackendAdapterValidation {
  backend: AgentBackend;
  displayName: string;
  validate: (env?: NodeJS.ProcessEnv) => unknown;
  isResumable: (summary: SessionBackendSummary | null) => boolean;
}

const BACKEND_ADAPTERS: Record<AgentBackend, BackendAdapterValidation> = {
  claude: {
    backend: 'claude',
    displayName: 'Claude',
    validate: validateClaudeCli,
    isResumable: (summary) =>
      !!summary && (!!summary.nativeResumeRef || !!summary.nativeSessionName),
  },
  codex: {
    backend: 'codex',
    displayName: 'Codex',
    validate: validateCodexCli,
    isResumable: (summary) => !!summary?.nativeResumeRef,
  },
};

export function isAgentBackend(value: string | null | undefined): value is AgentBackend {
  return value === 'claude' || value === 'codex';
}

export function getBackendAdapter(backend: AgentBackend): BackendAdapterValidation {
  return BACKEND_ADAPTERS[backend];
}

export function getBackendDisplayName(backend: AgentBackend): string {
  return getBackendAdapter(backend).displayName;
}

export function parseEnabledAgentBackends(env: NodeJS.ProcessEnv = process.env): AgentBackend[] {
  const raw = env.ENABLED_AGENT_BACKENDS?.trim() || 'claude,codex';
  const values = raw
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  const backends: AgentBackend[] = [];
  for (const value of values) {
    if (!isAgentBackend(value)) {
      throw new Error(`Unsupported backend in ENABLED_AGENT_BACKENDS: "${value}"`);
    }
    if (!backends.includes(value)) {
      backends.push(value);
    }
  }

  if (backends.length === 0) {
    throw new Error('ENABLED_AGENT_BACKENDS must include at least one backend.');
  }

  return backends;
}

export function getDefaultAgentBackend(env: NodeJS.ProcessEnv = process.env): AgentBackend {
  const configured = env.DEFAULT_AGENT_BACKEND?.trim().toLowerCase() || 'claude';
  if (!isAgentBackend(configured)) {
    throw new Error(`Unsupported DEFAULT_AGENT_BACKEND "${configured}"`);
  }

  const enabled = parseEnabledAgentBackends(env);
  if (!enabled.includes(configured)) {
    throw new Error(
      `DEFAULT_AGENT_BACKEND "${configured}" is not present in ENABLED_AGENT_BACKENDS (${enabled.join(',')}).`
    );
  }

  return configured;
}

export function isBackendEnabled(
  backend: AgentBackend,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return parseEnabledAgentBackends(env).includes(backend);
}

export function getSessionBackendSummary(
  session: Pick<Session, 'backendStates'>,
  backend: AgentBackend
): SessionBackendSummary | null {
  return session.backendStates.find(summary => summary.backend === backend) || null;
}

export function getInactiveBackend(session: Pick<Session, 'activeBackend'>): AgentBackend {
  return session.activeBackend === 'claude' ? 'codex' : 'claude';
}

export function formatBackendStatus(summary: SessionBackendSummary | null): string {
  if (!summary) return 'not configured';
  if (summary.state === 'never_started') return 'never started';
  if (summary.state === 'active') return 'active';
  return summary.resumable ? 'parked and resumable' : 'parked';
}

export function formatInactiveBackendSummary(
  session: Pick<Session, 'activeBackend' | 'backendStates'>
): string {
  const inactive = getSessionBackendSummary(session, getInactiveBackend(session));
  if (!inactive) {
    return 'Standby backend: n/a';
  }

  const backendName = `**${getBackendDisplayName(inactive.backend)}**`;
  if (inactive.state === 'never_started') {
    return `Standby backend: ${backendName} has not been started yet`;
  }
  if (inactive.state === 'active') {
    return `Standby backend: ${backendName} is active`;
  }
  if (inactive.resumable) {
    return `Standby backend: ${backendName} is parked and can be resumed later`;
  }
  return `Standby backend: ${backendName} is parked`;
}
