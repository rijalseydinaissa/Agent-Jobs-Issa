#!/usr/bin/env bash
# Démarre la stack, crée les identifiants n8n depuis .env et importe/active les workflows.
# Relançable sans risque (les imports écrasent par id).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f "${ENV_FILE:-.env}" ] || { echo "❌ .env manquant : cp .env.example .env puis remplissez-le"; exit 1; }
[ -f profile/profil.md ] || { echo "❌ profile/profil.md manquant : cp profile/profil.example.md profile/profil.md"; exit 1; }
[ -f profile/cv.pdf ] || echo "⚠️  profile/cv.pdf (CV anglais) absent : l'envoi par email échouera tant que vous ne l'ajoutez pas."
[ -f profile/cv-fr.pdf ] || echo "⚠️  profile/cv-fr.pdf (CV français) absent : l'envoi échouera pour les offres en français."

set -a; source "${ENV_FILE:-.env}"; set +a
COMPOSE="docker compose --env-file ${ENV_FILE:-.env} ${COMPOSE_FILES:-}"
for v in N8N_ENCRYPTION_KEY POSTGRES_PASSWORD ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  [ -n "${!v:-}" ] || { echo "❌ $v est vide dans .env"; exit 1; }
done

echo "▶ Génération des workflows"
node scripts/build-workflows.mjs

echo "▶ Démarrage de Postgres + n8n"
mkdir -p .import
$COMPOSE up -d --wait

echo "▶ Création des identifiants (chiffrés par n8n à l'import)"
python3 - <<'PY'
import json, os
e = os.environ
creds = [
  {"id": "jobsPgCred000001", "name": "Postgres (jobs)", "type": "postgres",
   "data": {"host": "postgres", "port": 5432, "database": "jobs",
            "user": e["POSTGRES_USER"], "password": e["POSTGRES_PASSWORD"], "ssl": "disable"}},
  {"id": "anthropicKey0001", "name": "Anthropic API key", "type": "httpHeaderAuth",
   "data": {"name": "x-api-key", "value": e["ANTHROPIC_API_KEY"]}},
  {"id": "telegramBot00001", "name": "Telegram bot", "type": "telegramApi",
   "data": {"accessToken": e["TELEGRAM_BOT_TOKEN"],
            "baseUrl": e.get("TELEGRAM_API_URL") or "https://api.telegram.org"}},
  {"id": "smtpMailCred0001", "name": "SMTP candidatures", "type": "smtp",
   "data": {"user": e.get("SMTP_USER", ""), "password": e.get("SMTP_PASSWORD", ""),
            "host": e.get("SMTP_HOST", ""), "port": int(e.get("SMTP_PORT") or 465),
            "secure": str(e.get("SMTP_PORT") or "465") == "465"}},
]
with open(".import/credentials.json", "w") as f:
    json.dump(creds, f)
PY
trap 'rm -f .import/credentials.json' EXIT
$COMPOSE exec -T n8n n8n import:credentials --input=/import/secrets/credentials.json

echo "▶ Import des workflows"
$COMPOSE exec -T n8n n8n import:workflow --separate --input=/import/workflows

echo "▶ Activation"
$COMPOSE exec -T n8n n8n publish:workflow --id=jobCollect000001
$COMPOSE exec -T n8n n8n publish:workflow --id=jobValidate00001
$COMPOSE restart n8n >/dev/null

echo
echo "✅ Prêt. Ouvrez http://localhost:5678 (créez votre compte au premier lancement)."
echo "   Lancez le workflow « 1 · Offres remote… » à la main une première fois pour tester."
