#!/usr/bin/env bash
# F-P4 -- offline tests for the PITR branch in postgres-restore.sh.
# NO Docker, NO network, NO PostgreSQL, NO credentials, NO services.
# Run: bash scripts/ops/test-ops-pitr-branch.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESTORE="$ROOT_DIR/scripts/ops/postgres-restore.sh"
PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (wanted $3 got $2)"; fi; }
hits() { grep -c -- "$2" "$1" 2>/dev/null || true; }
echo "F-P4 postgres-restore PITR branch tests"
SEGSZ=16777216
UNTIL="2026-01-02T03:04:05Z"
make_set() {
  local dir="$1" sid="$2" lsn="$3" tl="$4" wal_start="${5:-$lsn}" wal_end="${6:-$lsn}" stage
  local sb sw sm bb bw bm
  stage="$WORK/stage.$sid"; rm -rf "$stage"; mkdir -p "$stage"
  printf 'START WAL LOCATION: %s\nSTART TIMELINE: %s\n' "$lsn" "$tl" > "$stage/backup_label"
  tar -cf "$stage/base.tar" -C "$stage" backup_label 2>/dev/null; rm -f "$stage/backup_label"
  printf 'w\n' > "$stage/_w"; tar -cf "$stage/pg_wal.tar" -C "$stage" _w 2>/dev/null; rm -f "$stage/_w"
  printf 'm\n' > "$stage/backup_manifest"
  sb="$(sha256sum < "$stage/base.tar" | awk '{print $1}')"
  sw="$(sha256sum < "$stage/pg_wal.tar" | awk '{print $1}')"
  sm="$(sha256sum < "$stage/backup_manifest" | awk '{print $1}')"
  bb="$(wc -c < "$stage/base.tar" | tr -d ' ')"
  bw="$(wc -c < "$stage/pg_wal.tar" | tr -d ' ')"
  bm="$(wc -c < "$stage/backup_manifest" | tr -d ' ')"
  printf 'format=pg-base-tar-set\nset_id=%s\ncreated_at=2026-01-01T00:00:00Z\npostgres_version=16\nbase_lsn=%s\nbase_timeline=%s\nbase_tar_file=%s.base.tar\nbase_tar_sha256=%s\nbase_tar_bytes=%s\npgwal_tar_file=%s.pg_wal.tar\npgwal_tar_sha256=%s\npgwal_tar_bytes=%s\nmanifest_file=%s.backup_manifest\nmanifest_sha256=%s\nmanifest_bytes=%s\nstatus=complete\n' "$sid" "$lsn" "$tl" "$sid" "$sb" "$bb" "$sid" "$sw" "$bw" "$sid" "$sm" "$bm" > "$stage/${sid}.pmanifest"
  printf 'schema_version=1\n' >> "$stage/${sid}.pmanifest"
  printf 'wal_range_count=1\nwal_range_1_timeline=%s\nwal_range_1_start_lsn=%s\nwal_range_1_end_lsn=%s\n' "$tl" "$wal_start" "$wal_end" >> "$stage/${sid}.pmanifest"
  mkdir -p "$dir"
  mv "$stage/${sid}.pmanifest" "$dir/${sid}.pmanifest"
  mv "$stage/base.tar" "$dir/${sid}.base.tar"
  mv "$stage/pg_wal.tar" "$dir/${sid}.pg_wal.tar"
  mv "$stage/backup_manifest" "$dir/${sid}.backup_manifest"
  rm -rf "$stage"
  printf '%s' "$dir/${sid}.pmanifest"
}
make_wal() {
  local dir="$1" first="$2" count="$3" i name
  mkdir -p "$dir"
  for (( i = 0; i < count; i++ )); do
    name="$(printf '0000000100000000%08X' "$(( first + i ))")"
    truncate -s "$SEGSZ" "$dir/$name"
  done
}
run_pitr() {
  local tag="$1" base="$2" waldir="$3" ulsn="$4" out="$5"; shift 5
  OUT="$WORK/out.$tag"; : > "$OUT"; RC=0
  bash "$RESTORE" --pitr --base "$base" --wal-dir "$waldir" --until "$UNTIL" --until-lsn "$ulsn" --out "$out" "$@" >>"$OUT" 2>&1 || RC=$?
}
SET1="$WORK/set1"; MAN1="$(make_set "$SET1" s1 0/2000000 1 0/2000000 0/3000000)"
WAL1="$WORK/wal1"; make_wal "$WAL1" 2 2
OUT1="$WORK/pitr-out1"
run_pitr happy "$MAN1" "$WAL1" 0/3000000 "$OUT1"
check "1 happy exits 0" "$RC" "0"
check "1 happy prints pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "1"
check "1 emits postgresql.pitr.conf" "$([ -f "$OUT1/postgresql.pitr.conf" ] && echo yes || echo no)" "yes"
check "1 emits recovery.signal" "$([ -f "$OUT1/recovery.signal" ] && echo yes || echo no)" "yes"
check "1 segment-list has 2 lines" "$(wc -l < "$OUT1/segment-list.txt" | tr -d ' ')" "2"
SET2="$WORK/set2"; MAN2="$(make_set "$SET2" s2 0/FFFFFF0 1 0/FFFFFF0 0/1FFFFFF0)"
WAL2="$WORK/wal2"; make_wal "$WAL2" 15 17
OUT2="$WORK/pitr-out2"
run_pitr carry "$MAN2" "$WAL2" 0/1FFFFFF0 "$OUT2"
check "2 carry exits 0" "$RC" "0"
check "2 carry prints 17 segments" "$(grep -c '^pitr=ok base=s2 segments=17 ' "$OUT" || true)" "1"
SET3="$WORK/set3"; MAN3="$(make_set "$SET3" s3 0/4000000 1 0/4000000 0/5FFFFFF)"
WAL3="$WORK/wal3"; mkdir -p "$WAL3"; truncate -s 33554432 "$WAL3/000000010000000000000002"
OUT3="$WORK/pitr-out3"
run_pitr segsize "$MAN3" "$WAL3" 0/5FFFFFF "$OUT3" --wal-segsize 33554432
check "3 segsize exits 0" "$RC" "0"
check "3 segsize prints 1 segment" "$(grep -c '^pitr=ok base=s3 segments=1 ' "$OUT" || true)" "1"
OUT3B="$WORK/pitr-out3b"
run_pitr segsize-wrong "$MAN3" "$WAL3" 0/5FFFFFF "$OUT3B"
check "3 wrong-S refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "3 wrong-S no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
OUT4="$WORK/pitr-out4"
run_pitr badlsn "$MAN1" "$WAL1" "not-an-lsn" "$OUT4"
check "4 bad LSN refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "4 bad LSN names problem" "$(grep -c 'invalid LSN' "$OUT" || true)" "1"
check "4 bad LSN no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
WAL5="$WORK/wal5"; make_wal "$WAL5" 2 2
cp "$WAL5/000000010000000000000002" "$WAL5/000000010000000000000002.partial"
OUT5="$WORK/pitr-out5"
run_pitr partial "$MAN1" "$WAL5" 0/3000000 "$OUT5"
check "5 partial refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "5 partial no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
WAL6="$WORK/wal6"; make_wal "$WAL6" 2 1
OUT6="$WORK/pitr-out6"
run_pitr gap "$MAN1" "$WAL6" 0/3000000 "$OUT6"
check "6 gap refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "6 gap names segment 3" "$(grep -c 'missing required WAL segment: 000000010000000000000003' "$OUT" || true)" "1"
check "6 gap no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
rm -f "$SET1/s1.base.tar"
OUT7="$WORK/pitr-out7"
run_pitr tampered "$MAN1" "$WAL1" 0/3000000 "$OUT7"
check "7 tampered set refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "7 tampered no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
MAN1="$(make_set "$SET1" s1 0/2000000 1 0/2000000 0/3000000)"
SET8="$WORK/set8"; MAN8="$(make_set "$SET8" s8 0/2000000 1 0/2000000 0/3000000)"
sed -i 's#^base_lsn=.*#base_lsn=0/9999999#' "$SET8/s8.pmanifest"
WAL8="$WORK/wal8"; make_wal "$WAL8" 2 2
OUT8="$WORK/pitr-out8"
run_pitr label "$MAN8" "$WAL8" 0/3000000 "$OUT8"
check "8 label mismatch refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "8 mismatch names WAL LOCATION" "$(grep -c 'START WAL LOCATION' "$OUT" || true)" "1"
check "8 label no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"
WAL9="$WORK/wal9"; make_wal "$WAL9" 2 2
truncate -s "$SEGSZ" "$WAL9/000000020000000000000099"
truncate -s "$SEGSZ" "$WAL9/000000010000000000000099.history"
OUT9="$WORK/pitr-out9"
run_pitr scope "$MAN1" "$WAL9" 0/3000000 "$OUT9"
check "9 out-of-window tolerated" "$RC" "0"
check "9 history ignored" "$(grep -c 'history file ignored' "$OUT" || true)" "1"
check "9 stray listed" "$(grep -c 'listed, not consumed' "$OUT" || true)" "1"
WAL9B="$WORK/wal9b"; make_wal "$WAL9B" 2 2
truncate -s "$SEGSZ" "$WAL9B/000000020000000000000002"
OUT9B="$WORK/pitr-out9b"
run_pitr scope-in "$MAN1" "$WAL9B" 0/3000000 "$OUT9B"
check "9 in-window foreign fails" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "9 ambiguity named" "$(grep -c 'ambiguous replay source' "$OUT" || true)" "1"
OUT10="$WORK/out.mix10"; : > "$OUT10"; RC10=0
bash "$RESTORE" --pitr --backup "$WORK/x.dump" --base "$MAN1" --wal-dir "$WAL1" --until "$UNTIL" --until-lsn 0/3000000 --out "$WORK/pitr-out10" >>"$OUT10" 2>&1 || RC10=$?
check "10 mixed modes refuse" "$([ "$RC10" != "0" ] && echo nonzero || echo zero)" "nonzero"
OUT10B="$WORK/pitr-out10b"
OUT="$WORK/out.until10"; : > "$OUT"; RC=0
bash "$RESTORE" --pitr --base "$MAN1" --wal-dir "$WAL1" --until "not-a-time" --until-lsn 0/3000000 --out "$OUT10B" >>"$OUT" 2>&1 || RC=$?
check "10 bad until refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "10 one target" "$(grep -cE '^recovery_target_(time|lsn|xid|name) =' "$OUT1/postgresql.pitr.conf")" "1"
check "10 inclusive on" "$(grep -c '^recovery_target_inclusive = on' "$OUT1/postgresql.pitr.conf")" "1"
check "10 action promote" "$(grep -c '^recovery_target_action = promote' "$OUT1/postgresql.pitr.conf")" "1"
check "10 timeline current" "$(grep -c "timeline = 'current'" "$OUT1/postgresql.pitr.conf")" "1"
check "10 no lsn target" "$(grep -cE '^recovery_target_lsn =' "$OUT1/postgresql.pitr.conf" || true)" "0"
PITR_SPAN="$WORK/pitr-span.sh"
awk '/^# F-P4 -- offline PITR branch/,/^##F-P4-REST##/' "$RESTORE" > "$PITR_SPAN"
check "11 span non-empty" "$([ -s "$PITR_SPAN" ] && echo yes || echo no)" "yes"
check "11 span no docker" "$(hits "$PITR_SPAN" 'docker ')" "0"
check "11 span no docker_exec" "$(hits "$PITR_SPAN" 'docker_exec')" "0"
check "11 span no psql" "$(hits "$PITR_SPAN" 'psql')" "0"
check "11 span no curl" "$(hits "$PITR_SPAN" 'curl ')" "0"
check "11 span no aws" "$(hits "$PITR_SPAN" 'aws ')" "0"
for secret in SOURCE_ENCRYPTION_KEY PGPASSWORD JWT_SECRET APP_ROLE_PASSWORD BG_ROLE_PASSWORD; do
  check "11 span no $secret" "$(hits "$PITR_SPAN" "$secret")" "0"
