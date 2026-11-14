// Diagrama dos componentes e animação das chamadas. Só desenha: quem decide o que animar é
// quem recebeu a evidência (resposta HTTP, registro no logs-service, contador do RabbitMQ).
import { s, sleep } from './util.js';

const VIEW_W = 1160;
const VIEW_H = 515;
const NODE_H = 64;

export const NODES = {
  browser: {
    x: 72, y: 265, w: 124, title: 'Navegador', sub: 'aplicação web',
    tip: 'Esta página. Toda chamada sai daqui e entra pela única porta publicada, a 8080 do api-gateway.',
  },
  gateway: {
    x: 250, y: 265, w: 140, title: 'api-gateway', sub: 'NGINX · :8080',
    tip: 'Única entrada do sistema. Encaminha só as rotas permitidas, esconde a topologia e propaga o X-Correlation-Id.',
  },
  events: {
    x: 520, y: 85, w: 210, title: 'events-service', sub: 'NestJS · JavaScript',
    tip: 'Eventos e vagas. Reserva a vaga por HTTP, devolve ao consumir a fila events.spot-releases e avisa o tickets-service quando um evento é cancelado.',
  },
  tickets: {
    x: 520, y: 265, w: 210, title: 'tickets-service', sub: 'NestJS · TypeScript',
    tip: 'Inscrições, ingressos e check-in. Reserva a vaga no events-service antes de salvar o ingresso e pede a devolução pela outbox.',
  },
  logs: {
    x: 520, y: 445, w: 210, title: 'logs-service', sub: 'FastAPI · Python',
    tip: 'Registro de atividades: consome a fila logs.activity, grava cada mensagem uma única vez e oferece o CRUD de triagem.',
  },
  rabbitmq: {
    x: 780, y: 175, w: 170, title: 'rabbitmq', sub: '3 filas',
    tip: 'Broker de mensagens. Filas logs.activity (atividades), tickets.event-updates (eventos cancelados) e events.spot-releases (devolução de vagas).',
  },
  eventsdb: {
    x: 1030, y: 85, w: 180, db: true, title: 'events-db', sub: 'PostgreSQL 16',
    tip: 'Banco exclusivo do events-service: eventos, reservas de vaga por ingresso e a outbox.',
  },
  ticketsdb: {
    x: 1030, y: 265, w: 180, db: true, title: 'tickets-db', sub: 'PostgreSQL 16',
    tip: 'Banco exclusivo do tickets-service: ingressos, eventos encerrados e a outbox.',
  },
  logsdb: {
    x: 1030, y: 445, w: 180, db: true, title: 'logs-db', sub: 'PostgreSQL 16',
    tip: 'Banco exclusivo do logs-service: a tabela activity_logs.',
  },
  prometheus: {
    x: 780, y: 360, w: 170, title: 'prometheus', sub: 'métricas',
    tip: 'Coleta /metrics dos três serviços a cada 5 s.',
  },
  grafana: {
    x: 1030, y: 360, w: 180, title: 'grafana', sub: 'painéis',
    tip: 'Painel provisionado, que consulta o Prometheus com PromQL.',
  },
};

// via: pontos intermediários, para a linha contornar os nós. labelAt: posição do rótulo.
const EDGES = [
  { from: 'browser', to: 'gateway', kind: 'http', label: ':8080', labelAt: [156, 257] },
  { from: 'gateway', to: 'events', kind: 'http', via: [[345, 265], [345, 85]] },
  { from: 'gateway', to: 'tickets', kind: 'http', label: 'HTTP', labelAt: [367, 257] },
  { from: 'gateway', to: 'logs', kind: 'http', via: [[345, 265], [345, 445]] },
  { from: 'events', to: 'eventsdb', kind: 'sql', label: 'SQL', labelAt: [880, 77] },
  { from: 'tickets', to: 'ticketsdb', kind: 'sql', label: 'SQL', labelAt: [880, 257] },
  { from: 'logs', to: 'logsdb', kind: 'sql', label: 'SQL', labelAt: [880, 437] },
  { from: 'tickets', to: 'events', kind: 'rest', label: 'REST · reserva', labelAt: [474, 179] },
  { from: 'tickets', to: 'logs', kind: 'rest', label: 'REST · histórico', labelAt: [470, 359] },
  { from: 'events', to: 'logs', kind: 'rest', via: [[390, 105], [390, 425]], label: 'REST', labelAt: [367, 352] },
  { from: 'events', to: 'rabbitmq', kind: 'amqp', label: 'AMQP', labelAt: [672, 120] },
  { from: 'tickets', to: 'rabbitmq', kind: 'amqp', label: 'AMQP', labelAt: [706, 224] },
  { from: 'rabbitmq', to: 'logs', kind: 'amqp', label: 'AMQP', labelAt: [706, 292] },
  { from: 'prometheus', to: 'events', kind: 'scrape' },
  { from: 'prometheus', to: 'tickets', kind: 'scrape' },
  { from: 'prometheus', to: 'logs', kind: 'scrape', label: 'coleta /metrics', labelAt: [668, 427] },
  { from: 'grafana', to: 'prometheus', kind: 'scrape', label: 'PromQL', labelAt: [905, 352] },
];

