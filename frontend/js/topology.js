// Diagrama dos componentes e animação das chamadas. Só desenha: quem decide o que animar é
// quem recebeu a evidência (resposta HTTP, registro no logs-service, contador do RabbitMQ).
import { s, sleep } from './util.js';

const VIEW_W = 1040;
const VIEW_H = 382;
const NODE_H = 64;
const ROW = [40, 190, 340];

export const NODES = {
  browser: {
    x: 72, y: ROW[1], w: 130, title: 'Navegador', sub: 'aplicação web',
    tip: 'Esta página. Toda chamada sai daqui e entra pela única porta publicada, a 8080 do api-gateway.',
  },
  gateway: {
    x: 255, y: ROW[1], w: 150, title: 'api-gateway', sub: 'NGINX · :8080',
    tip: 'Única entrada do sistema. Encaminha só as rotas permitidas, esconde a topologia e propaga o X-Correlation-Id.',
  },
  core: {
    x: 495, y: ROW[0], w: 220, title: 'events-tickets-service', sub: 'NestJS · TypeScript',
    tip: 'Eventos, vagas, ingressos e check-in. Cada mudança e suas atividades são gravadas na mesma transação (outbox).',
  },
  coredb: {
    x: 775, y: ROW[0], w: 180, db: true, title: 'events-tickets-db', sub: 'PostgreSQL 16',
    tip: 'Banco exclusivo do events-tickets-service: eventos, ingressos e a tabela outbox_messages.',
  },
  rabbitmq: {
    x: 700, y: ROW[1], w: 180, title: 'rabbitmq', sub: 'fila logs.activity',
    tip: 'Broker de mensagens. A outbox publica no exchange events-tickets.exchange, e a fila logs.activity entrega ao logs-service.',
  },
  logs: {
    x: 495, y: ROW[2], w: 220, title: 'logs-service', sub: 'FastAPI · Python',
    tip: 'Registro de atividades: consome a fila, grava cada mensagem uma única vez e oferece o CRUD de triagem.',
  },
  logsdb: {
    x: 775, y: ROW[2], w: 180, db: true, title: 'logs-db', sub: 'PostgreSQL 16',
    tip: 'Banco exclusivo do logs-service: a tabela activity_logs.',
  },
  prometheus: {
    x: 958, y: ROW[1], w: 150, title: 'prometheus', sub: 'métricas',
    tip: 'Coleta /metrics dos dois serviços a cada 5 s.',
  },
  grafana: {
    x: 958, y: ROW[2], w: 150, title: 'grafana', sub: 'painéis',
    tip: 'Painel provisionado, que consulta o Prometheus com PromQL.',
  },
};

const EDGES = [
  { from: 'browser', to: 'gateway', kind: 'http', label: ':8080', dy: -8 },
  { from: 'gateway', to: 'core', kind: 'http', label: 'HTTP', dx: -16 },
  { from: 'gateway', to: 'logs', kind: 'http', label: 'HTTP', dx: -16 },
  { from: 'core', to: 'coredb', kind: 'sql', label: 'SQL', dy: -8 },
  { from: 'logs', to: 'logsdb', kind: 'sql', label: 'SQL', dy: -8 },
  { from: 'core', to: 'rabbitmq', kind: 'amqp', label: 'AMQP · publica (outbox)', dx: 52 },
  { from: 'rabbitmq', to: 'logs', kind: 'amqp', label: 'AMQP · consome', dx: 40 },
  { from: 'core', to: 'logs', kind: 'rest', label: 'REST · histórico' },
  { from: 'prometheus', to: 'core', kind: 'scrape', label: 'coleta /metrics', t: 0.24, dy: -6 },
  { from: 'prometheus', to: 'logs', kind: 'scrape', label: 'coleta /metrics', t: 0.24, dy: 14 },
  { from: 'grafana', to: 'prometheus', kind: 'scrape', label: 'PromQL' },
];

const nodeEls = {};
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
    const g = s('g', { class: `edge ${edge.kind}` },
      s('line', { class: 'wire', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    edgeLayer.append(g);
    edgeEls.set(`${edge.from}>${edge.to}`, g);
    edgeEls.set(`${edge.to}>${edge.from}`, g);

    const t = edge.t ?? 0.5;
    labelLayer.append(s('text', {
      class: 'edge-label',
      x: a.x + (b.x - a.x) * t + (edge.dx ?? 0),
      y: a.y + (b.y - a.y) * t + (edge.dy ?? 4),
      'text-anchor': 'middle',
    }, edge.label));
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
  edgeEls.get(`${from}>${to}`)?.classList.toggle('broken', broken);
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

/** Um pacote indo de um nó a outro. abortAt (0 a 1) para o pacote no meio do caminho, com um ✕. */
export function hop(from, to, kind, { scale = 1, abortAt = null, radius = 6.5 } = {}) {
  if (document.hidden) return Promise.resolve();
  const a = NODES[from];
  const b = NODES[to];
  const edge = edgeEls.get(`${from}>${to}`);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const duration = (240 + Math.hypot(dx, dy) * 0.8) * scale;
  const end = abortAt ?? 1;
  const dot = s('circle', { class: `packet ${kind}`, r: radius, cx: a.x, cy: a.y });
  packetLayer.append(dot);
  light(edge, kind, +1);

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const p = ease(t) * end;
      dot.setAttribute('cx', String(a.x + dx * p));
      dot.setAttribute('cy', String(a.y + dy * p));
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      dot.remove();
      light(edge, kind, -1);
      if (abortAt !== null) {
        failMark(a.x + dx * end, a.y + dy * end);
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

// Desvios que o serviço faz antes de responder, como ir ao banco ou consultar o logs-service.
const ROUTES = {
  core: {
    entry: 'core',
    plan: (r) => (r.status === 400 ? [] : [{ path: ['core', 'coredb'], kinds: ['sql'] }]),
  },
  history: {
    entry: 'core',
    plan: (r) => {
      if (r.status === 400) return [];
      const db = { path: ['core', 'coredb'], kinds: ['sql'] };
      if (r.status === 404) return [db];
      if (r.status === 503) return [db, { path: ['core', 'logs'], kinds: ['rest'], fail: true }];
      return [db, { path: ['core', 'logs', 'logsdb'], kinds: ['rest', 'sql'] }];
    },
  },
  logs: {
    entry: 'logs',
    plan: (r) => (r.status === 422 ? [] : [{ path: ['logs', 'logsdb'], kinds: ['sql'] }]),
  },
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

/** Caminho assíncrono, a partir da outbox ou de mensagens que já estavam na fila. */
export async function animateAsync(fromPhase, count = 1) {
  const packets = Math.max(1, Math.min(count, 4));
  await Promise.all(Array.from({ length: packets }, async (_, i) => {
    await sleep(i * 150);
    if (fromPhase === 'outbox') await hop('core', 'rabbitmq', 'amqp');
    await hop('rabbitmq', 'logs', 'amqp');
    await hop('logs', 'logsdb', 'sql');
  }));
}

/** Mensagens publicadas que ficaram paradas na fila, sem consumidor. */
export async function animatePublish(count = 1) {
  const packets = Math.max(1, Math.min(count, 4));
  await Promise.all(Array.from({ length: packets }, async (_, i) => {
    await sleep(i * 150);
    await hop('core', 'rabbitmq', 'amqp');
  }));
}

/** Coleta do Prometheus, confirmada pela métrica up=1. */
export function animateScrape(targets) {
  for (const target of targets) {
    void hop('prometheus', target, 'scrape', { scale: 1.6, radius: 4 });
  }
}
