/* Keep empty when FastAPI serves the frontend; set to the public API origin
   when the static frontend is hosted separately. Never put DATABASE_URL here. */
window.SUPALAI_CONFIG = window.SUPALAI_CONFIG || {
  apiBaseUrl: '',
};
