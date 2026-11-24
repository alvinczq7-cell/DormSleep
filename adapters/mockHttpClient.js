// 指向共享本地模拟服务的 HTTP + SSE 传输客户端

import { API_ENDPOINTS } from '../shared/protocol.js';

export async function apiGet(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost(path, payload = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok && data.ok === undefined) {
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return data;
}

export function subscribeEvents(onEvent) {
  let es = null;
  let closed = false;
  let retryTimer = null;

  function connect() {
    if (closed) return;
    es = new EventSource(API_ENDPOINTS.EVENTS);
    es.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data));
      } catch {
        onEvent({ type: 'ping' });
      }
    };
    es.onerror = () => {
      if (es) {
        es.close();
        es = null;
      }
      if (!closed) {
        retryTimer = setTimeout(connect, 1500);
      }
    };
  }

  connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (es) es.close();
  };
}
