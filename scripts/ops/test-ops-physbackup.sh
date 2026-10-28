#!/usr/bin/env bash
# F-P3.2 -- isolated tests for the physical backup (scripts/ops/postgres-physbackup.sh).
#
# Exercises the REAL script against a local double via PHYS_BASEBACKUP_CMD (the
# same seam as OFFHOST_S3_CMD / WAL_ARCHIVE_TRANSPORT / BACKUP_CMD): the whole
# contract is verified with NO Docker, NO network, NO real PostgreSQL, NO
# credentials and NO services. The gated real pg_basebackup path
# (PHYS_ALLOW_REAL=1) is never reached here.
#
# The double models pg_basebackup -Ft -X stream: it receives the staging dir as
# $1 and writes base.tar (with a valid backup_label), pg_wal.tar and
# backup_manifest. Failure modes are driven by CTL_DIR/mode so every negative
# scenario is deterministic:
#   ok | transport-fail | miss-base | miss-pgwal | miss-manifest
#   empty-member | bad-tar | no-label | bad-label-lsn | bad-label-tl
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PHYS="$ROOT_DIR/scripts/ops/postgres-physbackup.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS + 1)); printf "  ok   %s\n" "$1"; }
no()   { FAIL=$((FAIL + 1)); printf "  FAIL %s\n" "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (esperado '$3', obtenido '$2')"; fi; }

echo "F-P3.2 postgres-physbackup tests"

export CTL_DIR="$WORK/ctl"
export CALLS="$WORK/calls.log"
mkdir -p "$CTL_DIR"
: > "$CALLS"

# --- double: emulates pg_basebackup -Ft -X stream ---------------------------
# Usage: double.sh <staging-dir>. Reads CTL_DIR/mode (default ok).
cat > "$WORK/double.sh" <<'DOUBLE'
#!/usr/bin/env bash
set -uo pipefail
stage="$1"
mode="$(cat "$CTL_DIR/mode" 2>/dev/null || echo ok)"
printf 'transport %s\n' "$mode" >> "$CALLS"
[[ -d "$stage" ]] || { echo "double: staging dir missing: $stage" >&2; exit 3; }

if [[ "$mode" == "transport-fail" ]]; then echo "double: simulated transport failure" >&2; exit 4; fi

make_label() { printf 'START WAL LOCATION: 0/2000028 (file 000000010000000000000002)\nCHECKPOINT LOCATION: 0/2000060\nBACKUP METHOD: streamed\nSTART TIMELINE: 1\n'; }

if [[ "$mode" != "miss-base" ]]; then
  if [[ "$mode" == "bad-tar" ]]; then
    printf 'not a tar archive at all\n' > "$stage/base.tar"
  elif [[ "$mode" == "no-label" ]]; then
    printf 'hello\n' > "$stage/_x"; tar -cf "$stage/base.tar" -C "$stage" _x 2>/dev/null; rm -f "$stage/_x"
  elif [[ "$mode" == "bad-label-lsn" ]]; then
    printf 'START WAL LOCATION: not-an-lsn\nSTART TIMELINE: 1\n' > "$stage/backup_label"
    tar -cf "$stage/base.tar" -C "$stage" backup_label 2>/dev/null; rm -f "$stage/backup_label"
  elif [[ "$mode" == "bad-label-tl" ]]; then
    printf 'START WAL LOCATION: 0/2000028\nSTART TIMELINE: xx\n' > "$stage/backup_label"
    tar -cf "$stage/base.tar" -C "$stage" backup_label 2>/dev/null; rm -f "$stage/backup_label"
  else
    make_label > "$stage/backup_label"
    tar -cf "$stage/base.tar" -C "$stage" backup_label 2>/dev/null; rm -f "$stage/backup_label"
  fi
fi

