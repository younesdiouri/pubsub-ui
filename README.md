# Pub/Sub UI (standalone)

Lightweight UI and API for Google Pub/Sub Emulator.
- Zero external runtime dependencies (Node.js http + fetch only)
- Messages tab (polls emulator subscriptions) and Publish tab
- In-memory store for last N messages (not persisted)

## Configuration (env)
- PUBSUB_PROJECT_ID: Project ID (default: loc-pubsub-lemonde-io)
- PUBSUB_EMULATOR_HOST: host:port of emulator REST (default: loc-pubsub.lemonde.io:8432)
- PORT: HTTP port for the UI (default: 3001)
- MAX_MESSAGES: in-memory ring size (default: 500)

## Endpoints
- GET /. Returns the HTML UI
- GET /healthz -> ok
- GET /api/topics -> { topics: string[] }
- GET /api/messages?subscription=...&q=...&limit=200 -> { count, items }
- POST /api/clear -> 204 (clears the in-memory store)
- POST /api/publish -> publishes a message
  Body:
  {
    "topic": "lemonde-users-loc-mage.sync",
    "type": "mage.sync",         // optional; defaults to suffix derived from topic
    "attributes": {"source": "ui"},
    "data": {"user_id": 1}       // JSON or string
  }

The publish endpoint wraps your payload into the envelope used by phalcon-user:
{
  "body": { "type": "<type>", "payload": <data> },
  "properties": {},
  "headers": {}
}

## Subscriptions model
To avoid interfering with your main consumers, the UI tries to create dedicated 
"<topic>.ui" subscriptions and polls them. Some emulator versions do not allow
creating subscriptions via REST; the UI still shows messages you publish through
it immediately by mirroring the publish into its local store. Messages published
by other producers will appear if the corresponding ".ui" subscription exists and
is being polled.

## Docker
A multi-stage Dockerfile builds TypeScript then runs the minimal Node server.

Build and run via docker compose (this repository's setup):
- Service name: phalcon-user-pubsub-ui (see docker/compose/docker-compose.override.yml)
- Traefik route: https://loc-pubsub-ui.lemonde.io (websecure)

Manual run:
  docker build -t pubsub-ui:dev pubsub-ui
  docker run --rm -e PUBSUB_PROJECT_ID=loc-pubsub-lemonde-io \
    -e PUBSUB_EMULATOR_HOST=loc-pubsub.lemonde.io:8432 \
    -e PORT=3001 -p 3001:3001 pubsub-ui:dev

## Dev locally
  npm install
  npm run build
  node dist/server.js

Then browse http://localhost:3001

## Quick test
- Health: curl -sS http://localhost:3001/healthz
- Topics: curl -sS http://localhost:3001/api/topics | jq
- Publish: curl -sS -H 'content-type: application/json' \
  -d '{"topic":"lemonde-users-loc-mage.sync","type":"mage.sync","data":{"hello":"world"}}' \
  http://localhost:3001/api/publish | jq

