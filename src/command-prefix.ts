export const DEFAULT_COMMAND_PREFIX = '/';

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function getCommandPrefix(): string {
  const prefix = process.env.COMMAND_PREFIX?.trim();
  if (!prefix || /\s/.test(prefix)) {
    return DEFAULT_COMMAND_PREFIX;
  }

  return prefix;
}

export function formatCommand(command: string): string {
  return `${getCommandPrefix()}${command}`;
}

export function parseCommand(content: string): ParsedCommand | null {
  const prefix = getCommandPrefix();
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const name = parts[0].slice(prefix.length).toLowerCase();
  if (!name) {
    return null;
  }

  return {
    name,
    args: parts.slice(1),
  };
}
