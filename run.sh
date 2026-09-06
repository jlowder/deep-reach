#!/usr/bin/env bash
# run.sh — single root orchestrator for the four deep-reach services.
#
# Commands: start | stop | restart | status | logs [service|all] | help
#
# bash-3.2 (macOS) compatible: no declare -A, no readarray/mapfile, no ${var,,},
# no `wait -n`. Only `set -u` — errors are handled explicitly so a non-fatal
# probe or skip never aborts the whole run.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"

# ---------------------------------------------------------------------------
# Service table (parallel indexed arrays, in DEPENDENCY order:
# worker -> backend -> api -> web; web calls api; api proxies to worker+backend)
# ---------------------------------------------------------------------------
SVC_NAMES=(worker backend api web)
SVC_DIRS=(deep-reach-worker deep-reach-backend deep-reach-api deep-reach-web)
SVC_RUNTIMES=(python node bun node)
SVC_CMDS=("venv/bin/python api_server.py" "npm run serve" "bun run src/index.ts" "npm run dev")
SVC_PORTS=(8321 8322 8320 8323)
SVC_HEALTH=(/health /openapi.json /health /)

NUM_SVCS=${#SVC_NAMES[@]}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# port_open <port> [host] — TCP connect check via /dev/tcp (no nc dependency).
port_open() {
  local port="$1" host="${2:-127.0.0.1}"
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
}

# pid_alive <pid> — true if the pid is a live process.
pid_alive() {
  local p="${1:-}"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null
}

# descendants_of <pid> — print all descendant pids of <pid> (recursive).
descendants_of() {
  local p="$1" c
  for c in $(ps -ax -o pid=,ppid= | awk -v p="$p" '$2 == p { print $1 }'); do
    printf '%s ' "$c"
    descendants_of "$c"
  done
}

# kill_subtree <pid> [signal] — send a signal to <pid> and every descendant.
# (The launched pid can be a wrapper subshell whose child is the real server,
# so killing only the recorded pid would orphan the service.)
kill_subtree() {
  local p="$1" sig="${2:-TERM}" c
  for c in $(descendants_of "$p"); do
    kill -"$sig" "$c" 2>/dev/null
  done
  kill -"$sig" "$p" 2>/dev/null
}

# svc_idx <name> — print the table index of a service name; fail if unknown.
svc_idx() {
  local i
  for ((i = 0; i < NUM_SVCS; i++)); do
    if [ "${SVC_NAMES[$i]}" = "$1" ]; then
      printf '%s' "$i"
      return 0
    fi
  done
  return 1
}

# runtime_ok <name> <dir> — true if the runtime needed to launch the service exists.
runtime_ok() {
  case "$1" in
    worker) [ -x "$ROOT/$2/venv/bin/python" ] ;;
    api) command -v bun >/dev/null 2>&1 ;;
    *) command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 ;;
  esac
}

warn() { printf 'WARNING: %s\n' "$*"; }

