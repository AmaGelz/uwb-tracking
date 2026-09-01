#!/usr/bin/env bash
set -euo pipefail

exec gunicorn --chdir backend/backend --bind=0.0.0.0 --timeout 600 --workers 2 --worker-class uvicorn.workers.UvicornWorker main:app
