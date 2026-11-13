// Cliente HTTP da página. Todas as chamadas vão para a mesma origem, o api-gateway (porta 8080).

// Credenciais do ambiente local, as mesmas do docker-compose.yml; a API do RabbitMQ exige login.
const RABBITMQ_AUTH = `Basic ${btoa('events_tickets:events_tickets_pass')}`;

const REASONS = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Faz a chamada e devolve sempre um resultado, nunca lança exceção:
 * { ok, status, reason, data, total, ms, correlationId, reachedService, networkError }.
 * total vem do cabeçalho X-Total-Count das listagens paginadas, ou é null.
 */
export async function request(method, path, { body, correlationId, headers = {}, timeoutMs = 15000 } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, cache: 'no-store' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (correlationId) {
    init.headers['X-Correlation-Id'] = correlationId;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  const startedAt = performance.now();
  try {
    const response = await fetch(path, init);
    const text = await response.text();
    const ms = performance.now() - startedAt;
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    const totalHeader = response.headers.get('X-Total-Count');
    return {
      ok: response.ok,
      status: response.status,
      reason: REASONS[response.status] ?? '',
      data,
      total: totalHeader === null ? null : Number(totalHeader),
      ms,
      correlationId: response.headers.get('X-Correlation-Id') ?? correlationId ?? null,
      reachedService: reachedService(response.status, data),
      networkError: false,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      reason: 'sem resposta',
      data: null,
      total: null,
      ms: performance.now() - startedAt,
      correlationId: correlationId ?? null,
      reachedService: false,
      networkError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * O gateway responde sozinho com {"message": ...}: 503 quando não alcança o serviço e 404 fora da
 * lista de rotas. Os serviços sempre mandam outros campos (statusCode, error ou detail).
 */
function reachedService(status, data) {
  const fromGateway =
    (status === 503 || status === 404) &&
    data !== null &&
    typeof data === 'object' &&
    Object.keys(data).length === 1 &&
    'message' in data;
  return !fromGateway;
}

/** Mensagem de erro legível: NestJS usa "message" (texto ou lista); FastAPI usa "detail". */
export function errorMessage(result) {
  if (result.networkError) return 'Sem resposta do api-gateway';
  const data = result.data;
  if (data && typeof data === 'object') {
    const raw = data.message ?? data.detail;
    if (Array.isArray(raw)) {
      return raw
        .map((item) => {
          if (typeof item === 'string') return item;
          const field = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : '';
          return field ? `${field}: ${item.msg}` : (item.msg ?? JSON.stringify(item));
        })
        .join('; ');
    }
    if (typeof raw === 'string') return raw;
  }
  if (typeof data === 'string' && data) return data.slice(0, 200);
  return `HTTP ${result.status}`;
}

export function statusLine(result) {
  return result.networkError ? 'sem resposta' : `${result.status} ${result.reason}`.trim();
}

export function rabbitQueue(name) {
  return request('GET', `/rabbitmq/api/queues/%2F/${encodeURIComponent(name)}`, {
    headers: { Authorization: RABBITMQ_AUTH },
    timeoutMs: 4000,
  });
}

export function prometheusQuery(query) {
  return request('GET', `/prometheus/api/v1/query?query=${encodeURIComponent(query)}`, { timeoutMs: 4000 });
}
