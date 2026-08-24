/* SUPALAI-UWB authentication — same original Sign In / Google flow. */
'use strict';

const q = (sel, root = document) => root.querySelector(sel);
const escAuth = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { api, state: S, OfflineError } = window.SUPALAI_API;

function saveSession(r) {
  S.token = r.token;
  S.user = r.user;
  localStorage.setItem('tw_token', r.token);
}

function goDashboard() {
  window.location.href = 'dashboard.html#/overview';
}

async function handleGoogleLogin(response) {
  const err = q('#signin-err');
  const googleHost = q('#google-btn');
  if (!response || !response.credential) {
    err.innerHTML = '<div class="err">ไม่ได้รับข้อมูลจาก Google</div>';
    return;
  }
  if (googleHost) googleHost.style.opacity = '0.65';
  err.innerHTML = '';
  try {
    const r = await api('/api/google-signin', {
      method: 'POST',
      body: JSON.stringify({ credential: response.credential }),
    });
    if (!r.ok) {
      err.innerHTML = `<div class="err">${escAuth(r.error)}</div>`;
      return;
    }
    saveSession(r);
    goDashboard();
  } catch (e) {
    err.innerHTML = e instanceof OfflineError
      ? '<div class="err">ติดต่อ server ไม่ได้ — ตรวจว่า backend API ยังรันอยู่</div>'
      : `<div class="err">${escAuth(e.message)}</div>`;
  } finally {
    if (googleHost) googleHost.style.opacity = '';
  }
}

async function setupGoogle() {
  window.handleGoogleLogin = handleGoogleLogin;
  const host = q('#google-btn');
  try {
    const cfg = await api('/api/auth/google-config');
    if (cfg.enabled && window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.initialize({
        client_id: cfg.client_id,
        callback: handleGoogleLogin,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(host, {
        type: 'standard', theme: 'outline', size: 'large',
        text: 'continue_with', shape: 'rectangular', width: 344,
      });
    } else if (!cfg.enabled) {
      host.innerHTML = '<div class="google-disabled">Google Sign-In ยังไม่ได้ตั้งค่า</div>';
    } else {
      host.innerHTML = '<div class="google-disabled">โหลด Google Sign-In ไม่สำเร็จ</div>';
    }
  } catch (e) {
    host.innerHTML = '<div class="google-disabled">Google Sign-In ใช้งานไม่ได้</div>';
  }
}

function setupPasswordLogin() {
  const form = q('#signin-form');
  if (!form) return;
  form.onsubmit = async ev => {
    ev.preventDefault();
    const btn = q('button[type=submit]', form);
    const err = q('#signin-err');
    btn.disabled = true;
    err.innerHTML = '';
    try {
      const r = await api('/api/signin', {
        method: 'POST',
        body: JSON.stringify({ email: q('#si-email').value, password: q('#si-pw').value }),
      });
      if (!r.ok) {
        err.innerHTML = `<div class="err">${escAuth(r.error)}</div>`;
        return;
      }
      saveSession(r);
      goDashboard();
    } catch (e) {
      err.innerHTML = e instanceof OfflineError
        ? '<div class="err">ติดต่อ server ไม่ได้ — ตรวจว่า backend API ยังรันอยู่ แล้วลองใหม่</div>'
        : `<div class="err">${escAuth(e.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.className = 'signin-page';
  setupPasswordLogin();
  setupGoogle();
});
