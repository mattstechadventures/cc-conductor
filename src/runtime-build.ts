import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getRepoRoot } from './state.js';

export interface RuntimeBuildEntry {
  relativePath: string;
  content: string | Buffer;
}

let cachedRuntimeBuildId: string | null = null;

export function getRuntimeBuildId(): string {
  if (!cachedRuntimeBuildId) {
    cachedRuntimeBuildId = computeRuntimeBuildId();
  }
  return cachedRuntimeBuildId;
}

export function computeRuntimeBuildId(repoRoot = getRepoRoot()): string {
  const entries = listRuntimeBuildPaths(repoRoot).map((relativePath) => ({
    relativePath,
    content: fs.readFileSync(path.join(repoRoot, relativePath)),
  }));
  return createRuntimeBuildId(entries);
}

export function createRuntimeBuildId(entries: RuntimeBuildEntry[]): string {
  const hash = crypto.createHash('sha256');
  const orderedEntries = [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );

  for (const entry of orderedEntries) {
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf-8'));
    hash.update('\0');
  }

  return hash.digest('hex');
}

export function listRuntimeBuildPaths(repoRoot = getRepoRoot()): string[] {
  const paths = ['package.json', ...walkRuntimeBuildSourceTree(path.join(repoRoot, 'src'), repoRoot)];
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function walkRuntimeBuildSourceTree(currentDir: string, repoRoot: string): string[] {
  if (!fs.existsSync(currentDir)) {
    return [];
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const collected: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkRuntimeBuildSourceTree(absolutePath, repoRoot));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
    if (shouldIncludeRuntimeBuildPath(relativePath)) {
      collected.push(relativePath);
    }
  }

  return collected;
}

function shouldIncludeRuntimeBuildPath(relativePath: string): boolean {
  return /^src\/.+\.ts$/i.test(relativePath) && !/\.test\.ts$/i.test(relativePath);
}
