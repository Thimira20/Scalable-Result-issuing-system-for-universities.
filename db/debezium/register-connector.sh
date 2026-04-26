#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# register-connector.sh
#
# Purpose: Register the Debezium MySQL connector via the Kafka Connect REST API.
# Run this ONCE after all containers are healthy.
#
# Why a separate script?
#   Debezium Connect doesn't have the connector pre-configured — you register
#   connectors dynamically via its REST API (POST /connectors).
#   This lets you add/remove/update connectors at runtime without restarting.
#
# REST API:
#   POST   /connectors        → create a connector
#   GET    /connectors        → list all connectors
#   GET    /connectors/{name}/status → check health of a specific connector
#   DELETE /connectors/{name} → remove a connector
# ─────────────────────────────────────────────────────────────────────────────

DEBEZIUM_URL="http://localhost:8083"
CONNECTOR_NAME="exam-results-connector"
CONFIG_FILE="$(dirname "$0")/connector-config.json"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Debezium Connector Registration Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Wait for Debezium Connect to be ready ─────────────────────────
echo ""
echo "⏳ Waiting for Debezium Connect to be ready at $DEBEZIUM_URL ..."
until curl -s "$DEBEZIUM_URL/connectors" > /dev/null 2>&1; do
  echo "   Not ready yet. Retrying in 5 seconds..."
  sleep 5
done
echo "✅ Debezium Connect is up!"

# ── Step 2: Check if connector already exists ─────────────────────────────
EXISTING=$(curl -s "$DEBEZIUM_URL/connectors/$CONNECTOR_NAME" | grep -c '"name"')
if [ "$EXISTING" -gt 0 ]; then
  echo ""
  echo "ℹ️  Connector '$CONNECTOR_NAME' already exists."
  echo "   To re-register, delete it first:"
  echo "   curl -X DELETE $DEBEZIUM_URL/connectors/$CONNECTOR_NAME"
  exit 0
fi

# ── Step 3: Register the connector ───────────────────────────────────────
echo ""
echo "📡 Registering connector: $CONNECTOR_NAME ..."
echo ""

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST "$DEBEZIUM_URL/connectors" \
  -H "Content-Type: application/json" \
  -d @"$CONFIG_FILE")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_STATUS:")

if [ "$HTTP_STATUS" = "201" ] || [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Connector registered successfully!"
else
  echo "❌ Registration failed (HTTP $HTTP_STATUS)"
  echo "Response: $BODY"
  exit 1
fi

# ── Step 4: Check connector health ───────────────────────────────────────
echo ""
echo "🔍 Checking connector status..."
sleep 3
STATUS=$(curl -s "$DEBEZIUM_URL/connectors/$CONNECTOR_NAME/status")
echo "$STATUS"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Done! Debezium is now watching MySQL"
echo " exam_db.results → Kafka: exam_db.exam_db.results"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
