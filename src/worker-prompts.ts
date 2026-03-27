const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_PATTERN = /\u001b[@-Z\\-_]/g;
const MODAL_OPTION_PATTERN = /^(?:[>❯]\s*)?\d+\.\s+\S/i;
const MODAL_FOOTER_PATTERN = /(esc to cancel|enter to confirm|tab to amend)/i;

export interface WorkerPromptSignals {
  isTrustPrompt: boolean;
  isDevelopmentChannelPrompt: boolean;
  isPermissionPrompt: boolean;
  isOutsideAllowedDirectoryPrompt: boolean;
  permissionPromptAction: 'enter' | 'down-enter' | null;
  blockedDirectoryPath: string | null;
  isReadyPrompt: boolean;
  isBlockingModal: boolean;
  isUnknownBlockingModal: boolean;
  blockingModalSignature: string | null;
}

export function analyzeTerminalOutput(output: string): WorkerPromptSignals {
  const normalizedOutput = normalizeTerminalOutput(output);
  const recentLines = getRecentPromptLines(normalizedOutput);
  const lastFewLines = recentLines.slice(-12).join('\n');
  const compactOutput = compactPromptText(lastFewLines);
  const blockingModalSignature = extractBlockingModalSignature(recentLines);
  const hasDontAskAgainOption =
    compactOutput.includes("yes,anddon'taskagainfor") ||
    compactOutput.includes('yes,anddontaskagainfor');
  const isSettingsEditApprovalPrompt =
    compactOutput.includes('doyouwanttomakethiseditto') &&
    compactOutput.includes('allowclaudetoedititsownsettingsforthissession');

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
    hasDontAskAgainOption
      ? 'enter'
      : isSettingsEditApprovalPrompt
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
  const isBlockingModal = blockingModalSignature !== null;
  const isUnknownBlockingModal =
    isBlockingModal &&
    !isTrustPrompt &&
    !isDevelopmentChannelPrompt &&
    !isPermissionPrompt &&
    !isOutsideAllowedDirectoryPrompt &&
    !isReadyPrompt;

  return {
    isTrustPrompt,
    isDevelopmentChannelPrompt,
    isPermissionPrompt,
    isOutsideAllowedDirectoryPrompt,
    permissionPromptAction,
    blockedDirectoryPath,
    isReadyPrompt,
    isBlockingModal,
    isUnknownBlockingModal,
    blockingModalSignature,
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

function getRecentPromptLines(output: string, maxLines = 24): string[] {
  return output
    .trimEnd()
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function extractBlockingModalSignature(lines: string[]): string | null {
  const optionLines = lines.filter(line => MODAL_OPTION_PATTERN.test(line));
  if (optionLines.length < 2) {
    return null;
  }

  const titleLines = lines.filter(line =>
    line.endsWith('?') ||
    /^use skill /i.test(line) ||
    /^edit file$/i.test(line) ||
    /^do you want /i.test(line)
  );
  const footerLines = lines.filter(line => MODAL_FOOTER_PATTERN.test(line));
  if (titleLines.length === 0 && footerLines.length === 0) {
    return null;
  }

  const signatureParts = [
    ...titleLines.slice(-2),
    ...optionLines.slice(-3),
    ...footerLines.slice(-1),
  ]
    .map(normalizeModalSignatureLine)
    .filter(Boolean);

  return signatureParts.length > 0 ? [...new Set(signatureParts)].join('|') : null;
}

function normalizeModalSignatureLine(line: string): string {
  return compactPromptText(line.replace(/^(?:[>❯]\s*)?\d+\.\s*/, ''));
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
