#!/usr/bin/env bash
# Local dev check for the role-harness work.
#
# Bundles the checks that cannot run in the Cowork sandbox (its network egress
# blocks elm.edina.ac.uk) so they can be run in one go on a machine that reaches
# ELM and has .env.local. Offline unit tests run everywhere.
#
# Usage:
#   ./scripts/dev-check.sh                 # unit tests + ELM probe
#   ./scripts/dev-check.sh --unit          # offline unit tests only
#   ./scripts/dev-check.sh --probe         # ELM capability probe only
#   ./scripts/dev-check.sh --battery       # also run the full task battery (slow)
#   ./scripts/dev-check.sh --battery --tier 1   # battery, single tier (passes args through)
#
# Exit non-zero if any selected section fails.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

RUN_UNIT=1; RUN_PROBE=1; RUN_BATTERY=0
BATTERY_ARGS=()
ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)    ONLY=1; RUN_UNIT=1; RUN_PROBE=0; RUN_BATTERY=0; shift ;;
    --probe)   ONLY=1; RUN_UNIT=0; RUN_PROBE=1; RUN_BATTERY=0; shift ;;
    --battery) RUN_BATTERY=1; shift ;;
    *)         BATTERY_ARGS+=("$1"); shift ;;
  esac
done
# --battery without an --only flag keeps unit+probe on too, unless an --only was given.
if [[ $RUN_BATTERY -eq 1 && $ONLY -eq 0 ]]; then RUN_UNIT=1; RUN_PROBE=1; fi

FAIL=0
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
mark()    { if [[ $1 -eq 0 ]]; then printf '\033[32mPASS\033[0m %s\n' "$2"; else printf '\033[31mFAIL\033[0m %s\n' "$2"; FAIL=1; fi; }

if [[ $RUN_UNIT -eq 1 ]]; then
  section "Offline unit tests (node --test)"
  node --test tests/unit/*.test.mjs
  mark $? "unit tests"
fi

if [[ $RUN_PROBE -eq 1 ]]; then
  section "ELM capability probe"
  node scripts/probe-elm-capabilities.mjs
  mark $? "ELM probe"
fi

if [[ $RUN_BATTERY -eq 1 ]]; then
  section "Task battery (starts a local server, calls ELM)"
  npm run benchmark:task-battery -- "${BATTERY_ARGS[@]}"
  mark $? "task battery"
fi

section "Summary"
if [[ $FAIL -eq 0 ]]; then printf '\033[32mAll selected checks passed.\033[0m\n'; else printf '\033[31mOne or more checks failed.\033[0m\n'; fi
exit $FAIL