if [[ "$mode" != "miss-pgwal" ]]; then
  if [[ "$mode" == "empty-member" ]]; then
    : > "$stage/pg_wal.tar"
  else
    printf 'wal-seg\n' > "$stage/seg0001"
    tar -cf "$stage/pg_wal.tar" -C "$stage" seg0001 2>/dev/null; rm -f "$stage/seg0001"
  fi
fi

if [[ "$mode" != "miss-manifest" && "$mode" != "empty-member" ]]; then
  case "$mode" in
    ok)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "0/20000000", "End-LSN": "0/30000000"}]}
MANIFEST
      ;;
    wal-ranges-multi-tl)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "0/20000000", "End-LSN": "0/2FFFFFFF"}, {"Timeline": 2, "Start-LSN": "0/30000000", "End-LSN": "0/3FFFFFFF"}]}
MANIFEST
      ;;
    wal-ranges-dup-tl)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "0/20000000", "End-LSN": "0/2FFFFFFF"}, {"Timeline": 1, "Start-LSN": "0/30000000", "End-LSN": "0/3FFFFFFF"}]}
MANIFEST
      ;;
    wal-ranges-bad-json)
      printf 'this is not valid json {{{' > "$stage/backup_manifest"
      ;;
    wal-ranges-missing-field)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "0/20000000"}]}
MANIFEST
      ;;
    wal-ranges-bad-lsn)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "not-an-lsn", "End-LSN": "0/30000000"}]}
MANIFEST
      ;;
    wal-ranges-inverted)
      cat > "$stage/backup_manifest" <<'MANIFEST'
{"WAL-Ranges": [{"Timeline": 1, "Start-LSN": "0/30000000", "End-LSN": "0/20000000"}]}
MANIFEST
      ;;
    wal-ranges-absent)
      printf '{"other-key": "value"}' > "$stage/backup_manifest"
      ;;
    *)
      printf 'manifest-body\n' > "$stage/backup_manifest"
      ;;
  esac
fi

exit 0
DOUBLE
chmod +x "$WORK/double.sh"

