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

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(`${LOG_PREFIX} ${message}`, ...args);
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.INFO) {
      console.debug(`${LOG_PREFIX} ${message}`, ...args);
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(`${LOG_PREFIX} ${message}`, ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (currentLevel <= LogLevel.ERROR) {
      console.error(`${LOG_PREFIX} ${message}`, ...args);
    }
  },
};
