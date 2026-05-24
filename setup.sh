#!/bin/bash
# AI Assistant - Interactive Setup
# Walks a new user through configuring their personal AI assistant.

set -e

echo "============================================"
echo "  AI Assistant Setup"
echo "  Powered by Claude Code"
echo "============================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

prompt() {
  local var_name=$1
  local prompt_text=$2
  local default=$3
  if [ -n "$default" ]; then
    read -p "$(echo -e "${BLUE}${prompt_text}${NC} [${default}]: ")" value
    eval "$var_name=\"${value:-$default}\""
  else
    read -p "$(echo -e "${BLUE}${prompt_text}${NC}: ")" value
    eval "$var_name=\"$value\""
  fi
}

prompt_choice() {
  local var_name=$1
  local prompt_text=$2
  shift 2
  local options=("$@")
  echo -e "${BLUE}${prompt_text}${NC}"
  for i in "${!options[@]}"; do
    echo "  $((i+1)). ${options[$i]}"
  done
  read -p "Choose (1-${#options[@]}): " choice
  eval "$var_name=\"${options[$((choice-1))]}\""
}

echo -e "${GREEN}Let's set up your AI assistant.${NC}"
echo ""

# Basic info
prompt OWNER_NAME "Your name"
prompt ASSISTANT_NAME "Name for your assistant" "Atlas"
prompt TIMEZONE "Your timezone" "America/New_York"
prompt CITY "Your city (for weather)" "New York"

# Platform
echo ""
prompt_choice PLATFORM "Which messaging platform?" "Telegram" "Slack" "Discord" "Teams"

# Personality
echo ""
echo -e "${YELLOW}How should your assistant communicate?${NC}"
echo "  1. Professional and efficient"
echo "  2. Friendly and conversational"
echo "  3. Direct and no-nonsense"
echo "  4. Custom (you'll write it)"
read -p "Choose (1-4): " vibe_choice

case $vibe_choice in
  1) PERSONALITY_VIBE="Professional, efficient, precise. Communicate clearly without unnecessary filler. Prioritize accuracy and actionability." ;;
  2) PERSONALITY_VIBE="Warm but efficient. Conversational tone without being chatty. Personable, remembers context, occasionally lighthearted." ;;
  3) PERSONALITY_VIBE="Direct, sharp, no fluff. Say what needs saying and move on. Push back when something doesn't make sense. Have opinions." ;;
  4) prompt PERSONALITY_VIBE "Describe the vibe in 1-2 sentences" ;;
esac

# Bio
echo ""
echo -e "${YELLOW}Tell the assistant about yourself (1-3 sentences).${NC}"
echo "Include: your role, your business/industry, what kind of help you need."
read -p "> " OWNER_BIO

# Email
echo ""
prompt_choice EMAIL_PROVIDER "Email provider?" "Gmail" "Outlook/Microsoft 365" "Both" "Skip for now"

INSTALLED_SKILLS="weather"

case $EMAIL_PROVIDER in
  "Gmail")
    prompt EMAIL_ADDRESS "Gmail address"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail"
    ;;
  "Outlook/Microsoft 365")
    prompt EMAIL_ADDRESS "Outlook email address"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, outlook"
    ;;
  "Both")
    prompt GMAIL_ADDRESS "Gmail address"
    prompt OUTLOOK_ADDRESS "Outlook email address"
    EMAIL_ADDRESS="$GMAIL_ADDRESS"
    INSTALLED_SKILLS="$INSTALLED_SKILLS, gmail, outlook"
    ;;
  "Skip for now")
    EMAIL_ADDRESS=""
    ;;
esac

# Email signature
echo ""
prompt EMAIL_SIG_NAME "Name for email signature" "$OWNER_NAME"
prompt EMAIL_SIG_TITLE "Title/role" ""
prompt EMAIL_SIG_PHONE "Phone" ""
prompt EMAIL_SIG_EMAIL "Email" "$EMAIL_ADDRESS"

EMAIL_SIGNATURE="${EMAIL_SIG_NAME}"
[ -n "$EMAIL_SIG_TITLE" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_TITLE}"
[ -n "$EMAIL_SIG_PHONE" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_PHONE}"
[ -n "$EMAIL_SIG_EMAIL" ] && EMAIL_SIGNATURE="${EMAIL_SIGNATURE}\n${EMAIL_SIG_EMAIL}"

# Location for weather
echo ""
echo -e "${YELLOW}Setting up weather skill...${NC}"
echo "Look up your coordinates at: https://www.latlong.net/"
prompt LATITUDE "Latitude" "40.71"
prompt LONGITUDE "Longitude" "-74.01"
prompt_choice TEMP_UNIT "Temperature unit?" "celsius" "fahrenheit"

# Project path
PROJECT_PATH="$(pwd)"

echo ""
echo -e "${GREEN}Generating configuration files...${NC}"

# Generate CLAUDE.md
TEMPLATE_DIR="$(dirname "$0")"

# Determine platform format notes
case $PLATFORM in
  "Telegram")
    PLATFORM_FORMAT_NOTES="- Telegram supports limited HTML formatting (bold, italic, code, links)"
    HOST_OS="Mac"
    ;;
  "Slack")
    PLATFORM_FORMAT_NOTES="- Slack supports mrkdwn formatting (bold, italic, code blocks, links, lists)"
    HOST_OS="Mac"
    ;;
  "Discord")
    PLATFORM_FORMAT_NOTES="- Discord supports Markdown formatting (bold, italic, code blocks, embeds)"
    HOST_OS="Mac"
    ;;
  "Teams")
    PLATFORM_FORMAT_NOTES="- Teams supports Adaptive Cards and basic Markdown"
    HOST_OS="Mac"
    ;;
