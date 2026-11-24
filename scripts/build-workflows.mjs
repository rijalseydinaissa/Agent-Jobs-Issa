// Génère les workflows n8n (workflows/*.json) à partir de ce fichier.
// Le code des nœuds "Code" est écrit ici comme du vrai JavaScript (lisible, versionné),
// puis sérialisé dans le JSON importable par n8n.
//
//   node scripts/build-workflows.mjs
//
/* eslint-disable no-undef */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

// --- Identifiants fixes, créés par scripts/setup.sh -------------------------
const CRED = {
  pg: { postgres: { id: 'jobsPgCred000001', name: 'Postgres (jobs)' } },
  claude: { httpHeaderAuth: { id: 'anthropicKey0001', name: 'Anthropic API key' } },
  telegram: { telegramApi: { id: 'telegramBot00001', name: 'Telegram bot' } },
  smtp: { smtp: { id: 'smtpMailCred0001', name: 'SMTP candidatures' } },
};

// --- Helpers ----------------------------------------------------------------
const body = (fn) => {
  const s = fn.toString();
  return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')).replace(/^\n/, '').replace(/\s+$/, '\n');
};
let uid = 0;
const id = () => `node-${String(++uid).padStart(4, '0')}`;

function node(name, type, typeVersion, position, parameters, extra = {}) {
  return { id: id(), name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra };
}
const code = (name, position, fn, mode = 'runOnceForAllItems') =>
  node(name, 'code', 2, position, { mode, jsCode: body(fn) });
const sql = (name, position, query, replacement, extra = {}) =>
  node(
    name,
    'postgres',
    2.5,
    position,
    {
      operation: 'executeQuery',
      query,
      options: replacement ? { queryReplacement: replacement } : {},
    },
    { credentials: CRED.pg, ...extra },
  );

function connect(pairs) {
  // pairs: [from, to, fromOutput = 0, toInput = 0]
  const c = {};
  for (const [from, to, out = 0, input = 0] of pairs) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: input });
  }
  return c;
}
const cond = (leftValue, operator, rightValue = '') => ({
  id: id(),
  leftValue,
  rightValue,
  operator,
});
const conditions = (list, combinator = 'and') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: list,
  combinator,
});

function claudeCall(name, position) {
  return node(
    name,
    'httpRequest',
    4.2,
    position,
    {
      method: 'POST',
      url: "={{ ($env.ANTHROPIC_API_URL || 'https://api.anthropic.com') + '/v1/messages' }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'anthropic-version', value: '2026-10-21' },
          { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.request) }}',
      options: {
        timeout: 180000,
        batching: { batch: { batchSize: 1, batchInterval: 1000 } },
      },
    },
    { credentials: CRED.claude, onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 },
  );
}

function jobSource(name, position, url) {
  return node(
    name,
    'httpRequest',
    4.2,
    position,
    {
      url,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: 'remote-job-agent (n8n, usage personnel)' }] },
      options: { timeout: 30000 },
    },
    { onError: 'continueRegularOutput', alwaysOutputData: true },
  );
}

// ============================================================================
// Workflow 1 — Collecter, scorer, rédiger, demander validation
// ============================================================================

