# Pareamento do WhatsApp (Pairing Code e QR)

Você tem dois modos de autenticar:
1) **Pairing Code** (numérico): exige definir `WHATSAPP_PHONE_NUMBER` no Render/GitHub Actions `.env`.
2) **QR Code**: não exige número; basta abrir `/qr` e escanear no app do WhatsApp.

## Requisitos
- Se for usar Pairing Code, defina **WHATSAPP_PHONE_NUMBER** em formato E.164 **sem +** (ex.: `5548999999999`).
- Se já existe sessão salva, o cliente **não** tentará parear. Para refazer o login, **apague a pasta da sessão** configurada em `WHATSAPP_SESSION_PATH` (ex.: `/data/whatsapp-session`).

## Endpoints úteis
- `GET /code` → retorna o Pairing Code atual (quando disponível).
- `GET /qr` → exibe o QR em SVG ou texto legível.
- `GET /health` → status do serviço.

## Fluxo recomendado
1. Defina as variáveis no Render (`WHATSAPP_PHONE_NUMBER` **ou** use apenas QR via `/qr`).
2. Se necessário, limpe a sessão (`WHATSAPP_SESSION_PATH`).
3. Reinicie e acesse `/code` **ou** `/qr` e conclua o login no WhatsApp (Aparelhos Conectados).
