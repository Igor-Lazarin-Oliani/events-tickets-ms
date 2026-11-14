import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'X-Correlation-Id';
export const SERVICE_NAME = process.env.SERVICE_NAME ?? 'events-service';

const MAX_CORRELATION_ID_LENGTH = 128;
const correlationStorage = new AsyncLocalStorage();

export function getCorrelationId() {
  return correlationStorage.getStore() ?? '-';
}

/** Reaproveita o X-Correlation-Id do gateway ou do tickets-service, ou gera um novo. */
export function correlationMiddleware(req, res, next) {
  const correlationId = (req.header(CORRELATION_HEADER) || randomUUID()).slice(
    0,
    MAX_CORRELATION_ID_LENGTH,
  );
  res.setHeader(CORRELATION_HEADER, correlationId);
  correlationStorage.run(correlationId, next);
}

export function runWithCorrelationId(correlationId, action) {
  return correlationStorage.run(correlationId.slice(0, MAX_CORRELATION_ID_LENGTH), action);
}

/** Log estruturado: data, nível, [TAG] e um JSON com o serviço e o correlation_id. */
export function logEvent(tag, fields = {}, level = 'INFO') {
  const payload = JSON.stringify({
    service: SERVICE_NAME,
    correlation_id: getCorrelationId(),
    ...fields,
  });
  console.log(`${new Date().toISOString()} ${level} [${tag}] ${payload}`);
}