const normalize = code('Normaliser et pré-filtrer', [1340, 300], function () {
  // Transforme les 4 formats d'API en un format commun, puis garde
  // uniquement les offres récentes dont le titre/tags matchent vos mots-clés.
  const split = (s) => (s || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const keywords = split($env.SEARCH_KEYWORDS);
  const excluded = split($env.EXCLUDE_KEYWORDS);
  const maxAgeMs = Number($env.MAX_AGE_DAYS || 14) * 86400000;

  const stripHtml = (h) =>
    String(h || '')
      .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#0?39;|&rsquo;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  const toIso = (v) => {
    if (v === null || v === undefined || v === '') return '';
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v).replace(' ', 'T'));
    return isNaN(d) ? '' : d.toISOString();
  };
  const salary = (min, max, cur) => (min || max ? `${min || '?'}–${max || '?'} ${cur || ''}`.trim() : '');
  const mailto = (html, apply) => {
    if (String(apply || '').startsWith('mailto:')) return apply.slice(7).split('?')[0];
    const m = String(html || '').match(/mailto:([^"'?\s>]+)/i);
    return m ? m[1] : '';
  };

  const offers = [];
  const push = (o) => offers.push(o);

  for (const { json: j } of $input.all()) {
    if (!j || j.error) continue;
    // RemoteOK : un item par offre (le 1er item est la mention légale)
    if (j.position && j.id) {
      push({
        source: 'remoteok', external_id: String(j.id), title: j.position, company: j.company,
        location: j.location || 'Remote', salary: salary(j.salary_min, j.salary_max, 'USD'),
        tags: j.tags || [], url: j.url, apply_url: j.apply_url || j.url,
        contact_email: mailto(j.description, j.apply_url), html: j.description, published_at: toIso(j.date),
      });
      continue;
    }
    for (const x of Array.isArray(j.jobs) ? j.jobs : []) {
      if (x.candidate_required_location !== undefined) {
        push({
          source: 'remotive', external_id: String(x.id), title: x.title, company: x.company_name,
          location: x.candidate_required_location, salary: x.salary || '',
          tags: [...(x.tags || []), x.category].filter(Boolean), url: x.url, apply_url: x.url,
          contact_email: mailto(x.description), html: x.description, published_at: toIso(x.publication_date),
        });
      } else if (x.applicationLink !== undefined || x.guid) {
        push({
          source: 'himalayas', external_id: String(x.guid || x.applicationLink), title: x.title, company: x.companyName,
          location: (x.locationRestrictions || []).join(', ') || 'Worldwide',
          salary: salary(x.minSalary, x.maxSalary, x.currency), tags: [...(x.categories || []), ...(x.seniority || [])],
          url: x.guid || x.applicationLink, apply_url: x.applicationLink || x.guid,
          contact_email: mailto(x.description, x.applicationLink), html: x.description, published_at: toIso(x.pubDate),
        });
      } else if (x.jobTitle) {
        push({
          source: 'jobicy', external_id: String(x.id), title: x.jobTitle, company: x.companyName,
          location: x.jobGeo || 'Remote', salary: salary(x.annualSalaryMin, x.annualSalaryMax, x.salaryCurrency),
          tags: [...(x.jobIndustry || []), ...(x.jobType || [])], url: x.url, apply_url: x.url,
          contact_email: mailto(x.jobDescription), html: x.jobDescription, published_at: toIso(x.pubDate),
        });
      }
    }
  }

  const seen = new Set();
  const out = [];
  for (const o of offers) {
    if (!o.title || !o.url) continue;
    const haystack = `${o.title} ${o.tags.join(' ')}`.toLowerCase();
    if (keywords.length && !keywords.some((k) => haystack.includes(k))) continue;
    if (excluded.some((k) => o.title.toLowerCase().includes(k))) continue;
    if (o.published_at && Date.now() - new Date(o.published_at) > maxAgeMs) continue;
    const dedupe_key = `${o.company || ''}|${o.title}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim();
    if (seen.has(dedupe_key)) continue;
    seen.add(dedupe_key);
    const { html, ...rest } = o;
    out.push({
      json: { ...rest, dedupe_key, tags: o.tags.join(', '), description: stripHtml(html).slice(0, 8000) },
    });
  }
  return out;
});

const prepScoring = code('Préparer le scoring', [2220, 300], function () {
  // Construit la requête Claude : score 0-100 avec sortie JSON garantie (structured outputs)
  const profile = $('Extraire le texte du profil').first().json.data;
  const model = $env.CLAUDE_MODEL || 'claude-opus-5-5';

  const system = [
    "Tu es un recruteur technique exigeant et honnête. Tu évalues l'adéquation entre le profil d'un candidat et une offre d'emploi en télétravail.",
    'Barème : 90-100 = candidat idéal ; 70-89 = bon match, candidature recommandée ; 50-69 = match partiel ; < 50 = hors cible.',
    "Pénalise fortement : exigence de localisation/fuseau horaire incompatible avec le candidat, séniorité très différente, stack principale absente du profil, langue de travail non maîtrisée.",
    "N'invente rien sur le candidat : base-toi uniquement sur le profil fourni.",
    'Réponds en français, raisons courtes et concrètes (max 3 de chaque).',
  ].join('\n');

  return $input.all().map(({ json: offer }) => {
    const request = {
      model,
      max_tokens: 4000,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              score: { type: 'integer', description: 'Adéquation de 0 à 100' },
              verdict: { type: 'string', enum: ['postuler', 'a_voir', 'ignorer'] },
              raisons: { type: 'array', items: { type: 'string' } },
              points_manquants: { type: 'array', items: { type: 'string' } },
              langue_offre: { type: 'string', description: "Langue de l'offre, ex: anglais" },
            },
            required: ['score', 'verdict', 'raisons', 'points_manquants', 'langue_offre'],
            additionalProperties: false,
          },
        },
      },
      system,
      messages: [
        {
          role: 'user',
          content:
            `<profil_candidat>\n${profile}\n</profil_candidat>\n\n` +
            `<offre>\nTitre : ${offer.title}\nEntreprise : ${offer.company}\nLocalisation acceptée : ${offer.location}\n` +
            `Salaire : ${offer.salary || 'non précisé'}\nTags : ${offer.tags}\n\n${offer.description}\n</offre>`,
        },
      ],
    };
    // Repli automatique sur un autre modèle si celui-ci refuse (non dispo sur Haiku)
    if (!/haiku/.test(model)) request.fallbacks = 'default';
    return { json: { offer, request } };
  });
});

const parseScore = code('Lire le score', [2660, 300], function () {
  const prepared = $('Préparer le scoring').all();
  const out = [];
  $input.all().forEach(({ json: r }, i) => {
    const offer = prepared[i].json.offer;
    if (!Array.isArray(r.content)) {
      // Erreur API : l'offre reste "new" et sera retentée au prochain passage
      console.log(`Scoring impossible pour l'offre ${offer.id}`, JSON.stringify(r.error || r).slice(0, 300));
      return;
    }
    let a = { score: 0, verdict: 'ignorer', raisons: [], points_manquants: [], langue_offre: '' };
    if (r.stop_reason === 'refusal') {
      a.raisons = ['Le modèle a refusé de traiter cette offre'];
    } else {
      try {
        a = JSON.parse(r.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
      } catch (e) {
        console.log(`Réponse illisible pour l'offre ${offer.id}`);
        return;
      }
    }
    out.push({
      json: {
        ...offer,
        score: Math.max(0, Math.min(100, Number(a.score) || 0)),
        analysis: { verdict: a.verdict, raisons: a.raisons, points_manquants: a.points_manquants, langue_offre: a.langue_offre },
      },
    });
  });
  return out;
});

