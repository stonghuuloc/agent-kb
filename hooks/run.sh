#!/bin/sh
# usage: run.sh server | hook <name> | cli <args…> | check
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
  hook) [ -f "$ok" ] || exit 0; exec node "$root/bin/agent-kb.js" hook "$@" ;;
  cli) [ -f "$ok" ] || fail "$deps"; exec node "$root/bin/agent-kb.js" "$@" ;;
  server)
    if [ ! -f "$ok" ]; then
      command -v npm >/dev/null 2>&1 || fail "npm not found; cannot install agent-kb's dependencies. $hint"
      [ -w "$root" ] || fail "cannot write to $root, where agent-kb installs its dependencies"
      lock="$root/.install.lock" # symlink to the holder's pid: created and owned in one step
      n=0
      until ln -s "$$" "$lock" 2>/dev/null; do
        [ -f "$ok" ] && break
        pid=$(readlink "$lock" 2>/dev/null)
        n=$((n + 1))
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && mkdir "$lock.break" 2>/dev/null; then
          # one breaker at a time; a dead holder's link cannot change until someone removes it
          trap 'rmdir "$lock.break" 2>/dev/null; exit 1' INT TERM HUP
          [ "$(readlink "$lock" 2>/dev/null)" = "$pid" ] && rm -f "$lock"
          rmdir "$lock.break"
          trap - INT TERM HUP
          continue
        fi
        [ "$n" -gt 120 ] && fail "could not take the install lock in 2 minutes (remove $lock and $lock.break if no install is running)"
        sleep 1
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
