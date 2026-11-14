#!/bin/sh
# usage: run.sh server | hook <name> | cli <args…> | check  (server: hooks/launch.cjs, which .mcp.json runs directly)
# Node guard: no node, or node < 22.16 (first node:sqlite with FTS5) → one-line hint on stderr; hooks exit 0, the rest exit 1.
mode=${1:-}
[ $# -gt 0 ] && shift
root=${0%/*}/..
ok=$root/node_modules/.agent-kb-ok
hint="agent-kb needs Node >= 22.16 (https://nodejs.org/en/download or: nvm install 22). Claude Code's native installer ships no Node."
deps="dependencies are not installed yet: the MCP server installs them (needs npm) on its first start, so start a new Claude Code session or run /reload-plugins."
fail() {
  echo "agent-kb: $1" >&2
  [ "$mode" = hook ] && exit 0
  exit 1
}
v=$(node --version 2>/dev/null) || fail "node not found. $hint"
v=${v#v}
major=${v%%.*}
rest=${v#*.}
minor=${rest%%.*}
case "$major$minor" in *[!0-9]* | "") fail "cannot read node version '$v'. $hint" ;; esac
{ [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 16 ]; }; } || fail "node v$v is too old. $hint"

# plugin options reach us as CLAUDE_PLUGIN_OPTION_<KEY upper-cased>; an AGENT_KB_* already set wins
opt() {
  eval "val=\${CLAUDE_PLUGIN_OPTION_$2:-}"
  eval "cur=\${$1:-}"
  case "$val" in '' | '${'*) return 0 ;; esac
  [ -z "$cur" ] && export "$1=$val"
  return 0
}
opt AGENT_KB_SUMMARIZER SUMMARIZER
opt AGENT_KB_SOURCES SOURCES
opt AGENT_KB_VAULT VAULT_DIR
opt AGENT_KB_VAULT_FOLDER VAULT_FOLDER
opt AGENT_KB_API_KEY API_KEY

case "$mode" in
  check) [ -f "$ok" ] || fail "$deps"; echo "agent-kb: node v$v ok" ;;
  hook) [ -f "$ok" ] || exit 0; exec node --disable-warning=ExperimentalWarning "$root/bin/agent-kb.js" hook "$@" ;;
  cli) [ -f "$ok" ] || fail "$deps"; exec node --disable-warning=ExperimentalWarning "$root/bin/agent-kb.js" "$@" ;;
  server) exec node "$root/hooks/launch.cjs" "$@" ;;
  *) fail "usage: run.sh server | hook <name> | cli <args> | check" ;;
esac