const prepLetter = code('Préparer la lettre', [3100, 200], function () {
  const profile = $('Extraire le texte du profil').first().json.data;
  const model = $env.CLAUDE_MODEL || 'claude-opus-5-5';
  const name = $env.CANDIDATE_NAME || '';

  const system = [
    `Tu rédiges des candidatures spontanées et sobres pour ${name}.`,
    "Écris dans la langue de l'offre. Ton direct et professionnel, sans formules creuses ni superlatifs.",
    "Corps de l'email : 150 à 230 mots, 3 paragraphes courts : (1) le poste visé et pourquoi cette entreprise, " +
      '(2) 2-3 réalisations du profil qui répondent précisément aux exigences de l\'offre, (3) disponibilité et appel à un échange.',
    "N'invente AUCUNE expérience, compétence, chiffre ou diplôme absent du profil. Mentionne que le CV est en pièce jointe.",
    `Termine par la signature : ${name}. Pas de placeholder entre crochets.`,
  ].join('\n');

  return $input.all().map(({ json: offer }) => {
    const request = {
      model,
      max_tokens: 8000,
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              objet: { type: 'string', description: "Objet de l'email de candidature" },
              lettre: { type: 'string', description: "Corps de l'email, prêt à envoyer" },
            },
            required: ['objet', 'lettre'],
            additionalProperties: false,
          },
        },
      },
      system,
      messages: [
        {
          role: 'user',
          content:
            `<profil_candidat>\n${profile}\n</profil_candidat>\n\n` +
            `<offre>\nTitre : ${offer.title}\nEntreprise : ${offer.company}\n\n${offer.description}\n</offre>\n\n` +
            `<analyse_adequation>\nPoints forts : ${(offer.analysis.raisons || []).join(' ; ')}\n</analyse_adequation>`,
        },
      ],
    };
    if (!/haiku/.test(model)) request.fallbacks = 'default';
    return { json: { offer, request } };
  });
});

