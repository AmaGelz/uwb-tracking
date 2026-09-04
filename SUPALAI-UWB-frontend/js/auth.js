/* SUPALAI-UWB authentication through the FastAPI/PostgreSQL backend. */
'use strict';

(() => {
  const q = (sel, root = document) => root.querySelector(sel);
  const escAuth = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const { api, setSession, state: sessionState, OfflineError } = window.SUPALAI_API;

  function goDashboard() {
    window.location.href = 'dashboard.html#/overview';
  }

  function saveSession(result) {
    setSession(result.token, result.user);
  }

  function showError(error) {
    const host = q('#signin-err');
    const message = error instanceof OfflineError
      ? 'ติดต่อ FastAPI server ไม่ได้ — ตรวจว่า backend ยังทำงานอยู่'
      : error?.message || error || 'เข้าสู่ระบบไม่สำเร็จ';
    host.innerHTML = `<div class="err">${escAuth(message)}</div>`;
  }

  function setupPasswordLogin() {
    const form = q('#signin-form');
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const button = q('button[type=submit]', form);
      button.disabled = true;
      q('#signin-err').innerHTML = '';
      try {
        const result = await api('/api/signin', {
          method: 'POST',
          body: JSON.stringify({
            email: q('#si-email').value.trim(),
            password: q('#si-pw').value,
          }),
        });
        if (!result?.ok) throw new Error(result?.error || 'เข้าสู่ระบบไม่สำเร็จ');
        saveSession(result);
        goDashboard();
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    };
  }

  function loadGoogleIdentity() {
    if (window.google?.accounts?.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('โหลด Google Sign-In ไม่สำเร็จ'));
      document.head.appendChild(script);
    });
  }

  async function handleGoogleLogin(response) {
    const host = q('#google-btn');
    if (!response?.credential) return showError('ไม่ได้รับข้อมูลจาก Google');
    if (host) host.style.opacity = '0.65';
    q('#signin-err').replaceChildren();
    try {
      const result = await api('/api/google-signin', {
        method: 'POST',
        body: JSON.stringify({ credential: response.credential }),
      });
      if (!result?.ok) throw new Error(result?.error || 'Google Sign-In ไม่สำเร็จ');
      saveSession(result);
      goDashboard();
    } catch (error) {
      showError(error);
    } finally {
      if (host) host.style.opacity = '';
    }
  }

  async function setupGoogleLogin() {
    const host = q('#google-btn');
    const divider = q('.signin-divider');
    if (!host) return;
    try {
      const config = await api('/api/auth/google-config');
      if (!config?.enabled) {
        host.hidden = true;
        if (divider) divider.hidden = true;
        return;
      }
      await loadGoogleIdentity();
      window.google.accounts.id.initialize({
        client_id: config.client_id,
        callback: handleGoogleLogin,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(host, {
        type: 'standard', theme: 'outline', size: 'large',
        text: 'continue_with', shape: 'rectangular', width: 344,
      });
    } catch (error) {
      host.innerHTML = `<div class="google-disabled">${escAuth(error.message || 'Google Sign-In ใช้งานไม่ได้')}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.body.className = 'signin-page';
    if (sessionState.token) {
      try {
        const result = await api('/api/me');
        sessionState.user = result.user;
        goDashboard();
        return;
      } catch (_error) { /* invalid/expired token: show the login form */ }
    }
    setupPasswordLogin();
    await setupGoogleLogin();
  });
})();
