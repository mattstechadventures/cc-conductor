const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_PATTERN = /\u001b[@-Z\\-_]/g;

export interface WorkerPromptSignals {
  isTrustPrompt: boolean;
  isDevelopmentChannelPrompt: boolean;
  isPermissionPrompt: boolean;
  isOutsideAllowedDirectoryPrompt: boolean;
  permissionPromptAction: 'enter' | 'down-enter' | null;
  blockedDirectoryPath: string | null;
  isReadyPrompt: boolean;
}

export function analyzeTerminalOutput(output: string): WorkerPromptSignals {
  const normalizedOutput = normalizeTerminalOutput(output);
  const lastFewLines = normalizedOutput.trimEnd().split('\n').slice(-12).join('\n');
  const compactOutput = compactPromptText(lastFewLines);

  const isTrustPrompt =
    compactOutput.includes('quicksafetycheck:') &&
    compactOutput.includes('yes,itrustthisfolder');

  const isDevelopmentChannelPrompt =
    compactOutput.includes('warning:loadingdevelopmentchannels') &&
    compactOutput.includes('iamusingthisforlocaldevelopment');

  const isOutsideAllowedDirectoryPrompt =
    compactOutput.includes('doyouwanttoproceed?') &&
    compactOutput.includes('allowreadingfrom') &&
    compactOutput.includes('fromthisproject');

  const permissionPromptAction =
    compactOutput.includes('doyouwanttoproceed?') &&
    compactOutput.includes('yes,anddon\'taskagainfor')
      ? 'enter'
      : compactOutput.includes('yes,iaccept') && compactOutput.includes('no,exit')
        ? 'down-enter'
        : null;

  const isPermissionPrompt = permissionPromptAction !== null && !isOutsideAllowedDirectoryPrompt;
  const blockedDirectoryPath = isOutsideAllowedDirectoryPrompt
    ? extractBlockedDirectoryPath(normalizedOutput)
    : null;
  const hasLiveSessionUi =
    compactOutput.includes('listeningforchannelmessagesfrom:') ||
    compactOutput.includes('accepteditson') ||
    compactOutput.includes('project:') ||
    compactOutput.includes('welcomeback') ||
    compactOutput.includes('recentactivity') ||
    compactOutput.includes('tipsforgettingstarted');

  const isReadyPrompt =
    lastFewLines.includes('❯') &&
    hasLiveSessionUi &&
    !compactOutput.includes('running') &&
    !compactOutput.includes('waiting') &&
    !compactOutput.includes('simmering') &&
    !isOutsideAllowedDirectoryPrompt &&
    !isPermissionPrompt;

  return {
    isTrustPrompt,
    isDevelopmentChannelPrompt,
    isPermissionPrompt,
    isOutsideAllowedDirectoryPrompt,
    permissionPromptAction,
    blockedDirectoryPath,
    isReadyPrompt,
  };
}

export function normalizeTerminalOutput(output: string): string {
  return output
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_PATTERN, '')
    .replace(/\r/g, '');
}

function compactPromptText(output: string): string {
  return output.toLowerCase().replace(/\s+/g, '');
}

function extractBlockedDirectoryPath(output: string): string | null {
  const pathMatches = [...output.matchAll(/["']([A-Za-z]:[\\/][^"'\\r\\n]+|\/[^"'\\r\\n]+)["']/g)];
  if (pathMatches.length > 0) {
    return pathMatches[pathMatches.length - 1][1];
  }

  const commandMatches = [...output.matchAll(/\b(?:cd|ls|dir|pwd|cat|find|Get-ChildItem)\s+([^\n\r]+)/gi)];
  if (commandMatches.length === 0) {
    return null;
  }

  const lastMatch = commandMatches[commandMatches.length - 1][1].trim();
  return lastMatch || null;
}
