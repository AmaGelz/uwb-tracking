/* SUPALAI-UWB API layer — preserves the original tracking-v02 behaviour. */
'use strict';

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

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' },
                                opts.headers || {});
  if (S.token) headers['X-Session'] = S.token;
  let r;
  try {
    r = await fetch(path, Object.assign({}, opts, { headers }));
  } catch (e) {
    throw new OfflineError('ติดต่อ server ไม่ได้');
  }
  if (!r.ok && r.status !== 400) {
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch (e) {}
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.json();
}

window.SUPALAI_API = { api, state: S, OfflineError };