const nodeEls = {};
// Cada aresta é guardada nos dois sentidos, com os pontos na ordem do percurso.
const edgeEls = new Map();
const litCount = new Map();
let packetLayer;

export function initTopology(svg) {
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  const edgeLayer = s('g', { class: 'edges' });
  const labelLayer = s('g', { class: 'edge-labels' });
  packetLayer = s('g', { class: 'packets' });
  const nodeLayer = s('g', { class: 'nodes' });

  for (const edge of EDGES) {
    const a = NODES[edge.from];
    const b = NODES[edge.to];
    const points = [[a.x, a.y], ...(edge.via ?? []), [b.x, b.y]];
    const g = s('g', { class: `edge ${edge.kind}` },
      s('polyline', { class: 'wire', fill: 'none', points: points.map((p) => p.join(',')).join(' ') }));
    edgeLayer.append(g);
    edgeEls.set(`${edge.from}>${edge.to}`, { g, points });
    edgeEls.set(`${edge.to}>${edge.from}`, { g, points: [...points].reverse() });

    if (edge.label) {
      const [x, y] = edge.labelAt;
      labelLayer.append(s('text', { class: 'edge-label', x, y, 'text-anchor': 'middle' }, edge.label));
    }
  }

  for (const [id, node] of Object.entries(NODES)) {
    nodeLayer.append(renderNode(id, node));
  }
  svg.replaceChildren(edgeLayer, labelLayer, packetLayer, nodeLayer);
}

function renderNode(id, node) {
  const w = node.w;
  const top = node.db ? 4 : 0;
  const g = s('g', {
    class: `node${node.db ? ' db' : ''}`,
    'data-state': 'unknown',
    transform: `translate(${node.x - w / 2} ${node.y - NODE_H / 2})`,
  });
  if (node.db) {
    g.append(
      s('path', { class: 'node-box', d: `M0 7 V${NODE_H - 7} A${w / 2} 7 0 0 0 ${w} ${NODE_H - 7} V7` }),
      s('ellipse', { class: 'node-box', cx: w / 2, cy: 7, rx: w / 2, ry: 7 }),
    );
  } else {
    g.append(s('rect', { class: 'node-box', width: w, height: NODE_H, rx: 10 }));
  }
  const detail = s('text', { class: 'node-detail', x: 12, y: 55 + top });
  const badgeText = s('text', { 'text-anchor': 'middle', y: 4 });
  const badgeBox = s('rect', { y: -10, height: 20, rx: 10 });
  const badge = s('g', { class: 'node-badge', transform: `translate(${w} 0)`, visibility: 'hidden' }, badgeBox, badgeText);
  g.append(
    s('circle', { class: 'node-dot', cx: w - 13, cy: 15 + top, r: 5.5 }),
    s('text', { class: 'node-title', x: 12, y: 22 + top }, node.title),
    s('text', { class: 'node-sub', x: 12, y: 39 + top }, node.sub),
    detail,
    badge,
    s('title', {}, node.tip),
  );
  nodeEls[id] = { g, detail, badge, badgeText, badgeBox };
  return g;
}