const parseLetter = code('Lire la lettre', [3540, 200], function () {
  const prepared = $('Préparer la lettre').all();
  const out = [];
  $input.all().forEach(({ json: r }, i) => {
    const offer = prepared[i].json.offer;
    if (!Array.isArray(r.content) || r.stop_reason === 'refusal') {
      console.log(`Lettre impossible pour l'offre ${offer.id}`, JSON.stringify(r.error || r.stop_reason).slice(0, 300));
      return;
    }
    try {
      const l = JSON.parse(r.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
      out.push({ json: { ...offer, email_subject: l.objet, cover_letter: l.lettre } });
    } catch (e) {
      console.log(`Lettre illisible pour l'offre ${offer.id}`);
    }
  });
  return out;
});

const composeMessage = code('Composer le message', [3980, 200], function () {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return $input.all().map(({ json: o }) => {
    const a = o.analysis || {};
    const lines = [
      `🎯 <b>${o.score}/100 — ${esc(o.title)}</b>`,
      `🏢 ${esc(o.company || '?')}  ·  📍 ${esc(o.location || 'Remote')}${o.salary ? '  ·  💰 ' + esc(o.salary) : ''}`,
      `🔎 ${esc(o.source)}  ·  <a href="${esc(o.url)}">voir l'offre</a>`,
      '',
      '✅ <b>Points forts</b>',
      ...(a.raisons || []).map((x) => '• ' + esc(x)),
    ];
    if ((a.points_manquants || []).length) {
      lines.push('', '⚠️ <b>Points faibles</b>', ...a.points_manquants.map((x) => '• ' + esc(x)));
    }
    lines.push(
      '',
      o.contact_email
        ? `📧 Si vous validez : email envoyé à <b>${esc(o.contact_email)}</b> avec votre CV.`
        : "🔗 Si vous validez : pas d'email de contact, le lien pour postuler vous sera renvoyé (lettre prête ci-dessous).",
      '',
      `✉️ <b>Objet :</b> ${esc(o.email_subject)}`,
      '',
      esc(o.cover_letter),
    );
    let text = lines.join('\n');
    if (text.length > 4000) text = text.slice(0, 3990) + '…';
    return { json: { id: o.id, text } };
  });
});

const wf1Nodes = [
  node('Toutes les 6 heures', 'scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'hours', hoursInterval: 6 }] },
  }),
  node('Lancer maintenant', 'manualTrigger', 1, [0, 500], {}),
  node('Lire mon profil', 'readWriteFile', 1, [220, 300], { fileSelector: '/files/profile/profil.md', options: {} }),
  node('Extraire le texte du profil', 'extractFromFile', 1, [440, 300], { operation: 'text', options: {} }),
  jobSource('Remotive', [780, 0], 'https://remotive.com/api/remote-jobs?limit=300'),
  jobSource('RemoteOK', [780, 200], 'https://remoteok.com/api'),
  jobSource('Himalayas', [780, 400], 'https://himalayas.app/jobs/api?limit=20'),
  jobSource('Jobicy', [780, 600], 'https://jobicy.com/api/v2/remote-jobs?count=100'),
  node('Fusionner les sources', 'merge', 3, [1100, 300], { numberInputs: 4 }),
  normalize,
  sql(
    'Enregistrer les nouvelles offres',
    [1560, 300],
    `INSERT INTO offers (source, external_id, dedupe_key, title, company, location, salary, tags,
                    url, apply_url, contact_email, description, published_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULLIF($11, ''), $12, NULLIF($13, '')::timestamptz)
ON CONFLICT (dedupe_key) DO NOTHING;`,
    '={{ [$json.source, $json.external_id, $json.dedupe_key, $json.title, $json.company ?? "", $json.location ?? "", $json.salary ?? "", $json.tags ?? "", $json.url, $json.apply_url ?? $json.url, $json.contact_email ?? "", $json.description ?? "", $json.published_at ?? ""] }}',
  ),
  sql(
    "Prendre la file d'attente",
    [1780, 300],
    `SELECT id, source, title, company, location, salary, tags, url, apply_url, contact_email, description
FROM offers
WHERE status = 'new'
  AND (published_at IS NULL OR published_at > now() - make_interval(days => $2::int))
ORDER BY published_at DESC NULLS LAST
LIMIT $1::int;`,
    '={{ [Number($env.MAX_OFFERS_PER_RUN || 15), Number($env.MAX_AGE_DAYS || 14)] }}',
    { executeOnce: true },
  ),
  prepScoring,
  claudeCall('Claude · scorer l’offre', [2440, 300]),
  parseScore,
  node('Score suffisant ?', 'if', 2, [2880, 300], {
    conditions: conditions([
      cond('={{ $json.score }}', { type: 'number', operation: 'gte' }, '={{ Number($env.MIN_SCORE || 70) }}'),
    ]),
    options: {},
  }),
  sql(
    'Classer : score trop bas',
    [3100, 460],
    `UPDATE offers SET score = $1::int, analysis = $2::jsonb, status = 'filtered' WHERE id = $3::int;`,
    '={{ [$json.score, JSON.stringify($json.analysis), $json.id] }}',
  ),
  prepLetter,
  claudeCall('Claude · rédiger la candidature', [3320, 200]),
  parseLetter,
  sql(
    'Mettre en attente de validation',
    [3760, 200],
    `UPDATE offers
SET score = $1::int, analysis = $2::jsonb, email_subject = $3, cover_letter = $4, status = 'pending_review'
WHERE id = $5::int
RETURNING *;`,
    '={{ [$json.score, JSON.stringify($json.analysis), $json.email_subject, $json.cover_letter, $json.id] }}',
  ),
  composeMessage,
  node(
    'Demander ma validation',
    'telegram',
    1.2,
    [4200, 200],
    {
      chatId: '={{ $env.TELEGRAM_CHAT_ID }}',
      text: '={{ $json.text }}',
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          {
            row: {
              buttons: [
                { text: '✅ Postuler', additionalFields: { callback_data: "={{ 'apply:' + $json.id }}" } },
                { text: '❌ Rejeter', additionalFields: { callback_data: "={{ 'reject:' + $json.id }}" } },
              ],
            },
          },
        ],
      },
      additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
    },
    { credentials: CRED.telegram },
  ),
];

