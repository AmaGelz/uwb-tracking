/* Keep empty when FastAPI serves the frontend. Set this to the public FastAPI
   origin only when the static frontend is hosted separately. Never put a
   DATABASE_URL, gateway key, or other server secret in this file. */
window.SUPALAI_CONFIG = window.SUPALAI_CONFIG || {
  apiBaseUrl: '',
};
