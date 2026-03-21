import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(REPO_ROOT, 'data');
const SESSION_ROOT = path.join(DATA_ROOT, 'sessions');

export function getRepoRoot(): string {
  return REPO_ROOT;
}

export function ensureDataRoot(): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
}

export function getSessionStateDir(sessionId: string): string {
  return path.join(SESSION_ROOT, sessionId);
}

export function ensureSessionStateDir(sessionId: string): string {
  const dir = getSessionStateDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getWorkerStatePath(sessionId: string): string {
  return path.join(getSessionStateDir(sessionId), 'worker.json');
}

export function getWorkerStdoutLogPath(sessionId: string): string {
  return path.join(getSessionStateDir(sessionId), 'worker.stdout.log');
}

export function getWorkerStderrLogPath(sessionId: string): string {
  return path.join(getSessionStateDir(sessionId), 'worker.stderr.log');
}

export function getWorkerTerminalLogPath(sessionId: string): string {
  return path.join(getSessionStateDir(sessionId), 'terminal.log');
}

export function getCheckpointPath(projectDir: string): string {
  return path.join(projectDir, '.conductor-checkpoint.json');
}

export function getResumePromptPath(projectDir: string): string {
  return path.join(projectDir, '.conductor-resume-prompt.md');
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readTextFileTail(filePath: string, maxChars = 4000): string | null {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch {
    return null;
  }
}

export function toRepoRelativePath(filePath: string): string {
  const relative = path.relative(REPO_ROOT, filePath);
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative.split(path.sep).join('/');
}

export function resolveUserPath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

export function normalizeManagedPath(inputPath: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = resolveUserPathForPlatform(inputPath, platform);
  const normalized = pathApi.normalize(resolved);
  return trimTrailingSeparator(normalized, pathApi);
}

export function managedPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedLeft = normalizeManagedPath(left, platform);
  const normalizedRight = normalizeManagedPath(right, platform);
  if (platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function trimTrailingSeparator(value: string, pathApi: typeof path.posix | typeof path.win32): string {
  const root = pathApi.parse(value).root;
  if (value === root) return value;
  return value.replace(new RegExp(`${escapeRegex(pathApi.sep)}+$`), '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveUserPathForPlatform(inputPath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith(`~${pathApi.sep}`)) {
    return pathApi.join(os.homedir(), inputPath.slice(2));
  }
  return pathApi.isAbsolute(inputPath) ? inputPath : pathApi.resolve(inputPath);
}
