#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import logging
import os
import sys
import time
from urllib import request, error

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [CRON] %(levelname)s: %(message)s"
)
log = logging.getLogger("cron")

# >>> Configuração via ENV <<<
API_BASE_URL = os.environ.get("API_BASE_URL", "").rstrip("/")
API_PATH = os.environ.get("API_PATH", "/api/sorteios/processar-planilha")
TIMEOUT = int(os.environ.get("API_TIMEOUT", "60"))  # segundos
RETRY = int(os.environ.get("API_RETRY", "2"))       # tentativas adicionais

# fallback caso não defina API_BASE_URL na Environment
if not API_BASE_URL:
    API_BASE_URL = "https://processador-sorteios-api.onrender.com"

URL = f"{API_BASE_URL}{API_PATH}"

def call_endpoint(url: str) -> tuple[int, str]:
    req = request.Request(url, method="POST")
    req.add_header("Content-Type", "application/json")
    data = json.dumps({"source": "cron"}).encode("utf-8")
    try:
        with request.urlopen(req, data=data, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return resp.status, body
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else str(e)
        return e.code, body
    except Exception as e:
        return 0, str(e)

def main():
    log.info("🚀 Iniciando cron HTTP → %s", URL)

    attempts = 1 + max(RETRY, 0)
    for i in range(1, attempts + 1):
        status, body = call_endpoint(URL)
        if status and 200 <= status < 300:
            log.info("✅ Sucesso (%s/%s). HTTP %d. Resposta: %s", i, attempts, status, body[:400])
            return 0
        else:
            log.warning("⚠️ Falha (%s/%s). HTTP %s. Detalhe: %s", i, attempts, status, body[:400])
            if i < attempts:
                time.sleep(5)

    log.error("❌ Todas as tentativas falharam.")
    return 1

if __name__ == "__main__":
    sys.exit(main())
