// Rastro de cada operação: as etapas que a página consegue comprovar, na ordem em que acontecem.
import * as api from './api.js';
import * as topo from './topology.js';
import { health, queue, metrics } from './monitor.js';
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

    const grep = `docker compose logs api-gateway events-tickets-service logs-service | grep ${correlationId}`;
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
 * chegarem. expected é o número de atividades da operação, ou null se não for conhecido.
 */
export function watchAsync(trace, expected) {
  const job = {
    trace,
    expected,
    startedAt: Date.now(),
    nextAt: Date.now() + 900,
    phase: 'outbox',
    lastCount: -1,
    busy: false,
  };
  trace.step('async', {
    label: ASYNC_LABEL,
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

function describeWaiting(job, age) {
  let detail;
  if (health.rabbitmq === 'down') {
    const pending = metrics.outboxPending > 0 ? ` (${metrics.outboxPending} pendente(s))` : '';
    detail = `rabbitmq fora do ar: as mensagens esperam na outbox, dentro do events-tickets-db${pending}`;
  } else if (health.logs === 'down' || (queue.known && queue.consumers === 0)) {
    if (queue.total > 0) {
      if (job.phase === 'outbox') {
        job.phase = 'queued';
        void afterCall(job.trace).then(() => topo.animatePublish(job.expected ?? 1));
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
  const phase = job.phase;
  void afterCall(job.trace).then(() => topo.animateAsync(phase, entries.length));
  handlers.asyncResolved();
}
