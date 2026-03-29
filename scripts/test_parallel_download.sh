#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${TMPDIR:-/tmp}/haskell_capstone_parallel_test"
DHT_LOG="$RUNTIME_DIR/dht.log"
PEER_A_LOG="$RUNTIME_DIR/peerA.log"
PEER_B_LOG="$RUNTIME_DIR/peerB.log"
PEER_A_DIR="$RUNTIME_DIR/peerA"
PEER_B_DIR="$RUNTIME_DIR/peerB"
SOURCE_FILE="$RUNTIME_DIR/source_${TEST_HASH:-test_parallel}"
PID_DIR="$RUNTIME_DIR/pids"
DHT_PID_FILE="$PID_DIR/dht.pid"
PEER_A_PID_FILE="$PID_DIR/peerA.pid"
PEER_B_PID_FILE="$PID_DIR/peerB.pid"
TEST_HASH="test_parallel"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/test_parallel_download.sh run
  ./scripts/test_parallel_download.sh run-reset
  ./scripts/test_parallel_download.sh reset

Modes:
  run        Build, launch DHT/peers, register peers, download, and verify.
  run-reset  Same as run, then stop services and clean runtime artifacts.
  reset      Stop services and clean runtime artifacts only.
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

check_prereqs() {
  require_cmd ghc
  require_cmd runghc
  require_cmd python3
  require_cmd curl
  require_cmd cmp
  require_cmd pkill
  require_cmd nohup
}

ensure_pid_dir() {
  mkdir -p "$RUNTIME_DIR"
  mkdir -p "$PID_DIR"
}

wait_http_ok() {
  local url="$1"
  local max_attempts=20
  local attempt=1
  until curl -s "$url" >/dev/null 2>&1; do
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      echo "Timed out waiting for $url" >&2
      return 1
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
}

build_binaries() {
  echo "Building binaries..."
  (
    cd "$ROOT_DIR"
    ghc -package process Peer.hs -o peer_cli
    ghc -package process TorrentClient.hs -o torrent_cli
  )
}

prepare_test_data() {
  echo "Preparing test data..."
  mkdir -p "$PEER_A_DIR" "$PEER_B_DIR"

  if [[ -f "$ROOT_DIR/file123" ]]; then
    cp "$ROOT_DIR/file123" "$SOURCE_FILE"
  else
    head -c 900000 /dev/urandom > "$SOURCE_FILE"
  fi

  cp "$SOURCE_FILE" "$PEER_A_DIR/$TEST_HASH"
  cp "$SOURCE_FILE" "$PEER_B_DIR/$TEST_HASH"
}

stop_services() {
  # First try PID files from this script.
  for pid_file in "$DHT_PID_FILE" "$PEER_A_PID_FILE" "$PEER_B_PID_FILE"; do
    if [[ -f "$pid_file" ]]; then
      pid="$(cat "$pid_file")"
      if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
      rm -f "$pid_file"
    fi
  done

  # Fallback kill for stale processes from manual runs.
  pkill -f "runghc DHTServer.hs" >/dev/null 2>&1 || true
  pkill -f "python3 -m http.server 9001" >/dev/null 2>&1 || true
  pkill -f "python3 -m http.server 9002" >/dev/null 2>&1 || true
}

start_services() {
  echo "Starting DHT and peer servers..."
  ensure_pid_dir
  stop_services

  (
    cd "$ROOT_DIR"
    nohup runghc DHTServer.hs >| "$DHT_LOG" 2>&1 &
    echo $! > "$DHT_PID_FILE"

    nohup python3 -m http.server 9001 --directory "$PEER_A_DIR" >| "$PEER_A_LOG" 2>&1 &
    echo $! > "$PEER_A_PID_FILE"

    nohup python3 -m http.server 9002 --directory "$PEER_B_DIR" >| "$PEER_B_LOG" 2>&1 &
    echo $! > "$PEER_B_PID_FILE"
  )

  wait_http_ok "http://127.0.0.1:8080/get/$TEST_HASH" || true
  wait_http_ok "http://127.0.0.1:9001/$TEST_HASH"
  wait_http_ok "http://127.0.0.1:9002/$TEST_HASH"
}

register_peers() {
  echo "Registering peers in DHT..."
  (
    cd "$ROOT_DIR"
    ./peer_cli register "$TEST_HASH" "127.0.0.1:9001"
    ./peer_cli register "$TEST_HASH" "127.0.0.1:9002"
    ./peer_cli findall "$TEST_HASH"
  )
}

run_download_and_verify() {
  echo "Running parallel download..."
  (
    mkdir -p "$ROOT_DIR/dltest"
    cd "$ROOT_DIR/dltest"
    rm -f "$TEST_HASH" "$TEST_HASH".part*
    echo "$TEST_HASH" | ../torrent_cli

    echo "Verifying content..."
    cmp -s "$TEST_HASH" "$SOURCE_FILE"

    if ls "$TEST_HASH".part* >/dev/null 2>&1; then
      echo "Chunk cleanup failed: leftover part files found" >&2
      exit 1
    fi
  )

  echo "Request counts:"
  echo "  peerA: $(grep -c 'GET /test_parallel' "$PEER_A_LOG" 2>/dev/null || echo 0)"
  echo "  peerB: $(grep -c 'GET /test_parallel' "$PEER_B_LOG" 2>/dev/null || echo 0)"
  echo "PASS: Parallel download and merge verified."
}

reset_runtime_artifacts() {
  echo "Resetting runtime artifacts..."
  stop_services
  rm -rf "$RUNTIME_DIR"
  rm -f "$ROOT_DIR/dltest/$TEST_HASH" "$ROOT_DIR/dltest/$TEST_HASH".part*
}

main() {
  local mode="${1:-run}"

  case "$mode" in
    run)
      check_prereqs
      build_binaries
      prepare_test_data
      start_services
      register_peers
      run_download_and_verify
      ;;
    run-reset)
      check_prereqs
      build_binaries
      prepare_test_data
      start_services
      register_peers
      run_download_and_verify
      reset_runtime_artifacts
      ;;
    reset)
      reset_runtime_artifacts
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown mode: $mode" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