const wf1 = {
  id: 'jobCollect000001',
  name: '1 · Offres remote → scoring Claude → validation Telegram',
  active: false,
  nodes: wf1Nodes,
  connections: connect([
    ['Toutes les 6 heures', 'Lire mon profil'],
    ['Lancer maintenant', 'Lire mon profil'],
    ['Lire mon profil', 'Extraire le texte du profil'],
    ['Extraire le texte du profil', 'Remotive'],
    ['Extraire le texte du profil', 'RemoteOK'],
    ['Extraire le texte du profil', 'Himalayas'],
    ['Extraire le texte du profil', 'Jobicy'],
    ['Remotive', 'Fusionner les sources', 0, 0],
    ['RemoteOK', 'Fusionner les sources', 0, 1],
    ['Himalayas', 'Fusionner les sources', 0, 2],
    ['Jobicy', 'Fusionner les sources', 0, 3],
    ['Fusionner les sources', 'Normaliser et pré-filtrer'],
    ['Normaliser et pré-filtrer', 'Enregistrer les nouvelles offres'],
    ['Enregistrer les nouvelles offres', "Prendre la file d'attente"],
    ["Prendre la file d'attente", 'Préparer le scoring'],
    ['Préparer le scoring', 'Claude · scorer l’offre'],
    ['Claude · scorer l’offre', 'Lire le score'],
    ['Lire le score', 'Score suffisant ?'],
    ['Score suffisant ?', 'Préparer la lettre', 0],
    ['Score suffisant ?', 'Classer : score trop bas', 1],
    ['Préparer la lettre', 'Claude · rédiger la candidature'],
    ['Claude · rédiger la candidature', 'Lire la lettre'],
    ['Lire la lettre', 'Mettre en attente de validation'],
    ['Mettre en attente de validation', 'Composer le message'],
    ['Composer le message', 'Demander ma validation'],
  ]),
  settings: { executionOrder: 'v1', timezone: 'Africa/Dakar' },
  pinData: {},
};

