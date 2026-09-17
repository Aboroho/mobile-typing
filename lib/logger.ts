import { env } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Redaction is centralised: no log line may contain a password, token, secret
 * code or message body. Callers pass structured fields; anything matching a
 * sensitive key is replaced before serialisation.
 */
const SENSITIVE_KEYS = [
  'password',
  'confirmPassword',
  'token',
  'idToken',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secretCode',
  'code',
  'digest',
  'challengeToken',
  'text',
  'body',
  'privateKey',
  'credential',
  'bytes',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()))
      ? '[redacted]'
      : redact(item, depth + 1);
  }
  return out;
}

function write(level: Exclude<Level, 'silent'>, message: string, fields?: Record<string, unknown>): void {
  const threshold = ORDER[env().LOG_LEVEL] ?? ORDER.info;
  if (ORDER[level] < threshold) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(fields ? { fields: redact(fields) } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
  child: (context: Record<string, unknown>) => ({
    debug: (m: string, f?: Record<string, unknown>) => write('debug', m, { ...context, ...f }),
    info: (m: string, f?: Record<string, unknown>) => write('info', m, { ...context, ...f }),
    warn: (m: string, f?: Record<string, unknown>) => write('warn', m, { ...context, ...f }),
    error: (m: string, f?: Record<string, unknown>) => write('error', m, { ...context, ...f }),
  }),
};

export type Logger = typeof logger;