done
check "11 dispatch before docker check" "$([ "$(grep -n -- '--pitr.*dispatch' "$RESTORE" | head -n1 | cut -d: -f1)" -lt "$(grep -n 'command -v docker' "$RESTORE" | head -n1 | cut -d: -f1)" ] && echo yes || echo no)" "yes"
BAD_OK=0
for f in "$WORK"/out.happy "$WORK"/out.carry "$WORK"/out.segsize "$WORK"/out.scope; do
  [ -f "$f" ] || { BAD_OK=$((BAD_OK + 1)); continue; }
  grep -q '^pitr=ok ' "$f" || BAD_OK=$((BAD_OK + 1))
done
for f in "$WORK"/out.badlsn "$WORK"/out.partial "$WORK"/out.gap "$WORK"/out.tampered "$WORK"/out.label "$WORK"/out.scope-in "$WORK"/out.segsize-wrong; do
  [ -f "$f" ] || continue
  if grep -q '^pitr=ok ' "$f"; then BAD_OK=$((BAD_OK + 1)); fi
done
check "12 ok-signal only on success" "$BAD_OK" "0"

# ===========================================================================
# 13) WAL-Ranges: wal_range_count=0 -> PITR rechaza (requiere rangos para cobertura).
# ===========================================================================
MAN13="$(make_set "$WORK/set13" s13 0/2000000 1 0/2000000 0/3000000)"
sed -i 's#^wal_range_count=.*#wal_range_count=0#' "$WORK/set13/s13.pmanifest"
sed -i '/^wal_range_1_/d' "$WORK/set13/s13.pmanifest"
WAL13="$WORK/wal13"; make_wal "$WAL13" 2 2
OUT13="$WORK/pitr-out13"
run_pitr nowalranges "$MAN13" "$WAL13" 0/3000000 "$OUT13"
check "13 wal_range_count=0 refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"
check "13 no pitr=ok" "$(grep -c '^pitr=ok ' "$OUT" || true)" "0"

