import { execSync } from 'child_process';
import { Client, TextChannel } from 'discord.js';
import type { AgentBackend, Checkpoint, CheckpointMessage, Session } from './types.js';
import { getBackendDisplayName } from './agent-backends.js';

export async function fetchRecentSessionMessages(
  session: Session,
  client: Client,
  count = parseInt(process.env.CHECKPOINT_DISCORD_MESSAGES || '50', 10)
): Promise<CheckpointMessage[]> {
  try {
    const channel = await client.channels.fetch(session.discordChannelId);
    if (!channel || !(channel instanceof TextChannel)) return [];

    const backendLabel = getBackendDisplayName(session.activeBackend);
    const messages = await channel.messages.fetch({ limit: Math.min(count, 100) });
    return messages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(message => ({
        author: message.author.bot ? backendLabel : message.author.displayName || message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
      }));
  } catch {
    return [];
  }
}

export function mergeCheckpointMessages(
  checkpointMessages: CheckpointMessage[],
  liveMessages: CheckpointMessage[]
): CheckpointMessage[] {
  const merged = [...liveMessages];
  for (const checkpointMessage of checkpointMessages) {
    const duplicate = liveMessages.some(
      liveMessage =>
        Math.abs(liveMessage.timestamp - checkpointMessage.timestamp) < 2000 &&
        liveMessage.author === checkpointMessage.author
    );
    if (!duplicate) {
      merged.push(checkpointMessage);
    }
  }
  return merged.sort((left, right) => left.timestamp - right.timestamp);
}

export function buildResumePrompt(
  session: Session,
  checkpoint: Checkpoint | null,
  messages: CheckpointMessage[]
): string {
  const now = Date.now();
  const interruptedAt = session.interruptedAt ?? checkpoint?.writtenAt ?? now;
  const minutesAgo = Math.round((now - interruptedAt) / 60_000);
  const resumeNum = session.resumeCount + 1;
  const activeBackend = getBackendDisplayName(session.activeBackend);
  const formattedMessages = messages
    .map(message => `${message.author}: ${message.content}`)
    .join('\n');

  return `[CONDUCTOR RESUME - Session: ${session.name} - Resume #${resumeNum}]

You are resuming a previous ${activeBackend} session that was interrupted.
Project directory: ${session.projectDir}
Originally started: ${new Date(session.createdAt).toISOString()}
Interrupted: ${new Date(interruptedAt).toISOString()} (${minutesAgo} minutes ago)

--- Last known task ---
${checkpoint?.taskSummary || 'No task summary available.'}

--- Git state at checkpoint ---
Branch: ${checkpoint?.gitBranch || 'unknown'}
Last commit: ${checkpoint?.gitLastCommit || 'unknown'}

--- Recent conversation (${messages.length} messages) ---
${formattedMessages || 'No recent messages available.'}

--- End of resume context ---

Please acknowledge you have read the above context and are ready to continue.
State what you understand the current task to be and what your next action will be.
Do not repeat the resume context back verbatim.
`;
}

export function buildBackendHandoffPrompt(input: {
  session: Session;
  checkpoint: Checkpoint | null;
  messages: CheckpointMessage[];
  sourceBackend: AgentBackend;
  targetBackend: AgentBackend;
}): string {
  const gitState = readGitState(input.session.projectDir);
  const source = getBackendDisplayName(input.sourceBackend);
  const target = getBackendDisplayName(input.targetBackend);
  const formattedMessages = input.messages
    .slice(-40)
    .map(message => `${message.author}: ${message.content}`)
    .join('\n');

  return `[CC CONDUCTOR HANDOFF]

You are ${target}. This logical Discord session is switching from ${source} to ${target}.
Session name: ${input.session.name}
Project directory: ${input.session.projectDir}
Switch time: ${new Date().toISOString()}

--- Last checkpoint summary ---
${input.checkpoint?.taskSummary || 'No checkpoint summary available.'}

--- Current git state ---
Branch: ${gitState.branch || input.checkpoint?.gitBranch || 'unknown'}
Last commit: ${gitState.lastCommit || input.checkpoint?.gitLastCommit || 'unknown'}

--- Recent Discord transcript (${input.messages.length} messages) ---
${formattedMessages || 'No recent messages available.'}

--- Instructions ---
1. Acknowledge the handoff briefly.
2. Continue from the current project state instead of repeating the transcript.
3. Call out any immediate next action if work should continue right away.
`;
}

function readGitState(dir: string): { branch: string | null; lastCommit: string | null } {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const lastCommit = execSync('git log -1 --oneline', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return { branch, lastCommit };
  } catch {
    return { branch: null, lastCommit: null };
  }
}
