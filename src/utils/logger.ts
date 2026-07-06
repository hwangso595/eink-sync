/**
 * Simple structured logger for the bridge plugin.
 *
 * All log output goes to the console (visible in Obsidian's developer tools).
 * No external log services -- privacy first.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_PREFIX = '[eink-sync]';

let currentLevel: LogLevel = LogLevel.INFO;

/**
 * Patterns for secrets that must never reach the console, even with debug
 * logging on. Commands run over SSH can embed the Syncthing API key or a
 * password; logging them verbatim would leak credentials into the dev-tools
 * console (easily captured in screen-shares or bug reports).
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // curl -H 'X-API-Key: <token>'  (Syncthing REST)
  [/(X-API-Key:\s*)[^'"\s]+/gi, '$1***'],
  // SSHPASS=... env or sshpass -p <pw>
  [/(SSHPASS=)\S+/g, '$1***'],
  [/(sshpass\s+-p\s*)\S+/g, '$1***'],
  // --password <value> / --password=<value>
  [/(--password[=\s]+)\S+/gi, '$1***'],
];

/**
 * Scrub known secret patterns from a log message. Best-effort: it cannot mask
 * an arbitrary plaintext password it doesn't recognise, but it covers every
 * place this codebase interpolates a credential into a logged string.
 */
export function redactSecrets(message: string): string {
  let out = message;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Redact secrets from string and Error args (other types pass through). */
function redactArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === 'string') return redactSecrets(a);
    if (a instanceof Error) {
      const e = new Error(redactSecrets(a.message));
      if (a.stack) e.stack = redactSecrets(a.stack);
      return e;
    }
    return a;
  });
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(`${LOG_PREFIX} ${redactSecrets(message)}`, ...redactArgs(args));
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.INFO) {
      console.debug(`${LOG_PREFIX} ${redactSecrets(message)}`, ...redactArgs(args));
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(`${LOG_PREFIX} ${redactSecrets(message)}`, ...redactArgs(args));
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(`${LOG_PREFIX} ${redactSecrets(message)}`, ...redactArgs(args));
    }
  },
};