# ===========================================================================
# 14) WAL-Ranges: rango declarado no cubre until_lsn (coverage falla).
# ===========================================================================
MAN14="$(make_set "$WORK/set14" s14 0/2000000 1 0/2000000 0/2FFFFFF)"
WAL14="$WORK/wal14"; make_wal "$WAL14" 2 2
OUT14="$WORK/pitr-out14"
run_pitr covfail "$MAN14" "$WAL14" 0/3000000 "$OUT14"
check "14 range does not cover until_lsn refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"

# ===========================================================================
# 15) WAL-Ranges: timeline en rango != base_timeline (no cambio de timeline).
# ===========================================================================
MAN15="$(make_set "$WORK/set15" s15 0/2000000 1 0/2000000 0/3000000)"
sed -i 's#^wal_range_1_timeline=.*#wal_range_1_timeline=2#' "$WORK/set15/s15.pmanifest"
WAL15="$WORK/wal15"; make_wal "$WAL15" 2 2
OUT15="$WORK/pitr-out15"
run_pitr tlmismatch "$MAN15" "$WAL15" 0/3000000 "$OUT15"
check "15 WAL-Ranges timeline mismatch refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"

# ===========================================================================
# 16) WAL-Ranges: wal_range_count ausente en .pmanifest.
# ===========================================================================
MAN16="$(make_set "$WORK/set16" s16 0/2000000 1 0/2000000 0/3000000)"
sed -i '/^wal_range_count=/d' "$WORK/set16/s16.pmanifest"
WAL16="$WORK/wal16"; make_wal "$WAL16" 2 2
OUT16="$WORK/pitr-out16"
run_pitr nocount "$MAN16" "$WAL16" 0/3000000 "$OUT16"
check "16 missing wal_range_count refuses" "$([ "$RC" != "0" ] && echo nonzero || echo zero)" "nonzero"

echo "----"
if [[ "$FAIL" == 0 ]]; then echo "  $PASS ok, 0 fail"; else echo "  $PASS ok, $FAIL fail"; fi
exit "$([ "$FAIL" == 0 ] && echo 0 || echo 1)"
