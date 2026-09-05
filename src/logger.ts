/* Minimal leveled logger. No dependency, no transport, no persistence. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const prefix = `[${level.toUpperCase()}]`.padEnd(7);
  if (extra === undefined) console.log(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
  /** Section heading, always shown. */
  step: (m: string) => console.log(`\n=== ${m} ===`),
};