# --- helpers ----------------------------------------------------------------
BK=""
CFG_OK() { printf '%s\n' "$1" > "$CTL_DIR/mode"; }
run() {  # runs the backup in a fresh BACKUP_DIR; sets RC and OUT
  BK="$WORK/bk.$1"; rm -rf "$BK"; mkdir -p "$BK"
  OUT="$WORK/out.$1"; : > "$OUT"; RC=0
  env -u PHYS_ALLOW_REAL \
      BACKUP_DIR="$BK" ALLOW_LOCAL_BACKUP=1 \
      BACKUP_LOCK_DIR="$BK/.m24-backup.lock" \
      PHYS_BASEBACKUP_CMD="$WORK/double.sh" \
      CTL_DIR="$CTL_DIR" CALLS="$CALLS" \
      bash "$PHYS" >>"$OUT" 2>&1 || RC=$?
}
verify() {  # verify <manifest>; sets VRC and VOUT
  VOUT="$WORK/vout"; : > "$VOUT"; VRC=0
  env -u PHYS_ALLOW_REAL BACKUP_DIR="$BK" ALLOW_LOCAL_BACKUP=1 \
      BACKUP_LOCK_DIR="$BK/.m24-backup.lock" \
      bash "$PHYS" --verify "$1" >>"$VOUT" 2>&1 || VRC=$?
}
man_of() { ls "$BK"/*.pmanifest 2>/dev/null | head -n1; }
finals() { ls -1 "$BK" 2>/dev/null | grep -Ev '^\.m24-phys-tmp|^\.m24-backup\.lock$' | wc -l | tr -d ' '; }
stage_leftovers() { ls -1a "$BK" 2>/dev/null | grep -c '^\.m24-phys-tmp' || true; }
lock_leftovers()  { [[ -e "$BK/.m24-backup.lock" ]] && echo yes || echo no; }
mget() { printf '%s' "$2" | awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,"");print;exit}'; }

# Reuse the production SHA-256/strip/format primitives so expected digests are
# computed exactly the way the script computes them.
# shellcheck source=scripts/ops/common.sh
source "$ROOT_DIR/scripts/ops/common.sh"

# Whole-line replace of one manifest key (sed with a '#' delimiter so path
# values containing '/' are safe).
mset() { sed -i "s#^$2=.*#$2=$3#" "$1"; }

# Emit a minimal forged .pmanifest. Used only for the path-injection negatives:
# base_tar_file is attacker-controlled; is_safe_token must reject it before the
# referenced file is ever resolved.
emit_forged() { # <path> <set_id> <base_tar_file> <base_sha256> <base_bytes>
  {
    printf 'format=pg-base-tar-set\n'
    printf 'schema_version=1\n'
    printf 'set_id=%s\n'          "$2"
    printf 'created_at=2026-01-01T00:00:00Z\n'
    printf 'postgres_version=16\n'
    printf 'base_lsn=0/2000028\n'
    printf 'wal_range_count=0\n'
    printf 'base_timeline=1\n'
    printf 'base_tar_file=%s\n'     "$3"
    printf 'base_tar_sha256=%s\n'   "$4"
    printf 'base_tar_bytes=%s\n'    "$5"
    printf 'pgwal_tar_file=%s.pg_wal.tar\n'        "$2"
    printf 'pgwal_tar_sha256=%s\n' "$(printf '%064d' 0)"
    printf 'pgwal_tar_bytes=1\n'
    printf 'manifest_file=%s.backup_manifest\n'    "$2"
    printf 'manifest_sha256=%s\n'  "$(printf '%064d' 0)"
    printf 'manifest_bytes=1\n'
    printf 'status=complete\n'
  } > "$1"
}

# Run the backup into a GIVEN dir without wiping it (coexistence/preserve/lock
# cases). Keeps BK in sync so the shared helpers still work.
run_into() { # <dir> <tag>
  BK="$1"; OUT="$WORK/out.into.$2"; : > "$OUT"; RC=0
  env -u PHYS_ALLOW_REAL \
      BACKUP_DIR="$BK" ALLOW_LOCAL_BACKUP=1 \
      BACKUP_LOCK_DIR="$BK/.m24-backup.lock" \
      PHYS_BASEBACKUP_CMD="$WORK/double.sh" \
      CTL_DIR="$CTL_DIR" CALLS="$CALLS" \
      bash "$PHYS" >>"$OUT" 2>&1 || RC=$?
}

# ===========================================================================
# 1) Valid backup: publishes exactly the 4-member coordinated set.
# ===========================================================================
CFG_OK ok; run v
check "valid backup exits 0"                     "$RC"   "0"
check "valid backup published 4 members"         "$(finals)" "4"
check "valid backup left no staging"             "$(stage_leftovers)" "0"
check "valid backup released the lock"           "$(lock_leftovers)"  "no"
man="$(man_of)"
[[ -n "$man" ]] && ok "a .pmanifest was published" || no "no .pmanifest published"
check "manifest status is complete"              "$(mget status "$(cat "$man")")" "complete"
sid="$(mget set_id "$(cat "$man")")"
check "base_tar_file is derived from set_id"     "$(mget base_tar_file "$(cat "$man")")" "${sid}.base.tar"

# 2) The published set verifies (regression guard for the --verify hardening).
verify "$man"
check "verify of a valid set exits 0"            "$VRC" "0"

# ===========================================================================
# 3) Transport failure: nothing published, staging cleaned, lock released.
# ===========================================================================
CFG_OK transport-fail; run tf
check "transport failure exits 1"                "$RC" "1"
check "transport failure published nothing"      "$(finals)" "0"
check "transport failure left no staging"        "$(stage_leftovers)" "0"
check "transport failure released the lock"      "$(lock_leftovers)" "no"

# ===========================================================================
# 4) Each required member missing on its own.
# ===========================================================================
for m in miss-base miss-pgwal miss-manifest; do
  CFG_OK "$m"; run "$m"
  check "$m exits 1"                             "$RC" "1"
  check "$m published nothing"                   "$(finals)" "0"
done

# ===========================================================================
# 5) Empty member artifact.
# ===========================================================================
CFG_OK empty-member; run em
check "empty-member exits 1"                     "$RC" "1"
check "empty-member published nothing"           "$(finals)" "0"

# ===========================================================================
# 6) Invalid tar archive.
# ===========================================================================
CFG_OK bad-tar; run bt
check "bad-tar exits 1"                          "$RC" "1"
check "bad-tar published nothing"                "$(finals)" "0"


# ===========================================================================
# 7) backup_label absent.
# ===========================================================================
CFG_OK no-label; run nl
check "no-label exits 1"                         "$RC" "1"
check "no-label published nothing"               "$(finals)" "0"

# ===========================================================================
# 8) backup_label with an invalid LSN.
# ===========================================================================
CFG_OK bad-label-lsn; run bl
check "bad-label-lsn exits 1"                    "$RC" "1"
check "bad-label-lsn published nothing"          "$(finals)" "0"

# ===========================================================================
# 9) backup_label with an invalid timeline.
# ===========================================================================
CFG_OK bad-label-tl; run btl
check "bad-label-tl exits 1"                     "$RC" "1"
check "bad-label-tl published nothing"           "$(finals)" "0"

# ===========================================================================
# 10) Manifest absent / status not complete / referenced member missing.
# ===========================================================================
CFG_OK ok; run mv1; man="$(man_of)"
verify "$BK/does-not-exist.pmanifest"
check "verify of a missing manifest exits 1"     "$VRC" "1"

CFG_OK ok; run mv2; man="$(man_of)"
mset "$man" status incomplete
verify "$man"
check "verify of a non-complete status exits 1"  "$VRC" "1"

CFG_OK ok; run mv3; man="$(man_of)"
rm -f "$BK/$(mget base_tar_file "$(cat "$man")")"
verify "$man"
check "verify with a missing member exits 1"     "$VRC" "1"

# ===========================================================================
# 11) Recorded size altered (file untouched) -> size mismatch.
# ===========================================================================
CFG_OK ok; run sz; man="$(man_of)"
mset "$man" base_tar_bytes "$(( $(mget base_tar_bytes "$(cat "$man")") + 100 ))"
verify "$man"
check "verify with an altered size exits 1"      "$VRC" "1"
grep -q "size mismatch" "$VOUT" && ok "altered size reported as size mismatch" || no "size mismatch not reported"

# ===========================================================================
# 12) Recorded SHA-256 altered, and real member content corrupted.
# ===========================================================================
CFG_OK ok; run sha; man="$(man_of)"
mset "$man" base_tar_sha256 "$(printf '%064d' 7)"
verify "$man"
check "verify with an altered sha256 exits 1"    "$VRC" "1"
grep -q "SHA-256 mismatch" "$VOUT" && ok "altered sha256 reported as SHA-256 mismatch" || no "SHA-256 mismatch not reported"

CFG_OK ok; run cc; man="$(man_of)"
printf 'x' >> "$BK/$(mget base_tar_file "$(cat "$man")")"
verify "$man"
check "verify with a corrupted member exits 1"   "$VRC" "1"

# ===========================================================================
# 12b) schema_version fail-closed: ausente o desconocida rechaza el set.
# ===========================================================================
CFG_OK ok; run sv1; man="$(man_of)"
mset "$man" schema_version ""
verify "$man"
check "verify missing schema_version exits 1"   "$VRC" "1"

CFG_OK ok; run sv2; man="$(man_of)"
mset "$man" schema_version "2"
verify "$man"
check "verify unknown schema_version exits 1"   "$VRC" "1"

# ===========================================================================
# 12c) WAL-Ranges de backup_manifest se publican en el .pmanifest.
# ===========================================================================
CFG_OK ok; run wr; man="$(man_of)"
check "pmanifest wal_range_count=1"   "$(mget wal_range_count    "$(cat "$man")")" "1"
check "pmanifest wal_range_1_timeline" "$(mget wal_range_1_timeline "$(cat "$man")")" "1"
check "pmanifest wal_range_1_start_lsn" "$(mget wal_range_1_start_lsn "$(cat "$man")")" "0/20000000"
check "pmanifest wal_range_1_end_lsn"   "$(mget wal_range_1_end_lsn   "$(cat "$man")")"   "0/30000000"

# ===========================================================================
# 12d) WAL-Ranges: varios rangos en timelines distintas (positivo).
# ===========================================================================
CFG_OK wal-ranges-multi-tl; run wmt; man="$(man_of)"
verify "$man"
check "multi-tl backup exits 0"           "$RC"   "0"
check "multi-tl wal_range_count=2"        "$(mget wal_range_count    "$(cat "$man")")" "2"
check "multi-tl wal_range_1_timeline=1"   "$(mget wal_range_1_timeline "$(cat "$man")")" "1"
check "multi-tl wal_range_2_timeline=2"   "$(mget wal_range_2_timeline "$(cat "$man")")" "2"

# ===========================================================================
# 12e) WAL-Ranges: timeline duplicada en dos rangos (negativo, fail-closed).
# ===========================================================================
CFG_OK wal-ranges-dup-tl; run wdt; man="$(man_of)"
verify "$man"
check "dup-tl verify exits 1"             "$VRC" "1"

# ===========================================================================
# 12f) WAL-Ranges: JSON invalido en backup_manifest (negativo).
# ===========================================================================
CFG_OK wal-ranges-bad-json; run wbj; man="$(man_of)"
verify "$man"
check "bad-json verify exits 1"           "$VRC" "1"

# ===========================================================================
# 12g) WAL-Ranges: campo obligatorio ausente (End-LSN) (negativo).
# ===========================================================================
CFG_OK wal-ranges-missing-field; run wmf; man="$(man_of)"
verify "$man"
check "missing-field verify exits 1"      "$VRC" "1"

# ===========================================================================
# 12h) WAL-Ranges: LSN mal formado (Start-LSN) (negativo).
# ===========================================================================
CFG_OK wal-ranges-bad-lsn; run wbl; man="$(man_of)"
verify "$man"
check "bad-lsn verify exits 1"            "$VRC" "1"

# ===========================================================================
# 12i) WAL-Ranges: rango invertido (Start > End) (negativo).
# ===========================================================================
CFG_OK wal-ranges-inverted; run win; man="$(man_of)"
verify "$man"
check "inverted verify exits 1"           "$VRC" "1"

# ===========================================================================
# 12j) WAL-Ranges ausente: count=0 sin fallo en publicacion (documentado).
# ===========================================================================
CFG_OK wal-ranges-absent; run wra; man="$(man_of)"
check "absent backup exits 0"             "$RC"   "0"
check "absent wal_range_count=0"          "$(mget wal_range_count "$(cat "$man")")" "0"
verify "$man"
check "absent verify exits 0"             "$VRC" "0"

# ===========================================================================
# 12k) schema_version ausente en .pmanifest: verify falla (fail-closed).
# ===========================================================================
CFG_OK ok; run sv3; man="$(man_of)"
mset "$man" schema_version ""
verify "$man"
check "verify missing schema_version exits 1"   "$VRC" "1"



# ===========================================================================
# 13) Path-injection negatives: a manifest must NEVER resolve a member outside
#     the set directory -- even when the external file exists with content and
#     hash that would match. Build ONE real external file and reuse its true
#     digest/size in every forged manifest, so the ONLY thing that can reject
#     the reference is the path guard (not a coincidental hash/size mismatch).
# ===========================================================================
INJ="$WORK/inj"; rm -rf "$INJ"; mkdir -p "$INJ/set"
EXT="$WORK/outside.base.tar"; printf 'external-payload\n' > "$EXT"
ESHA="$(sha256_of "$EXT")"; EBYTES="$(wc -c < "$EXT" | tr -d ' \r\n')"
inject() { # <desc> <base_tar_file-value>
  emit_forged "$INJ/set/s.pmanifest" s "$2" "$ESHA" "$EBYTES"
  verify "$INJ/set/s.pmanifest"
  if [[ "$VRC" != 0 ]]; then ok "verify rejects $1"; else no "verify ACCEPTED $1"; fi
}
inject "relative traversal ../../outside.base.tar" "../../outside.base.tar"
inject "absolute path reference"                    "$EXT"
inject "backslash separator"                        '..\outside.base.tar'
inject "nested dot traversal"                       "./x/../../outside.base.tar"
grep -q "not a valid filename" "$VOUT" && ok "traversal rejected as an invalid filename" || no "invalid-filename reason not reported"

# 13b) symlinked member cannot escape the directory (sha/size match the target,
#      so ONLY the symlink guard can reject it).
CFG_OK ok; run sym; man="$(man_of)"
sid="$(mget set_id "$(cat "$man")")"
printf 'symlink-target\n' > "$WORK/ext-sym.tar"
mset "$man" base_tar_sha256 "$(sha256_of "$WORK/ext-sym.tar")"
mset "$man" base_tar_bytes  "$(wc -c < "$WORK/ext-sym.tar" | tr -d ' \r\n')"
rm -f "$BK/${sid}.base.tar"; ln -s "$WORK/ext-sym.tar" "$BK/${sid}.base.tar"
verify "$man"
check "verify rejects a symlinked member"           "$VRC" "1"
grep -q "symlink" "$VOUT" && ok "symlink member reported as symlink" || no "symlink not reported"

# 13c) safe-but-wrong member name is rejected by the set_id contract (content
#      and hash match, so ONLY the expected-name check can reject it).
CFG_OK ok; run wrongname; man="$(man_of)"
sid="$(mget set_id "$(cat "$man")")"
cp "$BK/${sid}.base.tar" "$BK/decoy.tar"
mset "$man" base_tar_file     "decoy.tar"
mset "$man" base_tar_sha256   "$(sha256_of "$BK/decoy.tar")"
mset "$man" base_tar_bytes    "$(wc -c < "$BK/decoy.tar" | tr -d ' \r\n')"
verify "$man"
check "verify rejects a safe-but-wrong member name" "$VRC" "1"
grep -q "not the expected set member" "$VOUT" && ok "wrong member name reported" || no "expected-member reason not reported"


# ===========================================================================
# 14/16) Pre-existing finals, a stray final and a fresh orphan temp dir must all
#        survive a new backup. Cleanup is scoped to THIS run's own staging; the
#        reaper only removes .m24-phys-tmp.* older than 24h, so a fresh orphan
#        is preserved. Proves a new set never overwrites or clobbers neighbours.
# ===========================================================================
PRE="$WORK/pre"; rm -rf "$PRE"; mkdir -p "$PRE"
for suf in base.tar pg_wal.tar backup_manifest pmanifest; do
  printf 'old-%s\n' "$suf" > "$PRE/m24-physbase-OLD-000001.$suf"
done
printf 'stray\n' > "$PRE/stray-final.txt"
mkdir -p "$PRE/.m24-phys-tmp.PREEXIST"; printf 'x\n' > "$PRE/.m24-phys-tmp.PREEXIST/junk"
run_into "$PRE" pre
check "backup alongside a pre-existing set exits 0" "$RC" "0"
for suf in base.tar pg_wal.tar backup_manifest pmanifest; do
  [[ -f "$PRE/m24-physbase-OLD-000001.$suf" ]] && ok "pre-existing .$suf preserved" || no "pre-existing .$suf was clobbered"
done
[[ -f "$PRE/stray-final.txt" ]] && ok "unrelated stray final preserved" || no "stray final was removed"
[[ -d "$PRE/.m24-phys-tmp.PREEXIST" ]] && ok "fresh orphan temp preserved (reaper is 24h-scoped)" || no "fresh orphan temp was wrongly reclaimed"
check "new set added alongside the old (9 finals)" "$(finals)" "9"

# ===========================================================================
# 15) A successful run leaves NO staging of its own behind.
# ===========================================================================
CFG_OK ok; run cl
check "successful run leaves no staging"          "$(stage_leftovers)" "0"

# ===========================================================================
# 17) Concurrency: a LIVE lock holder blocks with EXIT_LOCKED (75); a STALE
#     (dead-holder) lock is reclaimed so the backup proceeds.
# ===========================================================================
sleep 300 & LIVEPID=$!
LK="$WORK/live-lock"; rm -rf "$LK"; mkdir -p "$LK/.m24-backup.lock"
printf '%s\n' "$LIVEPID" > "$LK/.m24-backup.lock/pid"
run_into "$LK" live
check "live lock holder blocks with exit 75"      "$RC" "75"
check "blocked run published nothing"             "$(finals)" "0"
[[ -d "$LK/.m24-backup.lock" ]] && ok "blocked run left the foreign lock intact" || no "blocked run removed the foreign lock"
kill "$LIVEPID" 2>/dev/null; wait "$LIVEPID" 2>/dev/null || true

true & DEADPID=$!; wait "$DEADPID" 2>/dev/null || true
SL="$WORK/stale-lock"; rm -rf "$SL"; mkdir -p "$SL/.m24-backup.lock"
printf '%s\n' "$DEADPID" > "$SL/.m24-backup.lock/pid"
run_into "$SL" stale
check "stale dead-holder lock is reclaimed (exit 0)" "$RC" "0"
check "reclaimed run published the set"           "$(finals)" "4"

# ===========================================================================
# 18) No real connection / no Docker / no credentials: with neithe
#     PHYS_BASEBACKUP_CMD nor PHYS_ALLOW_REAL the script fails fast and neve
#     reaches the gated real path. The double (not a server) drove every test.
# ===========================================================================
NC="$WORK/noconn"; rm -rf "$NC"; mkdir -p "$NC"
OUT="$WORK/out.noconn"; : > "$OUT"; RC=0
env -u PHYS_ALLOW_REAL -u PHYS_BASEBACKUP_CMD \
    BACKUP_DIR="$NC" ALLOW_LOCAL_BACKUP=1 \
    BACKUP_LOCK_DIR="$NC/.m24-backup.lock" \
    CTL_DIR="$CTL_DIR" CALLS="$CALLS" \
    bash "$PHYS" >>"$OUT" 2>&1 || RC=$?
check "no transport configured exits 1"          "$RC" "1"
grep -q "no transport configured" "$OUT" && ok "fails fast without Docker/credentials" || no "did not report a missing transport"
grep -q "REAL pg_basebackup" "$OUT" && no "reached the gated real path" || ok "gated real path never reached"

# The seam (not a server) produced the earlier good set.
CFG_OK ok; run seam
grep -q "transport ok" "$CALLS" && ok "the injected transport seam drove the backup" || no "transport seam was not used"

# ---------------------------------------------------------------------------
# Summary + exit gate: any failed assertion makes the suite exit non-zero.
# ---------------------------------------------------------------------------
echo "----"
printf '  %d ok, %d fail\n' "$PASS" "$FAIL"
if [[ "$FAIL" != 0 ]]; then
  echo "test-ops-physbackup: FAILED" >&2
  exit 1
fi
echo "test-ops-physbackup: all assertions passed"
exit 0

