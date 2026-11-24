// Faux serveurs Claude + Telegram pour tester les workflows de bout en bout
// sans clé API, sans bot et sans dépenser un centime.
import http from 'node:http';

const state = { sent: [], edits: [], updates: [], claude: [], nextUpdateId: 1, nextMsgId: 100, scoreCalls: 0 };

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const url = new URL(req.url, 'http://mock');

    // ---------------- Claude Messages API ----------------
    if (url.pathname === '/v1/messages') {
      const problems = [];
      if (!req.headers['x-api-key']) problems.push('x-api-key manquant');
      if (!req.headers['anthropic-version']) problems.push('anthropic-version manquant');
      if (!body.model) problems.push('model manquant');
      if (body.output_config?.format?.type !== 'json_schema') problems.push('output_config.format json_schema manquant');
      if (!Array.isArray(body.messages) || !body.messages[0]?.content) problems.push('messages vides');
      if (problems.length) {
        return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: problems.join(', ') } });
      }
      state.claude.push({ model: body.model, effort: body.output_config.effort, fallbacks: body.fallbacks });

      const scoring = Boolean(body.output_config.format.schema?.properties?.score);
      let payload;
      if (scoring) {
        state.scoreCalls += 1;
        const good = state.scoreCalls % 3 !== 0; // 2 offres sur 3 passent le seuil
        payload = {
          score: good ? 86 : 35,
          verdict: good ? 'postuler' : 'ignorer',
          raisons: ['Stack Node.js/TypeScript alignée', 'Remote compatible avec UTC+0'],
          points_manquants: ['Pas d’expérience Kubernetes en production'],
          langue_offre: 'anglais',
        };
      } else {
        payload = {
          objet: 'Application – Backend Engineer',
          lettre: 'Hello,\n\nTest letter with <tags> & special chars.\n\nBest regards,\nPrénom Nom',
        };
      }
      return send(res, 200, {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          { type: 'thinking', thinking: '', signature: 'mock' },
          { type: 'text', text: JSON.stringify(payload) },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }

    // ---------------- Telegram Bot API ----------------
    const m = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
    if (m) {
      const method = m[1];
      if (method === 'sendMessage') {
        if (String(body.text || '').length > 4096) return send(res, 400, { ok: false, description: 'message is too long' });
        const msg = {
          message_id: state.nextMsgId++,
          chat: { id: Number(body.chat_id) },
          text: String(body.text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
        };
        state.sent.push({ ...msg, parse_mode: body.parse_mode, reply_markup: body.reply_markup });
        return send(res, 200, { ok: true, result: msg });
      }
      if (method === 'editMessageText') {
        state.edits.push({ message_id: body.message_id, text: body.text, reply_markup: body.reply_markup });
        return send(res, 200, { ok: true, result: { message_id: body.message_id } });
      }
      if (method === 'getUpdates') {
        const offset = Number(url.searchParams.get('offset') || 0);
        return send(res, 200, { ok: true, result: state.updates.filter((u) => u.update_id >= offset) });
      }
      return send(res, 200, { ok: true, result: true });
    }

    // ---------------- Contrôle du test ----------------
    if (url.pathname === '/_click') {
      // Simule un clic sur un bouton d'un message déjà envoyé
      const msg = state.sent.find((s) => JSON.stringify(s.reply_markup || '').includes(`"${body.data}"`));
      state.updates.push({
        update_id: state.nextUpdateId++,
        callback_query: {
          id: `cb${state.nextUpdateId}`,
          data: body.data,
          message: { message_id: msg?.message_id ?? 1, chat: { id: Number(body.chat_id ?? msg?.chat.id) }, text: msg?.text ?? '' },
        },
      });
      return send(res, 200, { ok: true, found: Boolean(msg) });
    }
    if (url.pathname === '/_state') return send(res, 200, state);

    send(res, 404, { ok: false });
  })
  .listen(8080, () => console.log('mock Claude/Telegram prêt sur :8080'));
