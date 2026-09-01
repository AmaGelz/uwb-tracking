/* SUPALAI-UWB transport: FastAPI + PostgreSQL-backed sessions. */
'use strict';

(() => {
  const runtimeConfig = window.SUPALAI_CONFIG || {};
  const apiBaseUrl = String(runtimeConfig.apiBaseUrl || '').trim().replace(/\/+$/, '');

  const S = {
    user: null,
    token: localStorage.getItem('tw_token') || null,
    boot: null,
    route: '',
    live: { lastId: 0, trail: [], timer: null },
    filters: { province: '', project: '', plan: '', employee: '', customer: '',
               from: '', to: '' },
  };

  class OfflineError extends Error {}

  function setSession(token, user = null) {
    S.token = token || null;
    S.user = user;
    if (S.token) localStorage.setItem('tw_token', S.token);
    else {
      localStorage.removeItem('tw_token');
      S.boot = null;
    }
  }

  function ensureSession() {
    return Promise.resolve(S.token);
  }

  function resolveApiUrl(path) {
    const value = String(path || '');
    if (/^https?:\/\//i.test(value) || !apiBaseUrl) return value;
    return `${apiBaseUrl}${value.startsWith('/') ? '' : '/'}${value}`;
  }

  function websocketUrl(path = '/ws/live') {
    const url = new URL(resolveApiUrl(path), window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (S.token) headers['X-Session'] = S.token;

    let response;
    try {
      response = await fetch(resolveApiUrl(path), Object.assign({}, opts, { headers }));
    } catch (_error) {
      throw new OfflineError('ติดต่อ API server ไม่ได้');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      if (response.ok) return null;
    }

    if (!response.ok) {
      if (response.status === 401) setSession(null);
      const detail = payload?.error || payload?.detail || payload?.message;
      throw new Error(detail || `HTTP ${response.status}`);
    }

    if (path === '/api/signout' && String(opts.method || 'GET').toUpperCase() === 'POST') {
      setSession(null);
    }
    return payload;
  }

  window.SUPALAI_API = {
    api,
    apiBaseUrl,
    ensureSession,
    resolveApiUrl,
    websocketUrl,
    setSession,
    state: S,
    OfflineError,
  };
})();
