#!/bin/bash
# Apollo.io lookup script
# Usage: apollo-lookup.sh [company|person|domain] [query]
#
# Reads API key from ~/.apollo-api-key (one-line file, chmod 600)
# or APOLLO_API_KEY env var (overrides the file).

set -e

if [ -n "${APOLLO_API_KEY:-}" ]; then
  API_KEY="$APOLLO_API_KEY"
elif [ -f "$HOME/.apollo-api-key" ]; then
  API_KEY=$(cat "$HOME/.apollo-api-key" | tr -d '\n')
else
  echo "error: APOLLO_API_KEY not set and ~/.apollo-api-key not found" >&2
  exit 2
fi

BASE_URL="https://api.apollo.io/v1"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: apollo-lookup.sh [company|person|domain] [query]"
    echo ""
    echo "Examples:"
    echo "  apollo-lookup.sh company 'Acme Inc'"
    echo "  apollo-lookup.sh person 'Jane Doe'"
    echo "  apollo-lookup.sh domain 'example.com'"
    exit 1
fi

TYPE=$1
QUERY=$2

case $TYPE in
    company)
        curl -s -X POST "$BASE_URL/mixed_companies/search" \
            -H "Content-Type: application/json" \
            -H "Cache-Control: no-cache" \
            -H "X-Api-Key: $API_KEY" \
            -d "{
                \"q_organization_name\": \"$QUERY\",
                \"page\": 1,
                \"per_page\": 5
            }" | jq '.'
        ;;

    person)
        curl -s -X POST "$BASE_URL/mixed_people/search" \
            -H "Content-Type: application/json" \
            -H "Cache-Control: no-cache" \
            -H "X-Api-Key: $API_KEY" \
            -d "{
                \"q_person_name\": \"$QUERY\",
                \"page\": 1,
                \"per_page\": 5
            }" | jq '.'
        ;;

    domain)
        curl -s -X POST "$BASE_URL/organizations/enrich" \
            -H "Content-Type: application/json" \
            -H "Cache-Control: no-cache" \
            -H "X-Api-Key: $API_KEY" \
            -d "{
                \"domain\": \"$QUERY\"
            }" | jq '.'
        ;;

    *)
        echo "Unknown type: $TYPE"
        echo "Use: company, person, or domain"
        exit 1
        ;;
esac
