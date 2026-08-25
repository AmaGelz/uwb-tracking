/* SUPALAI-UWB transport: Supabase Auth + Edge Functions + Realtime. */
'use strict';

(() => {
  const runtimeConfig = window.SUPALAI_CONFIG || {};
  const apiBaseUrl = String(runtimeConfig.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const supabaseUrl = String(runtimeConfig.supabaseUrl || '').trim().replace(/\/+$/, '');
  const supabasePublishableKey = String(runtimeConfig.supabasePublishableKey || '').trim();

  const supabaseClient = supabaseUrl && supabasePublishableKey && window.supabase?.createClient
    ? window.supabase.createClient(supabaseUrl, supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

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

  function syncSession(session) {
    S.token = session?.access_token || null;
    if (S.token) localStorage.setItem('tw_token', S.token);
    else localStorage.removeItem('tw_token');
    return session || null;
  }

  async function ensureSession() {
    if (!supabaseClient) throw new OfflineError('ยังไม่ได้ตั้งค่า Supabase client');
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw new Error(error.message);
    return syncSession(data.session);
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
    if (path === '/api/signout' && String(opts.method || 'GET').toUpperCase() === 'POST') {
      if (supabaseClient) await supabaseClient.auth.signOut();
      syncSession(null);
      S.user = null;
      S.boot = null;
      return { ok: true };
    }

    const session = await ensureSession();
    if (!session) throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
    const headers = Object.assign({
      'Content-Type': 'application/json',
      apikey: supabasePublishableKey,
      Authorization: `Bearer ${session.access_token}`,
    }, opts.headers || {});

    let response;
    try {
      response = await fetch(resolveApiUrl(path), Object.assign({}, opts, { headers }));
    } catch (_error) {
      throw new OfflineError('ติดต่อ Supabase server ไม่ได้');
    }
    if (!response.ok && response.status !== 400) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = payload.error || payload.detail || payload.message || '';
      } catch (_error) { /* use HTTP status below */ }
      if (response.status === 401) syncSession(null);
      throw new Error(detail || `HTTP ${response.status}`);
    }
    return response.json();
  }

  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((_event, session) => syncSession(session));
    void ensureSession().catch(() => syncSession(null));
  }

  window.SUPALAI_API = {
    api,
    apiBaseUrl,
    ensureSession,
    resolveApiUrl,
    websocketUrl,
    supabase: supabaseClient,
    state: S,
    OfflineError,
  };
})();
