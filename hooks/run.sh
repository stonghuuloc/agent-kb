#!/bin/sh
# usage: run.sh server | hook <name> | cli <args…> | check
# Node guard: no node, or node < 22.13 → one-line hint on stderr; hooks exit 0, the rest exit 1.
mode=${1:-}
[ $# -gt 0 ] && shift
root=${0%/*}/..
ok=$root/node_modules/.agent-kb-ok
hint="agent-kb needs Node >= 22.13 (https://nodejs.org/en/download or: nvm install 22). Claude Code's native installer ships no Node."
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
{ [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; } || fail "node v$v is too old. $hint"

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
  check) echo "agent-kb: node v$v ok" ;;
  hook) [ -f "$ok" ] || exit 0; exec node "$root/bin/agent-kb.js" hook "$@" ;;
  cli) exec node "$root/bin/agent-kb.js" "$@" ;;
  server)
    if [ ! -f "$ok" ]; then
      command -v npm >/dev/null 2>&1 || fail "npm not found; cannot install agent-kb's dependencies. $hint"
      lock="$root/.install.lock" # symlink to the holder's pid: created and owned in one step
      n=0
      until ln -s "$$" "$lock" 2>/dev/null; do
        [ -f "$ok" ] && break
        if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
          ln -s "$$" "$lock" 2>/dev/null && break
          { [ -e "$lock" ] || [ -L "$lock" ]; } || fail "cannot create the install lock in $root"
          continue
        fi
        pid=$(readlink "$lock" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
          n=$((n + 1))
          [ "$n" -gt 120 ] && fail "another start is still installing dependencies"
          sleep 1
        elif mv "$lock" "$lock.$$" 2>/dev/null; then
          # only one waiter wins the rename; give back a live lock grabbed by mistake
          if [ "$(readlink "$lock.$$")" = "$pid" ]; then rm -f "$lock.$$"; else mv "$lock.$$" "$lock" 2>/dev/null || rm -f "$lock.$$"; fi
        elif [ -e "$lock" ] || [ -L "$lock" ]; then
          fail "cannot take over the stale install lock $lock"
        fi
      done
      if [ ! -f "$ok" ]; then
        trap 'rm -f "$lock"' EXIT
        trap 'exit 1' INT TERM HUP
        (cd "$root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2) || fail "npm ci failed"
        : >"$ok"
        trap - EXIT INT TERM HUP
      fi
      [ "$(readlink "$lock" 2>/dev/null)" = "$$" ] && rm -f "$lock"
    fi
    exec node "$root/src/server.js"
    ;;
  *) fail "usage: run.sh server | hook <name> | cli <args> | check" ;;
esac
