#!/bin/bash
# Sign a Grayjay plugin script and embed the signature into its config.
# Usage: sh ./sign-script.sh <script.js> <config.json>

if [ $# -lt 2 ]; then
    echo "Usage: $0 <script.js> <config.json>"
    exit 1
fi

SCRIPT_FILE="$1"
CONFIG_FILE="$2"

if [ ! -f "$SCRIPT_FILE" ]; then
    echo "Error: Script file '$SCRIPT_FILE' not found."
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file '$CONFIG_FILE' not found."
    exit 1
fi

if [ -z "$SIGNING_PRIVATE_KEY" ]; then
    echo "Error: SIGNING_PRIVATE_KEY environment variable not set."
    echo "Generate a key: ssh-keygen -t rsa -b 2048 -m PEM -f ./private-key.pem"
    echo "Export it: export SIGNING_PRIVATE_KEY=\"\$(base64 -w 0 ./private-key.pem)\""
    exit 1
fi

echo "$SIGNING_PRIVATE_KEY" | base64 -d > /tmp/grayjay_signing_key.pem

SIGNATURE=$(echo -n "$(cat "$SCRIPT_FILE")" | openssl dgst -sha512 -sign /tmp/grayjay_signing_key.pem | base64 -w 0)

rm -f /tmp/grayjay_signing_key.pem

if [ -z "$SIGNATURE" ]; then
    echo "Error: Failed to generate signature."
    exit 1
fi

# Extract public key
echo "$SIGNING_PRIVATE_KEY" | base64 -d > /tmp/grayjay_pubkey.pem
PUBLIC_KEY=$(openssl pkey -in /tmp/grayjay_pubkey.pem -pubout | base64 -w 0)
rm -f /tmp/grayjay_pubkey.pem

if command -v jq &> /dev/null; then
    tmp=$(mktemp)
    jq --arg sig "$SIGNATURE" --arg pub "$PUBLIC_KEY" \
        '.scriptSignature = $sig | .scriptPublicKey = $pub' \
        "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
    echo "Config updated with signature and public key."
else
    echo "jq not found. Please manually set:"
    echo "  scriptSignature: $SIGNATURE"
    echo "  scriptPublicKey: $PUBLIC_KEY"
fi