// ============================================================================
// Workflow 2 — Lire mes clics Telegram et agir (envoyer / rejeter)
// ============================================================================

const extractDecisions = code('Extraire les décisions', [660, 300], function () {
  // Polling Telegram : pas besoin d'URL publique ni de tunnel.
  const updates = $input.first().json.result || [];
  if (!updates.length) return [];
  const next_offset = Math.max(...updates.map((u) => u.update_id)) + 1;
  const myChat = String($env.TELEGRAM_CHAT_ID);
  const out = [];
  for (const u of updates) {
    const q = u.callback_query;
    if (!q || String(q.message?.chat?.id) !== myChat) continue; // seuls VOS clics comptent
    const [action, rawId] = String(q.data || '').split(':');
    if (!['apply', 'reject'].includes(action) || !/^\d+$/.test(rawId)) continue;
    out.push({
      json: {
        action,
        offer_id: Number(rawId),
        message_id: q.message.message_id,
        original_text: String(q.message.text || '').slice(0, 3700),
        next_offset,
      },
    });
  }
  // Toujours renvoyer au moins un item pour mémoriser l'offset
  return out.length ? out : [{ json: { action: 'none', next_offset } }];
});

const statusText = (name, position, fn) => code(name, position, fn);

const wf2Nodes = [
  node('Chaque minute', 'scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
  }),
  node('Lancer maintenant', 'manualTrigger', 1, [0, 500], {}),
  sql('Lire l’offset Telegram', [220, 300], `SELECT value::bigint AS next_offset FROM bot_state WHERE key = 'telegram_offset';`),
  node(
    'Lire mes clics Telegram',
    'httpRequest',
    4.2,
    [440, 300],
    {
      url: "={{ ($env.TELEGRAM_API_URL || 'https://api.telegram.org') + '/bot' + $env.TELEGRAM_BOT_TOKEN + '/getUpdates' }}",
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'offset', value: '={{ $json.next_offset }}' },
          { name: 'timeout', value: '0' },
          { name: 'allowed_updates', value: '["callback_query"]' },
        ],
      },
      options: { timeout: 20000 },
    },
  ),
  extractDecisions,
  sql(
    'Mémoriser l’offset',
    [900, 120],
    `UPDATE bot_state SET value = $1 WHERE key = 'telegram_offset';`,
    '={{ [String($json.next_offset)] }}',
    { executeOnce: true },
  ),
  node('Décision', 'switch', 3, [900, 400], {
    rules: {
      values: [
        {
          conditions: conditions([cond('={{ $json.action }}', { type: 'string', operation: 'equals' }, 'apply')]),
          renameOutput: true,
          outputKey: 'Postuler',
        },
        {
          conditions: conditions([cond('={{ $json.action }}', { type: 'string', operation: 'equals' }, 'reject')]),
          renameOutput: true,
          outputKey: 'Rejeter',
        },
      ],
    },
    options: {},
  }),

  // --- Rejet ---
  sql(
    'Marquer rejetée',
    [1140, 620],
    `UPDATE offers SET status = 'rejected', decided_at = now()
WHERE id = $1::int AND status = 'pending_review'
RETURNING id;`,
    '={{ [$json.offer_id] }}',
  ),
  statusText('Texte : rejetée', [1380, 620], function () {
    return $input.all().map((i, idx) => {
      const d = $('Extraire les décisions').itemMatching(idx).json;
      return { json: { message_id: d.message_id, text: `${d.original_text}\n\n❌ REJETÉE` } };
    });
  }),

  // --- Validation ---
  sql(
    'Verrouiller la décision',
    [1140, 300],
    `UPDATE offers SET status = 'approved', decided_at = now()
WHERE id = $1::int AND status = 'pending_review'
RETURNING id, title, company, url, apply_url, contact_email, email_subject, cover_letter,
          analysis->>'langue_offre' AS langue;`,
    '={{ [$json.offer_id] }}',
  ),
  node('Email de contact ?', 'switch', 3, [1380, 300], {
    rules: {
      values: [
        {
          conditions: conditions([
            cond('={{ $json.id }}', { type: 'number', operation: 'exists', singleValue: true }),
            cond('={{ $json.contact_email }}', { type: 'string', operation: 'notEmpty', singleValue: true }),
          ]),
          renameOutput: true,
          outputKey: 'Email',
        },
        {
          conditions: conditions([
            cond('={{ $json.id }}', { type: 'number', operation: 'exists', singleValue: true }),
            cond('={{ $json.contact_email }}', { type: 'string', operation: 'empty', singleValue: true }),
          ]),
          renameOutput: true,
          outputKey: 'Formulaire',
        },
      ],
    },
    options: {},
  }),
  // CV français pour les offres en français, CV anglais (cv.pdf) sinon
  node('Lire mon CV', 'readWriteFile', 1, [1620, 200], {
    fileSelector: "={{ /fran|french/i.test($json.langue || '') ? '/files/profile/cv-fr.pdf' : '/files/profile/cv.pdf' }}",
    options: {},
  }),
  node(
    'Envoyer la candidature',
    'emailSend',
    2.1,
    [1840, 200],
    {
      fromEmail: "={{ $env.CANDIDATE_NAME + ' <' + $env.CANDIDATE_EMAIL + '>' }}",
      toEmail: "={{ $('Verrouiller la décision').item.json.contact_email }}",
      subject: "={{ $('Verrouiller la décision').item.json.email_subject }}",
      emailFormat: 'text',
      text: "={{ $('Verrouiller la décision').item.json.cover_letter }}",
      options: { attachments: 'data', appendAttribution: false, replyTo: '={{ $env.CANDIDATE_EMAIL }}' },
    },
    { credentials: CRED.smtp, onError: 'continueErrorOutput' },
  ),
  sql(
    'Marquer envoyée',
    [2080, 120],
    `UPDATE offers SET status = 'applied', applied_at = now() WHERE id = $1::int RETURNING id, contact_email;`,
    "={{ [$('Verrouiller la décision').item.json.id] }}",
  ),
  sql(
    'Marquer échec d’envoi',
    [2080, 300],
    `UPDATE offers SET status = 'send_failed' WHERE id = $1::int RETURNING id;`,
    "={{ [$('Verrouiller la décision').item.json.id] }}",
  ),
  sql(
    'Marquer à postuler moi-même',
    [1620, 440],
    `UPDATE offers SET status = 'to_apply_manually' WHERE id = $1::int RETURNING id, apply_url;`,
    '={{ [$json.id] }}',
  ),
  statusText('Texte : envoyée', [2320, 120], function () {
    return $input.all().map((i, idx) => {
      const d = $('Extraire les décisions').itemMatching(idx).json;
      return { json: { message_id: d.message_id, text: `${d.original_text}\n\n✅ CANDIDATURE ENVOYÉE à ${i.json.contact_email}` } };
    });
  }),
  statusText('Texte : échec', [2320, 300], function () {
    return $input.all().map((i, idx) => {
      const d = $('Extraire les décisions').itemMatching(idx).json;
      return {
        json: {
          message_id: d.message_id,
          text: `${d.original_text}\n\n⚠️ ÉCHEC DE L'ENVOI (vérifiez SMTP et profile/cv.pdf). L'offre est marquée send_failed.`,
        },
      };
    });
  }),
  statusText('Texte : à postuler', [1860, 440], function () {
    return $input.all().map((i, idx) => {
      const d = $('Extraire les décisions').itemMatching(idx).json;
      return {
        json: {
          message_id: d.message_id,
          text: `${d.original_text}\n\n🟡 VALIDÉE — pas d'email de contact. Postulez ici avec la lettre ci-dessus :\n${i.json.apply_url}`,
        },
      };
    });
  }),
  node(
    'Mettre à jour le message',
    'telegram',
    1.2,
    [2600, 400],
    {
      resource: 'message',
      operation: 'editMessageText',
      messageType: 'message',
      chatId: '={{ $env.TELEGRAM_CHAT_ID }}',
      messageId: '={{ $json.message_id }}',
      text: '={{ $json.text }}',
      replyMarkup: 'none',
      additionalFields: { disable_web_page_preview: true },
    },
    { credentials: CRED.telegram, onError: 'continueRegularOutput' },
  ),
];