/** state: up, down, warn ou unknown. */
export function setNode(id, state, detail, tone) {
  const el = nodeEls[id];
  if (!el) return;
  el.g.dataset.state = state;
  if (detail !== undefined) {
    el.detail.textContent = detail;
    el.detail.setAttribute('class', `node-detail${tone ? ` ${tone}` : ''}`);
  }
}

export function setBadge(id, text) {
  const el = nodeEls[id];
  if (!el) return;
  if (!text) {
    el.badge.setAttribute('visibility', 'hidden');
    return;
  }
  const width = 16 + String(text).length * 7.6;
  el.badgeText.textContent = text;
  el.badgeText.setAttribute('x', String(-width / 2 + 4));
  el.badgeBox.setAttribute('x', String(-width + 4));
  el.badgeBox.setAttribute('width', String(width));
  el.badge.setAttribute('visibility', 'visible');
}

export function setEdgeBroken(from, to, broken) {
  edgeEls.get(`${from}>${to}`)?.g.classList.toggle('broken', broken);
}

function light(edge, kind, delta) {
  if (!edge) return;
  const count = (litCount.get(edge) ?? 0) + delta;
  litCount.set(edge, count);
  if (delta > 0) edge.dataset.lit = kind;
  edge.classList.toggle('lit', count > 0);
}

function pulse(id, kind) {
  const g = nodeEls[id]?.g;
  if (!g) return;
  g.dataset.pulse = kind;
  g.classList.remove('pulse');
  void g.getBBox();
  g.classList.add('pulse');
  clearTimeout(g._pulseTimer);
  g._pulseTimer = setTimeout(() => g.classList.remove('pulse'), 650);
}

