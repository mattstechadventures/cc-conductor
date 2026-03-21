type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  console.log(`[${timestamp()}] [${level}] ${message}${extra}`);
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log('DEBUG', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log('INFO', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('WARN', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('ERROR', msg, ...args),
};
