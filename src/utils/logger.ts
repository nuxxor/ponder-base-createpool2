/**
 * Centralized Logger using Pino
 *
 * Environment variables:
 * - LOG_LEVEL: trace|debug|info|warn|error|fatal (default: info)
 * - LOG_PRETTY: true|false (default: false in production, true in dev)
 * - LOG_TO_FILE: true|false (default: false)
 */

import pino from "pino";
import * as fs from "fs";
import * as path from "path";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOG_PRETTY = process.env.LOG_PRETTY === "true" || process.env.NODE_ENV === "development";
const LOG_TO_FILE = process.env.LOG_TO_FILE === "true";

// Create logs directory if logging to file
const logsDir = path.join(process.cwd(), "logs");
if (LOG_TO_FILE && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Configure transport
const transport = LOG_PRETTY
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
        singleLine: false,
      },
    }
  : undefined;

// Create base logger
export const logger = pino({
  level: LOG_LEVEL,
  transport,
  ...(LOG_TO_FILE && {
    // If logging to file, use multistream
    transport: {
      targets: [
        // Console output
        ...(LOG_PRETTY ? [{
          target: "pino-pretty",
          level: LOG_LEVEL,
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        }] : [{
          target: "pino/file",
          level: LOG_LEVEL,
          options: { destination: 1 }, // stdout
        }]),
        // File output
        {
          target: "pino/file",
          level: "trace", // Log everything to file
          options: {
            destination: path.join(logsDir, `sniper-${new Date().toISOString().split('T')[0]}.log`),
            mkdir: true,
          },
        },
      ],
    },
  }),
});

/**
 * Create a child logger with a specific component name
 */
export function createLogger(component: string) {
  return logger.child({ component });
}

/**
 * Performance timing utility
 */
export function logTiming(logger: pino.Logger, label: string) {
  const start = Date.now();
  return () => {
    const duration = Date.now() - start;
    logger.debug({ duration, label }, `${label} completed in ${duration}ms`);
  };
}

export default logger;
