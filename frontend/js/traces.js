// Rastro de cada operação: as etapas que a página consegue comprovar, na ordem em que acontecem.
import * as api from './api.js';
import * as topo from './topology.js';
import { health, metrics, queue, queues } from './monitor.js';
import { copyText, fmtClock, fmtMs, h } from './util.js';

const MAX_TRACES = 40;
const GIVE_UP_MS = 15 * 60 * 1000;
const jobs = new Set();
const handlers = { asyncResolved: () => {}, showCorrelation: () => {} };
let loop = null;

export function onAsyncResolved(fn) {
  handlers.asyncResolved = fn;
}

export function onShowCorrelation(fn) {
  handlers.showCorrelation = fn;
}

const list = () => document.getElementById('trace-list');

function trim() {
  const items = list().children;
  while (items.length > MAX_TRACES) {
    const last = items[items.length - 1];
    for (const job of jobs) {
      if (job.trace.el === last) jobs.delete(job);
    }
    last.remove();
  }
}

export class Trace {
  constructor({ title, subtitle, correlationId }) {
    this.correlationId = correlationId;
    this.startedAt = performance.now();
    this.steps = new Map();
    // Animação da chamada síncrona; a parte assíncrona só é desenhada depois dela.
    this.animation = Promise.resolve();
    this.stepsEl = h('ol', { class: 'steps' });

    const grep = `docker compose logs api-gateway events-service tickets-service logs-service | grep ${correlationId}`;
    this.el = h('li', { class: 'trace running' },
      h('div', { class: 'trace-head' },
        h('div', { class: 'trace-title' },
          h('strong', {}, title),
          subtitle ? h('span', { class: 'trace-subtitle' }, subtitle) : null),
        h('div', { class: 'trace-meta' },
          h('time', {}, fmtClock()),
          h('code', { class: 'cid', title: 'X-Correlation-Id enviado pela página' }, correlationId),
          h('button', {
            class: 'btn tiny ghost',
            title: `Copia: ${grep}`,
            onclick: () => copyText(grep),
          }, 'grep'),
          h('button', {
            class: 'btn tiny ghost',
            title: 'Lista os registros com este correlation_id no logs-service',
            onclick: () => handlers.showCorrelation(correlationId),
          }, 'logs'))),
      this.stepsEl);
    list().prepend(this.el);
    trim();
  }

  /**
   * Cria ou atualiza uma etapa. state: pending, waiting, ok, warn ou error. at: instante real da
   * etapa, em ms desde o início; sem ele, vale o momento da chamada.
   */
  step(key, { label, detail, state, at }) {
    let row = this.steps.get(key);
    if (!row) {
      row = {
        li: h('li', { class: 'step' }),
        icon: h('span', { class: 'step-icon', 'aria-hidden': 'true' }),
        time: h('span', { class: 'step-time' }),
        label: h('span', { class: 'step-label' }),
        detail: h('span', { class: 'step-detail' }),
      };
      row.li.append(row.icon, row.time, h('div', { class: 'step-body' }, row.label, row.detail));
      this.steps.set(key, row);
      this.stepsEl.append(row.li);
    }
    row.li.dataset.state = state;
    row.time.textContent = `+${fmtMs(at ?? performance.now() - this.startedAt)}`;
    if (label !== undefined) row.label.textContent = label;
    if (detail !== undefined) row.detail.replaceChildren(...[detail].flat());
  }

  finish(state) {
    this.el.classList.remove('running');
    this.el.classList.add(state);
  }
}

export function create(options) {
  return new Trace(options);
}

/** Linha avulsa, como um contêiner que saiu do ar ou voltou. */
export function note(text, tone = 'info') {
  list().prepend(h('li', { class: `trace note ${tone}` }, h('time', {}, fmtClock()), h('span', {}, text)));
  trim();
}

export function clear() {
  jobs.clear();
  list().replaceChildren();
}

const ASYNC_LABEL = 'outbox → rabbitmq → logs-service → logs-db';

/**
 * Acompanha a parte assíncrona: consulta o logs-service pelo correlation_id até os registros
 * chegarem. expected é o número de atividades da operação, ou null se não for conhecido. origins
 * são os serviços cujas outbox publicam (events, tickets), e waitsFor diz se a operação depende
 * de outro serviço consumir uma fila antes: 'events' (devolução de vaga) ou 'tickets' (cascata).
 */
export function watchAsync(trace, expected, { label = ASYNC_LABEL, origins = ['tickets'], waitsFor = null } = {}) {
  const job = {
    trace,
    expected,
    origins,
    waitsFor,
    startedAt: Date.now(),
    nextAt: Date.now() + 900,
    phase: 'outbox',
    lastCount: -1,
    busy: false,
  };
  trace.step('async', {
    label,
    detail: 'aguardando a publicação: a outbox é lida a cada 1 s',
    state: 'waiting',
  });
  jobs.add(job);
  loop ??= setInterval(tick, 250);
}

function tick() {
  if (jobs.size === 0) {
    clearInterval(loop);
    loop = null;
    return;
  }
  const now = Date.now();
  for (const job of jobs) {
    if (!job.busy && now >= job.nextAt) void poll(job);
  }
}

