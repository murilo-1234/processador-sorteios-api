// src/services/buttons.js
// Envio de botões com fallback e logs consistentes.

const USE_BUTTONS = String(process.env.ASSISTANT_USE_BUTTONS || '0') === '1';

/**
 * Envia botões de URL (preferência: templateButtons).
 * Fallback 1: hydratedTemplate (algumas versões do Baileys).
 * Fallback 2: retorna false para o chamador usar texto puro.
 */
async function sendUrlButtons(sock, jid, headerText, buttons, footer = 'Murilo • Natura') {
  if (!USE_BUTTONS) return false;

  // Tentativa #1 — templateButtons (mais novo/estável)
  try {
    await sock.sendMessage(jid, {
      text: headerText,
      footer,
      templateButtons: buttons, // [{ index, urlButton: { displayText, url } }]
    });
    return true;
  } catch (e1) {
    console.error('[buttons] templateButtons error:', e1?.message || e1);
  }

  // Tentativa #2 — hydratedTemplate (compatibilidade)
  try {
    const hydratedButtons = buttons.map(b => ({ urlButton: b.urlButton }));
    await sock.sendMessage(jid, {
      templateMessage: {
        hydratedTemplate: {
          hydratedContentText: headerText,
          footerText: footer,
          hydratedButtons,
        },
      },
    });
    return true;
  } catch (e2) {
    console.error('[buttons] hydratedTemplate error:', e2?.message || e2);
  }

  // Fallback final: não conseguiu enviar botões → devolve false
  return false;
}

module.exports = { sendUrlButtons, USE_BUTTONS };
