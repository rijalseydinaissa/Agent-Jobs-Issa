#!/usr/bin/env bash
# Test de bout en bout : vraies API d'offres + faux Claude/Telegram/SMTP.
# Scénario : collecte -> scoring -> 1 offre validée avec email, 1 validée sans email,
# 1 rejetée -> vérifie la base, les emails et les messages Telegram.
set -euo pipefail
cd "$(dirname "$0")/.."

export ENV_FILE=tests/test.env
export COMPOSE_FILES="-p rja-test -f docker-compose.yml -f docker-compose.test.yml"
C="docker compose --env-file $ENV_FILE $COMPOSE_FILES"
MOCK=http://localhost:18080
psql() { $C exec -T postgres psql -U n8n -d jobs -At -c "$1"; }
run() { $C exec -T -e N8N_RUNNERS_BROKER_PORT=5699 n8n n8n execute --id="$1" >/dev/null 2>&1; }
fail() { echo "❌ $1"; exit 1; }

CREATED_CV=0
if [ ! -f profile/cv.pdf ]; then printf '%%PDF-1.4\n%% CV de test\n' > profile/cv.pdf; CREATED_CV=1; fi
CREATED_CV_FR=0
if [ ! -f profile/cv-fr.pdf ]; then printf '%%PDF-1.4\n%% CV FR de test\n' > profile/cv-fr.pdf; CREATED_CV_FR=1; fi
CREATED_PROFILE=0
if [ ! -f profile/profil.md ]; then cp profile/profil.example.md profile/profil.md; CREATED_PROFILE=1; fi
cleanup() {
  [ "$CREATED_CV" = 1 ] && rm -f profile/cv.pdf
  [ "$CREATED_CV_FR" = 1 ] && rm -f profile/cv-fr.pdf
  [ "$CREATED_PROFILE" = 1 ] && rm -f profile/profil.md
  [ "${KEEP:-0}" = 1 ] || $C down -v >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

$C down -v >/dev/null 2>&1 || true
./scripts/setup.sh >/dev/null
# Les workflows planifiés tournent aussi : on les désactive pour piloter le test
$C exec -T n8n n8n unpublish:workflow --id=jobCollect000001 >/dev/null 2>&1 || true
$C exec -T n8n n8n unpublish:workflow --id=jobValidate00001 >/dev/null 2>&1 || true

echo "▶ Workflow 1 : collecte + scoring + demande de validation"
run jobCollect000001
collected=$(psql "select count(*) from offers")
pending=$(psql "select count(*) from offers where status='pending_review'")
filtered=$(psql "select count(*) from offers where status='filtered'")
sent=$(curl -s $MOCK/_state | python3 -c "import json,sys; print(len(json.load(sys.stdin)['sent']))")
echo "  offres collectées=$collected  en attente=$pending  filtrées=$filtered  messages Telegram=$sent"
[ "$pending" -ge 3 ] || fail "au moins 3 offres en attente attendues"
[ "$filtered" -ge 1 ] || fail "au moins 1 offre filtrée attendue"
[ "$sent" = "$pending" ] || fail "un message Telegram par offre en attente attendu"

read -r A B R <<<"$(psql "select string_agg(id::text, ' ' order by id) from (select id from offers where status='pending_review' order by id limit 3) t")"
psql "update offers set contact_email='jobs@example.com', analysis = jsonb_set(analysis, '{langue_offre}', '\"français\"') where id=$A; update offers set contact_email=null where id in ($B,$R);" >/dev/null

echo "▶ Clics simulés : postuler #$A (email), postuler #$B (formulaire), rejeter #$R, + un clic d'un inconnu"
curl -s -X POST $MOCK/_click -d "{\"data\":\"apply:$A\"}" >/dev/null
curl -s -X POST $MOCK/_click -d "{\"data\":\"apply:$B\"}" >/dev/null
curl -s -X POST $MOCK/_click -d "{\"data\":\"reject:$R\"}" >/dev/null
curl -s -X POST $MOCK/_click -d "{\"data\":\"apply:$R\",\"chat_id\":999}" >/dev/null

echo "▶ Workflow 2 : traitement des décisions"
run jobValidate00001
sa=$(psql "select status from offers where id=$A")
sb=$(psql "select status from offers where id=$B")
sr=$(psql "select status from offers where id=$R")
echo "  #$A=$sa  #$B=$sb  #$R=$sr"
[ "$sa" = applied ] || fail "#$A devrait être applied"
[ "$sb" = to_apply_manually ] || fail "#$B devrait être to_apply_manually"
[ "$sr" = rejected ] || fail "#$R devrait être rejected (le clic de l'inconnu doit être ignoré)"

mails=$(curl -s http://localhost:18025/api/v1/messages | python3 -c "
import json,sys; d=json.load(sys.stdin)
for m in d['messages']: print(m['To'][0]['Address'], '|', m['Subject'], '| pièces jointes:', m['Attachments'])")
echo "  emails envoyés : $mails"
echo "$mails" | grep -q "jobs@example.com" || fail "email de candidature non reçu"
echo "$mails" | grep -q "pièces jointes: 1" || fail "le CV n'est pas en pièce jointe"
cvname=$(curl -s http://localhost:18025/api/v1/message/latest | python3 -c "import json,sys; print(json.load(sys.stdin)['Attachments'][0]['FileName'])")
echo "  pièce jointe : $cvname (offre en français)"
[ "$cvname" = cv-fr.pdf ] || fail "le CV français aurait dû être joint"

edits=$(curl -s $MOCK/_state | python3 -c "
import json,sys; s=json.load(sys.stdin)
for e in s['edits']: print('  ✎', e['text'].strip().splitlines()[-1][:90])
print(len(s['edits']))")
echo "$edits" | sed '$d'
[ "$(echo "$edits" | tail -1)" = 3 ] || fail "3 messages Telegram mis à jour attendus"

echo "▶ Re-exécution (idempotence) : aucun nouveau traitement attendu"
run jobValidate00001
[ "$(curl -s $MOCK/_state | python3 -c "import json,sys; print(len(json.load(sys.stdin)['edits']))")" = 3 ] || fail "des clics ont été traités deux fois"
[ "$(curl -s http://localhost:18025/api/v1/messages | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")" = 1 ] || fail "email envoyé deux fois"

curl -s $MOCK/_state | python3 -c "
import json,sys; s=json.load(sys.stdin); c=s['claude']
print(f'  appels Claude : {len(c)} (modèle {c[0][\"model\"]}, efforts {sorted(set(x[\"effort\"] for x in c))}, fallbacks {c[0][\"fallbacks\"]})')"
echo "✅ Test de bout en bout réussi"
