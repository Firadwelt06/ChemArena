#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -f apps/server/.env ]; then
  cp apps/server/.env.example apps/server/.env
  echo "Created apps/server/.env with default LAN settings."
fi

npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run build
echo "ChemArena is starting on http://localhost:4174; see the admin dashboard for the LAN URL."
while true; do
  if npm run start --workspace @chemarena/server; then
    exit 0
  else
    status=$?
  fi
  [ "$status" -eq 75 ] || exit "$status"
done