function failMark(x, y) {
  const mark = s('text', { class: 'fail-mark', x, y: y + 6, 'text-anchor': 'middle' }, '✕');
  packetLayer.append(mark);
  setTimeout(() => mark.remove(), 1400);
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Ponto a uma distância do início do percurso, segmento a segmento. */
function pointAt(points, lengths, distance) {
  let rest = distance;
  for (let i = 0; i < lengths.length; i++) {
    if (rest <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? Math.min(1, rest / lengths[i]) : 1;
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      return [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f];
    }
    rest -= lengths[i];
  }
  return points[points.length - 1];
}

/** Um pacote indo de um nó a outro. abortAt (0 a 1) para o pacote no meio do caminho, com um ✕. */
export function hop(from, to, kind, { scale = 1, abortAt = null, radius = 6.5 } = {}) {
  if (document.hidden) return Promise.resolve();
  const entry = edgeEls.get(`${from}>${to}`);
  const points = entry?.points ?? [[NODES[from].x, NODES[from].y], [NODES[to].x, NODES[to].y]];
  const lengths = points.slice(1).map(([x, y], i) => Math.hypot(x - points[i][0], y - points[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const duration = (240 + total * 0.8) * scale;
  const end = abortAt ?? 1;
  const [startX, startY] = points[0];
  const dot = s('circle', { class: `packet ${kind}`, r: radius, cx: startX, cy: startY });
  packetLayer.append(dot);
  light(entry?.g, kind, +1);

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const [x, y] = pointAt(points, lengths, ease(t) * end * total);
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      dot.remove();
      light(entry?.g, kind, -1);
      if (abortAt !== null) {
        failMark(x, y);
      } else {
        pulse(to, kind);
      }
      resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function walk(path, kinds, opts) {
  for (let i = 0; i < path.length - 1; i++) {
    await hop(path[i], path[i + 1], kinds[i] ?? kinds[kinds.length - 1], opts);
  }
}

/** Tipo de cada salto de um caminho assíncrono: SQL até um banco, AMQP de ou para o broker. */
function kindOf(from, to) {
  if (to.endsWith('db') || from.endsWith('db')) return 'sql';
  return 'amqp';
}

const db = (service) => ({ path: [service, `${service}db`], kinds: ['sql'] });
const RESERVE = { path: ['tickets', 'events', 'eventsdb'], kinds: ['rest', 'sql'] };

/** Mensagem de erro dos serviços NestJS (texto) ou FastAPI (detail). */
const messageOf = (r) => (typeof r.data?.message === 'string' ? r.data.message : r.data?.detail);

function historyPlan(service) {
  return (r) => {
    if (r.status === 400) return [];
    if (r.status === 404) return [db(service)];
    if (r.status === 503) return [db(service), { path: [service, 'logs'], kinds: ['rest'], fail: true }];
    return [db(service), { path: [service, 'logs', 'logsdb'], kinds: ['rest', 'sql'] }];
  };
}

// Desvios que o serviço faz antes de responder: ir ao banco, reservar a vaga, consultar o logs-service.
const ROUTES = {
  events: { entry: 'events', plan: (r) => (r.status === 400 ? [] : [db('events')]) },
  tickets: { entry: 'tickets', plan: (r) => (r.status === 400 ? [] : [db('tickets')]) },
  logs: { entry: 'logs', plan: (r) => (r.status === 422 ? [] : [db('logs')]) },
  issue: {
    entry: 'tickets',
    plan: (r) => {
      const message = messageOf(r);
      if (r.status === 400 && Array.isArray(r.data?.message)) return [];
      if (r.status === 409 && message === 'Participant already registered for this event') return [db('tickets')];
      if (r.status === 503 && message === 'Events service unavailable') {
        return [db('tickets'), { path: ['tickets', 'events'], kinds: ['rest'], fail: true }];
      }
      if (r.ok) return [db('tickets'), RESERVE, db('tickets')];
      return [db('tickets'), RESERVE];
    },
  },
  eventHistory: { entry: 'events', plan: historyPlan('events') },
  ticketHistory: { entry: 'tickets', plan: historyPlan('tickets') },
};

function resultKind(result) {
  if (result.ok) return 'ok';
  if (result.status >= 400 && result.status < 500) return 'warn';
  return 'error';
}

/**
 * Anima uma chamada HTTP: navegador → gateway → serviço, os desvios do serviço e a volta, na cor
 * do resultado. A ida começa junto com a chamada; o resto espera a resposta real.
 */
export async function animateCall(routeName, resultPromise, { light: isRead = false, scale = 1 } = {}) {
  const route = ROUTES[routeName];
  const kind = isRead ? 'read' : 'http';
  const opts = { scale: isRead ? scale * 0.6 : scale, radius: isRead ? 4.5 : 6.5 };

  await hop('browser', 'gateway', kind, opts);
  const result = await resultPromise;

  if (result.networkError) {
    pulse('browser', 'error');
    return result;
  }
  if (!result.reachedService) {
    await hop('gateway', route.entry, 'error', { ...opts, abortAt: 0.55 });
    await hop('gateway', 'browser', 'error', opts);
    return result;
  }

  await hop('gateway', route.entry, kind, opts);
  for (const detour of route.plan(result)) {
    if (detour.fail) {
      await hop(detour.path[0], detour.path[1], detour.kinds[0], { ...opts, abortAt: 0.55 });
      continue;
    }
    const kinds = isRead ? detour.kinds.map(() => 'read') : detour.kinds;
    await walk(detour.path, kinds, opts);
    await walk([...detour.path].reverse(), [...kinds].reverse(), opts);
  }
  const back = isRead && result.ok ? 'read' : resultKind(result);
  await walk([route.entry, 'gateway', 'browser'], [back], opts);
  return result;
}

/**
 * Caminhos assíncronos já comprovados pelos registros no logs-service. Cada caminho é uma lista de
 * nós, como ['tickets', 'rabbitmq', 'events', 'eventsdb', 'events', 'rabbitmq', 'logs', 'logsdb'].
 */
export async function animateAsync(paths) {
  await Promise.all(paths.slice(0, 4).map(async (path, i) => {
    await sleep(i * 150);
    for (let j = 0; j < path.length - 1; j++) {
      await hop(path[j], path[j + 1], kindOf(path[j], path[j + 1]));
    }
  }));
}

/** Mensagens publicadas que ficaram paradas na fila, sem consumidor. */
export async function animatePublish(origins) {
  await Promise.all(origins.slice(0, 4).map(async (origin, i) => {
    await sleep(i * 150);
    await hop(origin, 'rabbitmq', 'amqp');
  }));
}

/** Coleta do Prometheus, confirmada pela métrica up=1. */
export function animateScrape(targets) {
  for (const target of targets) {
    void hop('prometheus', target, 'scrape', { scale: 1.6, radius: 4 });
  }
}
