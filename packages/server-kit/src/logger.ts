import { pino, type Logger } from 'pino';
import type { BaseConfig } from './config';
import { currentRequestId } from './context';

export type { Logger };

/**
 * Structured JSON logs (one object per line). Every line carries `service`, and lines written
 * inside a request also carry `reqId` — grep for it to follow a request across services:
 *   tilt logs | grep <reqId>
 */
export function createLogger(config: Pick<BaseConfig, 'SERVICE_NAME' | 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const reqId = currentRequestId();
      return reqId ? { reqId } : {};
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password'],
      censor: '[redacted]',
    },
  });
}