const wf2 = {
  id: 'jobValidate00001',
  name: '2 · Mes décisions Telegram → envoi de la candidature',
  active: false,
  nodes: wf2Nodes,
  connections: connect([
    ['Chaque minute', 'Lire l’offset Telegram'],
    ['Lancer maintenant', 'Lire l’offset Telegram'],
    ['Lire l’offset Telegram', 'Lire mes clics Telegram'],
    ['Lire mes clics Telegram', 'Extraire les décisions'],
    ['Extraire les décisions', 'Mémoriser l’offset'],
    ['Extraire les décisions', 'Décision'],
    ['Décision', 'Verrouiller la décision', 0],
    ['Décision', 'Marquer rejetée', 1],
    ['Marquer rejetée', 'Texte : rejetée'],
    ['Verrouiller la décision', 'Email de contact ?'],
    ['Email de contact ?', 'Lire mon CV', 0],
    ['Email de contact ?', 'Marquer à postuler moi-même', 1],
    ['Lire mon CV', 'Envoyer la candidature'],
    ['Envoyer la candidature', 'Marquer envoyée', 0],
    ['Envoyer la candidature', 'Marquer échec d’envoi', 1],
    ['Marquer envoyée', 'Texte : envoyée'],
    ['Marquer échec d’envoi', 'Texte : échec'],
    ['Marquer à postuler moi-même', 'Texte : à postuler'],
    ['Texte : rejetée', 'Mettre à jour le message'],
    ['Texte : envoyée', 'Mettre à jour le message'],
    ['Texte : échec', 'Mettre à jour le message'],
    ['Texte : à postuler', 'Mettre à jour le message'],
  ]),
  settings: { executionOrder: 'v1', timezone: 'Africa/Dakar', saveDataSuccessExecution: 'none' },
  pinData: {},
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, '01-collecte-scoring.json'), JSON.stringify(wf1, null, 2) + '\n');
writeFileSync(join(OUT, '02-validation-telegram.json'), JSON.stringify(wf2, null, 2) + '\n');
console.log('Workflows générés dans', OUT);
