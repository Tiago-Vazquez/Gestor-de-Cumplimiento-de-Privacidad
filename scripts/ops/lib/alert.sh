#!/usr/bin/env bash
# M29.2 A2 - Shared alerting seam for the operational scripts.
#
# Sourced, never executed. It exists so the alerting contract has exactly ONE
# definition instead of one copy per script: the JSON payload, the delivery
# error handling and the "an alert never changes the caller's exit code"
# guarantee are defined here once and inherited by every caller.
#
# It is deliberately dependency-free, like scripts/ops/common.sh: these scripts
# run during an incident, against whatever shell the operator has. No external
# tooling is required and no provider is assumed.
#
# ALERT_CMD is a COMMAND that receives the event as JSON on stdin. It is the
# same injection pattern as OFFHOST_S3_CMD in offhost-upload.sh, so the alert
# path is testable offline against a local double with no network, no
# credentials and no vendor CLI. This file names NO provider: not Slack, not
# SMTP, not Discord, not Telegram, not Alertmanager. The destination is
# configured outside the repository, on the host.
#
# CONTRACT
#   stdin  : {"timestamp":"<ISO-8601 UTC>","result":"<name>","exit_code":<int>}
#   return : ALWAYS 0
#
# GUARANTEE
#   emit_alert NEVER changes the exit code of the process that calls it and it
#   never executes `exit`. A delivery failure is logged and swallowed: a correct
#   backup must not be reported as failed because the channel is down, and a
#   failed upload must not be reported as successful because an alert was
#   delivered. Under `set -e` the unconditional `return 0` is what keeps an
#   alert from aborting the run before the caller reaches its own exit code.

# Command used to deliver alerts. Empty (the default) means "no channel
# configured": emit_alert then does nothing at all, silently and successfully.
# Read from the environment at source time, so a caller may export it or set it
# before sourcing.
ALERT_CMD="${ALERT_CMD:-}"

# Prefix used in log lines, so alerts from different scripts stay
# distinguishable in a shared log without parsing.
ALERT_LOG_PREFIX="${ALERT_LOG_PREFIX:-alert}"

# Log sink. Defaults to stderr. A caller with a better sink (a log file, a
# structured logger) redefines alert_log BEFORE sourcing, and the guard below
# keeps its definition. emit_alert passes the already-prefixed message.
if ! declare -F alert_log >/dev/null 2>&1; then
  alert_log() {
    printf '%s\n' "$*" >&2
  }
fi

# emit_alert <result> <exit_code> <timestamp>
#
# Delivers one event to ALERT_CMD. Returns 0 unconditionally, including when
# the channel fails or is unset, so it is safe under `set -e` in every caller.
emit_alert() {
  local result="$1" code="$2" started="$3"

  # No channel configured: silent, successful, caller unaffected.
  [[ -n "$ALERT_CMD" ]] || return 0

  # exit_code uses %d on purpose so it travels as a JSON number and not as a
  # quoted string: a consumer comparing it must not have to strip quotes, and
  # "76" != 76 silently breaks a monitor.
  local payload
  payload="$(printf '{"timestamp":"%s","result":"%s","exit_code":%d}' \
    "$started" "$result" "$code")"

  # The channel is a child process; its status is recorded, never propagated.
  # `|| alert_rc=$?` also neutralises `set -e` around the pipeline itself.
  local alert_rc=0
  printf '%s' "$payload" | bash -c "$ALERT_CMD" >/dev/null 2>&1 || alert_rc=$?

  if [[ "$alert_rc" == "0" ]]; then
    alert_log "$ALERT_LOG_PREFIX: alert sent result=$result exit_code=$code"
  else
    # Recorded and swallowed: the caller's own exit code is authoritative.
    alert_log "$ALERT_LOG_PREFIX: alert delivery FAILED (exit=$alert_rc); original exit_code=$code preserved"
  fi

  return 0
}