esac

# Generate CLAUDE.md from template
sed \
  -e "s|{{ASSISTANT_NAME}}|${ASSISTANT_NAME}|g" \
  -e "s|{{OWNER_NAME}}|${OWNER_NAME}|g" \
  -e "s|{{PLATFORM}}|${PLATFORM}|g" \
  -e "s|{{HOST_OS}}|${HOST_OS}|g" \
  -e "s|{{PERSONALITY_VIBE}}|${PERSONALITY_VIBE}|g" \
  -e "s|{{TIMEZONE}}|${TIMEZONE}|g" \
  -e "s|{{PROJECT_PATH}}|${PROJECT_PATH}|g" \
  -e "s|{{INSTALLED_SKILLS}}|${INSTALLED_SKILLS}|g" \
  -e "s|{{PLATFORM_FORMAT_NOTES}}|${PLATFORM_FORMAT_NOTES}|g" \
  -e "s|{{OWNER_BIO}}|${OWNER_BIO}|g" \
  -e "s|{{CUSTOM_RULES}}||g" \
  -e "s|{{EMAIL_SIGNATURE}}|${EMAIL_SIGNATURE}|g" \
  "${TEMPLATE_DIR}/CLAUDE.md.template" > CLAUDE.md

echo -e "  ${GREEN}Created${NC} CLAUDE.md"

# Copy and configure skills
mkdir -p skills

# Weather skill
cp -r "${TEMPLATE_DIR}/skills/weather" skills/
sed -i '' \
  -e "s|{{LATITUDE}}|${LATITUDE}|g" \
  -e "s|{{LONGITUDE}}|${LONGITUDE}|g" \
  -e "s|{{TEMP_UNIT}}|${TEMP_UNIT}|g" \
  -e "s|{{TIMEZONE}}|${TIMEZONE}|g" \
  -e "s|{{CITY}}|${CITY}|g" \
  skills/weather/manifest.json 2>/dev/null || true

echo -e "  ${GREEN}Created${NC} skills/weather/"

# Gmail skill
if [[ "$INSTALLED_SKILLS" == *"gmail"* ]]; then
  cp -r "${TEMPLATE_DIR}/skills/gmail" skills/
  GMAIL_ADDR="${GMAIL_ADDRESS:-$EMAIL_ADDRESS}"
  sed -i '' "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDR}|g" skills/gmail/SKILL.md 2>/dev/null || true
  sed -i '' "s|{{EMAIL_ADDRESS}}|${GMAIL_ADDR}|g" skills/gmail/manifest.json 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/gmail/"
fi

# Outlook skill
if [[ "$INSTALLED_SKILLS" == *"outlook"* ]]; then
  cp -r "${TEMPLATE_DIR}/skills/outlook" skills/
  OUTLOOK_ADDR="${OUTLOOK_ADDRESS:-$EMAIL_ADDRESS}"
  sed -i '' "s|{{EMAIL_ADDRESS}}|${OUTLOOK_ADDR}|g" skills/outlook/SKILL.md 2>/dev/null || true
  echo -e "  ${GREEN}Created${NC} skills/outlook/"
fi

# Create .env template
if [ ! -f .env ]; then
  cat > .env << ENVEOF
# AI Assistant Configuration
# Generated by setup.sh

# Platform credentials (fill in after creating your bot)
ENVEOF

  case $PLATFORM in
    "Telegram")
      cat >> .env << ENVEOF
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=
ENVEOF
      ;;
    "Slack")
      cat >> .env << ENVEOF
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_ALLOWED_USERS=
ENVEOF
      ;;
    "Discord")
      cat >> .env << ENVEOF
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USERS=
ENVEOF
      ;;
    "Teams")
      cat >> .env << ENVEOF
TEAMS_APP_ID=
TEAMS_APP_SECRET=
TEAMS_TENANT_ID=
ENVEOF
      ;;
  esac

  echo -e "  ${GREEN}Created${NC} .env (fill in your credentials)"
fi

# Create projects folder
mkdir -p projects
echo -e "  ${GREEN}Created${NC} projects/"

# Create store folder
mkdir -p store
echo -e "  ${GREEN}Created${NC} store/"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Fill in your bot credentials in .env"
echo "     (See SETUP-GUIDE.md for platform-specific instructions)"
echo ""

if [[ "$INSTALLED_SKILLS" == *"gmail"* ]]; then
  echo "  2. Authenticate Gmail:"
  echo "     brew install gogcli"
  echo "     gog auth add ${GMAIL_ADDR:-$EMAIL_ADDRESS} --services gmail,calendar"
  echo ""
fi

if [[ "$INSTALLED_SKILLS" == *"outlook"* ]]; then
  echo "  2. Set up Microsoft 365 credentials in .env"
  echo "     (See SETUP-GUIDE.md > Outlook Setup)"
  echo ""
fi

echo "  3. Install and build:"
echo "     npm install && npm run build"
echo ""
echo "  4. Test locally:"
echo "     node dist/src/index.js"
echo ""
echo "  5. Set up as a persistent service:"
echo "     (See SETUP-GUIDE.md > Step 6)"
echo ""
echo "  6. Message your bot and say hello!"
echo ""
