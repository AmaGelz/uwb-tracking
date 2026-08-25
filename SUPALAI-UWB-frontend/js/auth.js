/* SUPALAI-UWB authentication through Supabase Auth. */
'use strict';

(() => {
  const runtimeConfig = window.SUPALAI_CONFIG || {};
  const initialAuthFlow = new URLSearchParams(window.location.hash.slice(1)).get('type')
    || new URLSearchParams(window.location.search).get('type');
  const isPasswordSetupFlow = initialAuthFlow === 'invite' || initialAuthFlow === 'recovery';
  const q = (sel, root = document) => root.querySelector(sel);
  const escAuth = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const {
    api,
    ensureSession,
    supabase: supabaseClient,
    state: sessionState,
    OfflineError,
  } = window.SUPALAI_API;

  function goDashboard() {
    window.location.href = 'dashboard.html#/overview';
  }

  async function finishSignIn(session) {
    sessionState.token = session.access_token;
    localStorage.setItem('tw_token', session.access_token);
    const me = await api('/api/me');
    sessionState.user = me.user;
    goDashboard();
  }

  function showError(error) {
    const host = q('#signin-err');
    const message = error instanceof OfflineError
      ? 'ติดต่อ Supabase server ไม่ได้'
      : error?.message || error || 'เข้าสู่ระบบไม่สำเร็จ';
    host.innerHTML = `<div class="err">${escAuth(message)}</div>`;
  }

  function showNotice(message) {
    const host = q('#signin-err');
    const notice = document.createElement('div');
    notice.className = 'hint';
    notice.textContent = message;
    host.replaceChildren(notice);
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
        if (!supabaseClient) throw new Error('ยังไม่ได้ตั้งค่า Supabase client');
        const { data, error } = await supabaseClient.auth.signInWithPassword({
          email: q('#si-email').value.trim(),
          password: q('#si-pw').value,
        });
        if (error) throw error;
        if (!data.session) throw new Error('Supabase ไม่ส่ง session กลับมา');
        await finishSignIn(data.session);
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    };
  }

  function setupInvitedPassword() {
    const form = q('#signin-form');
    const emailField = q('#si-email')?.closest('.field');
    if (emailField) emailField.hidden = true;
    q('.signin h2').textContent = 'Set your password';
    const password = q('#si-pw');
    password.autocomplete = 'new-password';
    password.minLength = 8;
    password.placeholder = 'อย่างน้อย 8 ตัวอักษร';
    q('label[for="si-pw"]').textContent = 'New password';
    const submit = q('button[type=submit]', form);
    submit.textContent = 'Save password';
    q('.signin-divider').hidden = true;
    q('#google-btn').hidden = true;
    q('#forgot-password').hidden = true;
    q('.signin-hint').textContent = 'ตั้งรหัสผ่านสำหรับบัญชี Supabase Auth ที่ได้รับเชิญ';

    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      q('#signin-err').innerHTML = '';
      try {
        const session = await ensureSession();
        if (!session) throw new Error('Invite link หมดอายุ กรุณาขอคำเชิญใหม่');
        const { error } = await supabaseClient.auth.updateUser({ password: password.value });
        if (error) throw error;
        await finishSignIn(session);
      } catch (error) {
        showError(error);
      } finally {
        submit.disabled = false;
      }
    };
  }

  function setupGoogleLogin() {
    const host = q('#google-btn');
    if (!host) return;
    if (!runtimeConfig.googleAuthEnabled) {
      host.hidden = true;
      q('.signin-divider').hidden = true;
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-block google-auth-button';
    button.textContent = 'Continue with Google';
    button.onclick = async () => {
      button.disabled = true;
      q('#signin-err').innerHTML = '';
      try {
        if (!supabaseClient) throw new Error('ยังไม่ได้ตั้งค่า Supabase client');
        const redirectTo = new URL('dashboard.html#/overview', window.location.href).toString();
        const { error } = await supabaseClient.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo },
        });
        if (error) throw error;
      } catch (error) {
        showError(error);
        button.disabled = false;
      }
    };
    host.replaceChildren(button);
  }

  function setupForgotPassword() {
    const button = q('#forgot-password');
    const email = q('#si-email');
    if (!button || !email) return;
    button.addEventListener('click', async () => {
      if (!email.reportValidity()) return;
      button.disabled = true;
      q('#signin-err').replaceChildren();
      try {
        if (!supabaseClient) throw new Error('ยังไม่ได้ตั้งค่า Supabase client');
        const redirectTo = new URL('login.html', window.location.href).toString();
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email.value.trim(), { redirectTo });
        if (error) throw error;
        showNotice('ส่งลิงก์ตั้งรหัสผ่านแล้ว กรุณาตรวจอีเมลและโฟลเดอร์ Junk');
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.body.className = 'signin-page';
    if (isPasswordSetupFlow) setupInvitedPassword();
    else {
      setupPasswordLogin();
      setupGoogleLogin();
      setupForgotPassword();
    }
    try {
      const session = await ensureSession();
      if (session && !isPasswordSetupFlow) goDashboard();
    } catch (_error) { /* stay on the sign-in page */ }
  });
})();