pidfile_of() { printf '%s/%s.pid' "$LOGS" "$1"; }

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------
cmd_start() {
  mkdir -p "$LOGS"
  local i name dir port pidfile pid code
  local -a states=() launched=()
  for ((i = 0; i < NUM_SVCS; i++)); do
    states[i]="down"
    launched[i]=0
  done

  for ((i = 0; i < NUM_SVCS; i++)); do
    name="${SVC_NAMES[$i]}"
    dir="${SVC_DIRS[$i]}"
    port="${SVC_PORTS[$i]}"
    pidfile="$(pidfile_of "$name")"

    # 1) already running? (pid file present and alive)
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if pid_alive "$pid"; then
        states[i]="already-running"
        echo "$name: already running (pid $pid, port $port) — skipping"
        continue
      fi
      rm -f "$pidfile" # stale
    fi

    # 2) runtime available? (non-fatal: warn + skip)
    if ! runtime_ok "$name" "$dir"; then
      states[i]="skipped-missing-runtime"
      case "$name" in
        worker) warn "$name: $dir/venv/bin/python not found — skipping" ;;
        api) warn "$name: bun not found on PATH — skipping" ;;
        *) warn "$name: npm/node not found on PATH — skipping" ;;
      esac
      continue
    fi

    # 3) launch detached (nohup; output to logs/<svc>.log, pid to logs/<svc>.pid)
    ( cd "$ROOT/$dir" && nohup ${SVC_CMDS[$i]} >>"$LOGS/$name.log" 2>&1 & echo $! >"$LOGS/$name.pid" )
    states[i]="starting"
    launched[i]=1
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    echo "$name: launched (pid ${pid:-?}, port $port)"
  done

  # 4) poll launched ports until all listening or ~90s timeout
  local deadline=$(( $(date +%s) + 90 )) allup
  while :; do
    allup=1
    for ((i = 0; i < NUM_SVCS; i++)); do
      if [ "${launched[$i]}" = 1 ] && ! port_open "${SVC_PORTS[$i]}"; then
        allup=0
      fi
    done
    [ "$allup" = 1 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 2
  done
  for ((i = 0; i < NUM_SVCS; i++)); do
    if [ "${launched[$i]}" = 1 ]; then
      if port_open "${SVC_PORTS[$i]}"; then states[i]="up"
      else states[i]="down"
      fi
    fi
  done

  # 5) summary table
  echo
  printf '%-8s  %-24s  %-6s  %-28s  %s\n' "service" "state" "port" "url" "log file"
  printf '%-8s  %-24s  %-6s  %-28s  %s\n' "-------" "------------------------" "------" "----------------------------" "-----------------"
  for ((i = 0; i < NUM_SVCS; i++)); do
    printf '%-8s  %-24s  %-6s  %-28s  %s\n' \
      "${SVC_NAMES[$i]}" "${states[$i]}" "${SVC_PORTS[$i]}" \
      "http://localhost:${SVC_PORTS[$i]}" "logs/${SVC_NAMES[$i]}.log"
  done

  # 6) soft check of the external LLM endpoint (non-fatal)
  if [ "${states[0]}" = "up" ] || [ "${states[0]}" = "already-running" ]; then
    check_llm
  fi

  # exit non-zero only if a service we actually launched is not listening
  local rc=0
  for ((i = 0; i < NUM_SVCS; i++)); do
    [ "${states[$i]}" = "down" ] && rc=1
  done
  return "$rc"
}

# Soft check: is the LLM endpoint the worker calls reachable? (never fatal)
check_llm() {
  local envfile="$ROOT/deep-reach-worker/utils/var.env"
  local ep="http://localhost:8080" v rest hostport host port
  if [ -f "$envfile" ]; then
    v="$(grep -E '^LLM_ENDPOINT=' "$envfile" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
    [ -n "$v" ] && ep="$v"
  fi
  rest="${ep#http://}"
  hostport="${rest%%/*}"
  host="${hostport%:*}"
  port="${hostport##*:}"
  case "$hostport" in
    *:*) : ;; # has an explicit port
    *) port="8080" ;;
  esac
  [ -n "$host" ] || host="127.0.0.1"
  if port_open "$port" "$host"; then
    echo "LLM endpoint $ep (from utils/var.env): reachable"
  else
    warn "worker is up but LLM endpoint $ep is not reachable — research requests will fail until that server is running."
  fi
}

# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------
cmd_stop() {
  local i name pidfile pid n port still=0 stopped_pids=""
  # reverse dependency order: web, api, backend, worker
  for ((i = NUM_SVCS - 1; i >= 0; i--)); do
    name="${SVC_NAMES[$i]}"
    pidfile="$(pidfile_of "$name")"
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if pid_alive "$pid"; then
        kill_subtree "$pid" TERM
        n=0
        while pid_alive "$pid" && [ "$n" -lt 20 ]; do sleep 0.5; n=$((n + 1)); done
        if pid_alive "$pid"; then
          kill_subtree "$pid" KILL
          sleep 1
        fi
        echo "$name: stopped (pid $pid)"
        stopped_pids="$stopped_pids $pid"
      else
        echo "$name: pid $pid not alive — no kill needed"
      fi
      rm -f "$pidfile"
    else
      echo "$name: not running (no pid file)"
    fi
  done

  # sweep any leftover listeners on the service ports (backstop for
  # processes that outlived the pid-kill round, e.g. re-exec'd children)
  for ((i = 0; i < NUM_SVCS; i++)); do
    port="${SVC_PORTS[$i]}"
    if port_open "$port"; then
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | while read -r lp; do
        kill -9 "$lp" 2>/dev/null
      done
      sleep 1
    fi
  done

  # final orphan sweep: reap any descendant of a recorded pid that survived
  for pid in $stopped_pids; do
    if pid_alive "$pid"; then
      for n in $(descendants_of "$pid"); do
        kill -9 "$n" 2>/dev/null
      done
      kill -9 "$pid" 2>/dev/null
    fi
  done
  sleep 1

  # verify everything is down
  echo
  printf '%-8s  %-10s  %s\n' "service" "port" "state"
  for ((i = 0; i < NUM_SVCS; i++)); do
    port="${SVC_PORTS[$i]}"
    if port_open "$port"; then
      printf '%-8s  %-10s  %s\n' "${SVC_NAMES[$i]}" "$port" "STILL UP"
      still=1
    else
      printf '%-8s  %-10s  %s\n' "${SVC_NAMES[$i]}" "$port" "down"
    fi
  done
  if [ "$still" = 1 ]; then
    warn "one or more ports are still listening after stop"
    return 1
  fi
  echo "all ports (8323 8320 8321 8322) are free"
  return 0
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
cmd_status() {
  local i name pidfile pid pidstr port path code open pidok portstr state
  printf '%-8s  %-18s  %-10s  %-10s  %s\n' "service" "pid" "port" "health" "state"
  printf '%-8s  %-18s  %-10s  %-10s  %s\n' "-------" "------------------" "----------" "----------" "-----"
  for ((i = 0; i < NUM_SVCS; i++)); do
    name="${SVC_NAMES[$i]}"
    port="${SVC_PORTS[$i]}"
    path="${SVC_HEALTH[$i]}"
    pidfile="$(pidfile_of "$name")"

    pid=""
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile" 2>/dev/null || true)"
    fi
    pidok=0
    if [ -n "$pid" ] && pid_alive "$pid"; then
      pidok=1
      pidstr="$pid (alive)"
    elif [ -n "$pid" ]; then
      pidstr="$pid (dead)"
    else
      pidstr="-"
    fi

    open=0
    if port_open "$port"; then open=1; fi

    if [ "$open" = 1 ]; then
      portstr="listening"
      code="$(curl -s -o /dev/null --max-time 3 -w '%{http_code}' "http://localhost:$port$path" 2>/dev/null)" || code="000"
    else
      portstr="closed"
      code="-"
    fi

    if [ "$open" = 1 ] && { [ "$pidok" = 1 ] || [ -z "$pid" ]; }; then
      state="UP"
    else
      state="DOWN"
    fi

    printf '%-8s  %-18s  %-10s  %-10s  %s\n' "$name" "$pidstr" "$portstr" "$code" "$state"
  done
}

# ---------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------
cmd_logs() {
  local svc="${1:-}" i f
  if [ -z "$svc" ] || [ "$svc" = "all" ]; then
    if ls "$LOGS"/*.log >/dev/null 2>&1; then
      tail -n 30 "$LOGS"/*.log
    else
      echo "no log files yet in $LOGS (run ./run.sh start first)"
    fi
    return 0
  fi
  if ! i="$(svc_idx "$svc")"; then
    echo "error: unknown service '$svc' (expected: worker | backend | api | web | all)" >&2
    return 2
  fi
  f="$LOGS/${SVC_NAMES[$i]}.log"
  if [ ! -f "$f" ]; then
    echo "no log file for $svc yet: $f"
    return 1
  fi
  tail -n 200 -f "$f"
}

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
deep-reach service orchestrator

Usage: ./run.sh <command>

Commands:
  start               Start all 4 services in dependency order (worker, backend, api, web).
                      Skips services that are already running; warns and skips when a
                      runtime is missing (never crashes the run). Waits up to ~90s for
                      the launched ports, then prints a summary table.
  stop                Stop all 4 services in reverse order (web, api, backend, worker):
                      SIGTERM, wait up to ~10s, SIGKILL if needed; then verifies all
                      ports are free.
  restart             stop, then start
  status              Per-service table: pid, port, health, state (UP/DOWN)
  logs [service|all]  Tail logs/<service>.log (last 200 lines, follow).
                      No arg or 'all': 30-line snapshot of every log file.
  help                This text

Services (dependency order worker -> backend -> api -> web):
  service   runtime   command                      port    health
  worker    python    venv/bin/python api_server.py  8321  /health
  backend   node      npm run serve                8322  TCP only (optionally /openapi.json)
  api       bun       bun run src/index.ts         8320  /health
  web       node      npm run dev                  8323  /

Dependency wiring: web -> api -> { worker, backend }. The Next.js web app rewrites
/api/* to the glue api service, which proxies to worker and backend.

Notes:
  - PIDs live in logs/<service>.pid; output in logs/<service>.log.
  - The worker needs an external LLM endpoint: LLM_ENDPOINT in
    deep-reach-worker/utils/var.env (default http://localhost:8080). Run that
    LLM server separately — start warns (non-fatally) if it is unreachable.
EOF
}

# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-}"
  case "$cmd" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status) cmd_status ;;
    logs) shift; cmd_logs "${1:-}" ;;
    help|-h|--help|"") usage ;;
    *)
      echo "error: unknown command '$cmd'" >&2
      usage
      return 2
      ;;
  esac
}

main "$@"
