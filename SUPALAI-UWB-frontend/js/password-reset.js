'use strict';

(() => {
  const q = (selector, root = document) => root.querySelector(selector);
  const { api } = window.SUPALAI_API;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    || new URLSearchParams(window.location.search).get('token');

  function showMessage(form, message, kind = 'error') {
    const host = q('.form-message', form);
    host.textContent = message;
    host.className = `form-message ${kind === 'success' ? 'success' : 'err'}`;
  }

  function errorText(error) {
    return error?.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
  }

  document.addEventListener('DOMContentLoaded', () => {
    const forgotForm = q('#forgot-form');
    const resetForm = q('#reset-form');

    if (token) {
      forgotForm.hidden = true;
      resetForm.hidden = false;
    }

    forgotForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = q('button[type="submit"]', forgotForm);
      button.disabled = true;
      try {
        const result = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: q('#reset-email').value.trim() }),
        });
        showMessage(forgotForm, result.message, 'success');
        q('#reset-email').disabled = true;
        button.hidden = true;
      } catch (error) {
        showMessage(forgotForm, errorText(error));
      } finally {
        button.disabled = false;
      }
    });

    resetForm.addEventListener('submit', async event => {
      event.preventDefault();
      const password = q('#new-password').value;
      if (password !== q('#confirm-password').value) {
        showMessage(resetForm, 'รหัสผ่านทั้งสองช่องไม่ตรงกัน');
        return;
      }

      const button = q('button[type="submit"]', resetForm);
      button.disabled = true;
      try {
        const result = await api('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, new_password: password }),
        });
        showMessage(resetForm, result.message, 'success');
        q('#new-password').disabled = true;
        q('#confirm-password').disabled = true;
        button.hidden = true;
        window.history.replaceState(null, '', 'reset-password.html');
      } catch (error) {
        showMessage(resetForm, errorText(error));
      } finally {
        button.disabled = false;
      }
    });
  });
})();
