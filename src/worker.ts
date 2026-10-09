import {shQuote} from './core';
const workerScript=`set -uo pipefail
umask 077
d="$1"
exec 3<> "$d/requests"
exec 4<> "$d/replies"
while IFS=' ' read -r op rid ms limit script command <&3; do
 [[ "$rid" =~ ^[a-f0-9-]{36}$ ]] || continue
 r="$d/results/$rid"
 if [[ "$op" == QUERY ]]; then printf 'DONE %s\\n' "$rid" >&4; continue; fi
 [[ "$op" == RUN && "$ms" =~ ^[0-9]+$ && "$limit" =~ ^[0-9]+$ ]] || continue
 if [[ -f "$r/state" ]]; then printf 'DONE %s\\n' "$rid" >&4; continue; fi
 mkdir -p -- "$r"
 printf '%s' "$script" | base64 -d > "$r/script.sh"
 cmd=$(printf '%s' "$command" | base64 -d)
 : > "$r/out"; : > "$r/err"
 mkfifo -- "$r/out.pipe" "$r/err.pipe"
 head -c "$((limit+1))" < "$r/out.pipe" > "$r/out" & out_reader=$!
 head -c "$((limit+1))" < "$r/err.pipe" > "$r/err" & err_reader=$!
 export WDX_REQUEST_DIRECTORY="$r"
 setsid bash --noprofile --norc -c "$cmd" > "$r/out.pipe" 2> "$r/err.pipe" < /dev/null & task=$!
 printf 'running %s\\n' "$task" > "$r/state"
 (
  until_ms=$(( $(date +%s%3N) + ms ))
  while kill -0 "$task" 2>/dev/null; do
   reason=''
   if (( $(stat -c%s -- "$r/out") > limit || $(stat -c%s -- "$r/err") > limit )); then reason=output-limit;
   elif (( $(date +%s%3N) >= until_ms )); then reason=timeout; fi
   if [[ -n "$reason" ]]; then printf '%s\\n' "$reason" > "$r/reason"; kill -TERM -- "-$task" 2>/dev/null || true; sleep 0.2; kill -KILL -- "-$task" 2>/dev/null || true; break; fi
   sleep 0.05
  done
 ) & watcher=$!
 wait "$task"; rc=$?
 kill "$watcher" 2>/dev/null || true; wait "$watcher" 2>/dev/null || true
 # Close inherited pipes from orphaned children of short commands. Detached
 # tmux jobs have their own process groups and are deliberately unaffected.
 kill -TERM -- "-$task" 2>/dev/null || true
 wait "$out_reader" 2>/dev/null || true; wait "$err_reader" 2>/dev/null || true
 reason=completed
 if [[ -f "$r/reason" ]]; then reason=$(cat "$r/reason"); fi
 if (( $(stat -c%s -- "$r/out") > limit || $(stat -c%s -- "$r/err") > limit )); then reason=output-limit; fi
 case "$reason" in timeout) rc=124; printf '\\nCommand timed out\\n' >> "$r/err";; output-limit) rc=125; printf '\\nOutput limit exceeded\\n' >> "$r/err";; esac
 truncate -s "$(stat -c%s -- "$r/out" | awk -v max="$limit" '{print ($1>max?max:$1)}')" "$r/out"
 truncate -s "$(stat -c%s -- "$r/err" | awk -v max="$limit" '{print ($1>max?max:$1)}')" "$r/err"
 printf '%s %s\\n' "$reason" "$rc" > "$r/state.tmp"; mv -- "$r/state.tmp" "$r/state"
 rm -f -- "$r/script.sh" "$r/out.pipe" "$r/err.pipe"
 printf 'DONE %s\\n' "$rid" >&4
 # Keep only recent bounded recovery results, never arbitrary project files.
 find "$d/results" -mindepth 2 -maxdepth 2 -name state -mmin +60 -exec sh -c 'case "$(cat "$1")" in running*) ;; *) rm -rf -- "$(dirname -- "$1")";; esac' sh {} \\;
done
`;
const bridgeScript=`set -euo pipefail
umask 077
for tool in tmux bash base64 head setsid stat date mkfifo truncate awk grep find; do command -v "$tool" >/dev/null || { echo "Missing remote worker dependency: $tool" >&2; exit 127; }; done
base="$HOME/.local/state/werodex"
for part in "$base" "$base/control" "$base/control/$id" "$base/control/$id/$slot"; do
 [[ ! -L "$part" ]] || { echo 'Unsafe control state symlink' >&2; exit 9; }
 mkdir -p -- "$part"
 [[ -d "$part" && "$(stat -c%u -- "$part")" = "$(id -u)" && "$(stat -c%a -- "$part")" = 700 ]] || { echo 'Unsafe control state permissions' >&2; exit 9; }
done
d="$base/control/$id/$slot"
mkdir -p -- "$d/results"
for fifo in requests replies; do
 if [[ ! -e "$d/$fifo" ]]; then mkfifo -m 600 -- "$d/$fifo"; fi
 [[ -p "$d/$fifo" && ! -L "$d/$fifo" ]] || exit 9
done
session="wdx-control-$id-$slot"
if ! tmux -L werodex-control has-session -t "$session" 2>/dev/null; then
 printf '%s' "$encoded" | base64 -d > "$d/worker.sh.tmp"
 mv -- "$d/worker.sh.tmp" "$d/worker.sh"
 printf -v launch 'exec bash %q %q' "$d/worker.sh" "$d"
 tmux -L werodex-control new-session -d -s "$session" "$launch"
fi
# Reclaim only the previous bridge for this exact private worker. The tmux
# worker and in-flight command remain alive and can report recovery state.
if [[ -f "$d/bridge.pid" && ! -L "$d/bridge.pid" ]]; then
 old=$(cat "$d/bridge.pid")
 if [[ "$old" =~ ^[0-9]+$ && "$old" != "$$" && -r "/proc/$old/cmdline" ]] && tr '\\0' ' ' < "/proc/$old/cmdline" | grep -Fq -- "id='$id'"; then kill -TERM "$old" 2>/dev/null || true; for attempt in {1..20}; do kill -0 "$old" 2>/dev/null || break; sleep 0.05; done; fi
fi
printf '%s\\n' "$$" > "$d/bridge.pid"
trap 'if [[ "$(cat "$d/bridge.pid" 2>/dev/null)" = "$$" ]]; then rm -f -- "$d/bridge.pid"; fi' EXIT
exec 5<> "$d/requests"
exec 6<> "$d/replies"
printf 'READY\\n'
emit() {
 rid="$1"; query_slot="\${2:-$slot}"; [[ "$query_slot" =~ ^[01]$ ]] || exit 9; r="$base/control/$id/$query_slot/results/$rid"
 if [[ ! -f "$r/state" ]]; then printf 'U %s missing\\n' "$rid"; return; fi
 read -r state code < "$r/state"
 if [[ "$state" == running ]]; then if [[ "$code" =~ ^[0-9]+$ && -r "/proc/$code/environ" ]] && tr '\\0' '\\n' < "/proc/$code/environ" | grep -Fxq -- "WDX_REQUEST_DIRECTORY=$r"; then printf 'U %s running\\n' "$rid"; else printf 'U %s unknown\\n' "$rid"; fi; return; fi
 printf 'B %s %s %s\\n' "$rid" "$code" "$state"
 base64 -w 32768 -- "$r/out" | while IFS= read -r line; do printf 'O %s %s\\n' "$rid" "$line"; done
 base64 -w 32768 -- "$r/err" | while IFS= read -r line; do printf 'E %s %s\\n' "$rid" "$line"; done
 printf 'D %s\\n' "$rid"
}
while IFS= read -r line; do
 read -r op rid rest <<< "$line"
 [[ "$rid" =~ ^[a-f0-9-]{36}$ ]] || exit 9
 if [[ "$op" == QUERY ]]; then emit "$rid" "\${rest:-$slot}"; continue; fi
 [[ "$op" == RUN ]] || exit 9
 printf '%s\\n' "$line" >&5
 while IFS=' ' read -r done_id done_rid <&6; do [[ "$done_id" == DONE && "$done_rid" == "$rid" ]] && break; done
 emit "$rid"
done
`;
export function controlBootstrap(id:string,slot:number){return 'id='+shQuote(id)+'\nslot='+slot+'\nencoded='+shQuote(Buffer.from(workerScript).toString('base64'))+'\n'+bridgeScript;}
