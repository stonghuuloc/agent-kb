export const SHELLS = ["zsh", "bash", "fish"];

const POSIX = `kbr() {
  local cmd a
  cmd=$(agent-kb resume "$@") || return
  printf '%s\\n' "$cmd"
  printf 'Run it? [y/N] '
  read -r a
  case "$a" in [yY] | [yY][eE][sS]) eval "$cmd" ;; esac
}`;

const FISH = `function kbr
    set -l cmd (agent-kb resume $argv)
    or return
    echo $cmd
    read -l -P 'Run it? [y/N] ' a
    if string match -qir '^y(es)?$' -- $a
        eval $cmd
    end
end`;

/** Shell function \`kbr <query>\`: shows the resume command, runs it only after a y/N confirm. */
export const shellInit = (shell) => (shell === "fish" ? FISH : POSIX);