async function poll(job) {
  job.busy = true;
  const cid = encodeURIComponent(job.trace.correlationId);
  const result = await api.request(
    'GET',
    `/logs?correlation_id=${cid}&include_archived=true&order=asc&limit=500`,
    { timeoutMs: 4000 },
  );
  const age = Date.now() - job.startedAt;

  if (result.ok && Array.isArray(result.data)) {
    const entries = result.data.filter((entry) => entry.source !== 'manual');
    const count = entries.length;
    const complete = job.expected ? count >= job.expected : count > 0 && count === job.lastCount;
    if (complete) {
      resolve(job, entries);
      return;
    }
    job.lastCount = count;
    if (count > 0) {
      job.trace.step('async', {
        detail: `${count} de ${job.expected ?? '?'} registros já gravados; aguardando o restante`,
        state: 'waiting',
      });
    } else {
      describeWaiting(job, age);
    }
  } else {
    describeWaiting(job, age);
  }

  if (age > GIVE_UP_MS) {
    job.trace.step('async', { detail: 'a página parou de acompanhar após 15 min', state: 'warn' });
    job.trace.finish('warn');
    jobs.delete(job);
    return;
  }
  job.nextAt = Date.now() + (age < 8000 ? 600 : age < 60000 ? 2000 : 4000);
  job.busy = false;
}

const OUTBOX_DB = { events: 'events-db', tickets: 'tickets-db' };

function describeWaiting(job, age) {
  let detail;
  if (health.rabbitmq === 'down') {
    const pending = metrics.outboxPending > 0 ? ` (${metrics.outboxPending} pendente(s))` : '';
    const where = job.origins.map((origin) => OUTBOX_DB[origin]).join(' e ');
    detail = `rabbitmq fora do ar: as mensagens esperam na outbox, dentro do ${where}${pending}`;
  } else if (job.waitsFor === 'events' && (health.events === 'down' || queues['events.spot-releases']?.consumers === 0)) {
    detail = 'events-service fora do ar: o pedido de devolução da vaga espera na fila events.spot-releases';
  } else if (job.waitsFor === 'tickets' && (health.tickets === 'down' || queues['tickets.event-updates']?.consumers === 0)) {
    detail = 'tickets-service fora do ar: o aviso de evento cancelado espera na fila tickets.event-updates';
  } else if (health.logs === 'down' || (queue.known && queue.consumers === 0)) {
    if (queue.total > 0) {
      if (job.phase === 'outbox') {
        job.phase = 'queued';
        void afterCall(job.trace).then(() => topo.animatePublish(job.origins));
      }
      detail = `publicadas: a fila logs.activity tem ${queue.total} mensagem(ns) esperando o logs-service, que está fora do ar`;
    } else {
      detail = 'logs-service fora do ar: aguardando a publicação na fila logs.activity';
    }
  } else {
    detail = age < 4000
      ? 'aguardando a publicação: a outbox é lida a cada 1 s'
      : 'aguardando a entrega pelo RabbitMQ';
  }
  job.trace.step('async', { detail, state: 'waiting' });
}

/** Espera a animação da chamada síncrona terminar, para a parte assíncrona não passar à frente. */
function afterCall(trace) {
  return Promise.race([trace.animation, new Promise((r) => setTimeout(r, 6000))]);
}

const NODE_OF_SOURCE = { 'events-service': 'events', 'tickets-service': 'tickets' };
const CASCADE_REASONS = new Set(['event_cancelled', 'event_deleted']);
const TO_LOGS = ['rabbitmq', 'logs', 'logsdb'];

/**
 * Caminho que o registro percorreu até o logs-db. A devolução de vaga passa antes pelo
 * events-service, e o cancelamento em cascata, pelo tickets-service, cada um pela sua fila.
 */
function asyncPath(entry, phase) {
  const origin = NODE_OF_SOURCE[entry.source];
  if (!origin) return null;
  if (phase === 'queued') return TO_LOGS;
  if (entry.action === 'event.spot_released') {
    return ['tickets', 'rabbitmq', 'events', 'eventsdb', 'events', ...TO_LOGS];
  }
  if (entry.action === 'ticket.cancelled' && CASCADE_REASONS.has(entry.data?.reason)) {
    return ['events', 'rabbitmq', 'tickets', 'ticketsdb', 'tickets', ...TO_LOGS];
  }
  return [origin, ...TO_LOGS];
}

// O Python grava microssegundos; o Date do navegador só garante milissegundos.
const toMs = (iso) => Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1'));

function resolve(job, entries) {
  jobs.delete(job);
  const latencies = entries
    .map((entry) => toMs(entry.created_at) - toMs(entry.occurred_at))
    .filter(Number.isFinite);
  const latency = latencies.length ? Math.max(0, ...latencies) : null;

  const counts = new Map();
  for (const entry of entries) counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  const chips = [...counts].map(([action, n]) =>
    h('code', { class: 'chip' }, n > 1 ? `${action} ×${n}` : action));

  const when = latency === null ? '' : `, ${fmtMs(latency)} depois da mudança`;
  const fromQueue = job.phase === 'queued' ? ' (entregue quando o logs-service voltou)' : '';
  job.trace.step('async', {
    detail: [
      h('span', {}, `${entries.length} registro(s) gravado(s) no logs-db${when}${fromQueue}`),
      h('span', { class: 'chips' }, chips),
    ],
    state: 'ok',
  });
  job.trace.finish('ok');
  const paths = entries.map((entry) => asyncPath(entry, job.phase)).filter(Boolean);
  void afterCall(job.trace).then(() => topo.animateAsync(paths));
  handlers.asyncResolved();
}
