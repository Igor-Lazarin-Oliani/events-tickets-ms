// Utilitários de DOM e formatação. Textos vindos da API entram sempre como texto, nunca como HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttributes(el, attrs);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttributes(el, attrs);
  appendChildren(el, children);
  return el;
}

function setAttributes(el, attrs) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function appendChildren(el, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRange(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${fmtDateTime(startIso)}–${pad(end.getHours())}:${pad(end.getMinutes())}`
    : `${fmtDateTime(startIso)} a ${fmtDateTime(endIso)}`;
}

export function fmtMs(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

export function shortId(uuid) {
  return uuid ? `${String(uuid).slice(0, 8)}…` : '';
}

/** Identificador enviado no X-Correlation-Id; o prefixo "ui" mostra que a operação veio desta página. */
export function newCorrelationId(prefix = 'ui') {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(6, '0').slice(0, 6);
  return `${prefix}-${random}`;
}

/** Valor para <input type="datetime-local">, no fuso do navegador. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A API exige data com fuso (D10): "2026-11-20T08:00" vira "2026-11-20T08:00:00-04:00". */
export function fromLocalInput(local) {
  const d = new Date(local);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${toLocalInput(d.toISOString())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado para a área de transferência.');
  } catch {
    window.prompt('Copie o texto:', text);
  }
}

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => el.classList.add('leaving'), 3800);
  setTimeout(() => el.remove(), 4300);
}

const FIRST_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eva', 'Fábio', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael'];
const LAST_NAMES = ['Lima', 'Reis', 'Dias', 'Souza', 'Nunes', 'Ramos', 'Melo', 'Alves', 'Costa', 'Pereira', 'Rocha', 'Vieira'];

/** Participante fictício para agilizar a demonstração. */
export function samplePerson() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const slug = `${first}.${last}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const document = `2026${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  return { name: `${first} ${last}`, email: `${slug}@example.com`, document };
}
