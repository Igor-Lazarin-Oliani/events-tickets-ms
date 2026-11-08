import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'X-Correlation-Id';
export const SERVICE_NAME = process.env.SERVICE_NAME ?? 'tickets-service';

const MAX_CORRELATION_ID_LENGTH = 128;
const correlationStorage = new AsyncLocalStorage<string>();

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

export function getCorrelationId(): string {
  return correlationStorage.getStore() ?? '-';
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.header(CORRELATION_HEADER) || randomUUID()).slice(
    0,
    MAX_CORRELATION_ID_LENGTH,
  );
  res.setHeader(CORRELATION_HEADER, correlationId);
  correlationStorage.run(correlationId, next);
}

export function logEvent(
  tag: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = 'INFO',
): void {
  const payload = JSON.stringify({
    service: SERVICE_NAME,
    correlation_id: getCorrelationId(),
    ...fields,
  });
  console.log(`${new Date().toISOString()} ${level} [${tag}] ${payload}`);
}
