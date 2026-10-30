#!/usr/bin/env bash
# M31.4 / F-P6 -- contract tests for scripts/ops/wal-chain-manifest.sh
#
# Offline and deterministic: synthetic artefacts only (tiny segment size), no
# Docker, no network, no PostgreSQL, no credentials. Every case asserts the real
# exit status and, where relevant, the manifest content or the coverage window.
#
# Run: bash scripts/ops/test-ops-wal-chain.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAIN_SH="$ROOT_DIR/scripts/ops/wal-chain-manifest.sh"
PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no()   { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (wanted $3 got $2)"; fi; }

# H-04 (M31.6): 16 MiB is the ONLY supported segment size, so fixtures use sparse
# 16 MiB files (truncate) instead of tiny ones. base_lsn 0/20 = 32 bytes into
# segment 0 (logid 0, segno 0).
export WAL_CHAIN_SEGSIZE=16777216
SEGSZ=16777216

mval() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/,"",$0); print; exit}' "$2"; }

run_emit() {  # run_emit <base> <walldir> <out> ; sets RC
  RC=0
  bash "$CHAIN_SH" --emit --base "$1" --wal-dir "$2" --out "$3" >/dev/null 2>&1 || RC=$?
}
run_verify() {  # run_verify <chain> <walldir> [setdir] ; sets RC
  # --set-dir is REQUIRED by the tool (H-01): a chain alone cannot prove which
  # physical set it belongs to, so the check must be able to see the set.
  RC=0
  bash "$CHAIN_SH" --verify --chain "$1" --wal-dir "$2" --set-dir "${3:-$WORK}" >/dev/null 2>&1 || RC=$?
}

# --- fixtures ---------------------------------------------------------------
# The physical set must be complete: <set_id>.pmanifest AND the PostgreSQL manifest
# it links, whose digest is recorded in the set manifest (H-01).
BASE_MAN="$WORK/base1.pmanifest"
printf 'pg-manifest-base1\n' > "$WORK/base1.backup_manifest"
MAN_SHA="$(sha256sum < "$WORK/base1.backup_manifest" | awk '{print $1}')"
printf 'format=pg-base-tar-set\nschema_version=1\nset_id=base1\nbase_lsn=0/20\nbase_timeline=1\nmanifest_file=base1.backup_manifest\nmanifest_sha256=%s\nstatus=complete\n' \
  "$MAN_SHA" > "$BASE_MAN"

seg() { printf '0000000100000000%08X' "$1"; }
mkseg() { truncate -s "$SEGSZ" "$1/$(seg "$2")"; }

WAL="$WORK/wal"; mkdir -p "$WAL"
for i in 0 1 2 3; do mkseg "$WAL" "$i"; done
head -c 12 /dev/zero > "$WAL/$(seg 3).00000028.backup"

echo "M31.4 F-P6 WAL chain manifest contract tests (offline, synthetic artefacts)"

# --- 1. valid chain ---------------------------------------------------------
run_emit "$BASE_MAN" "$WAL" "$WORK/ok.walchain"
check "1 valid chain emits (exit 0)" "$RC" "0"
check "1 segment_count" "$(mval segment_count "$WORK/ok.walchain")" "4"
check "1 coverage_start is base_lsn" "$(mval coverage_start_lsn "$WORK/ok.walchain")" "0/20"
check "1 coverage_end is start of last segment" "$(mval coverage_end_lsn "$WORK/ok.walchain")" "0/3000000"
check "1 gap_free" "$(mval gap_free "$WORK/ok.walchain")" "yes"
check "1 status complete" "$(mval status "$WORK/ok.walchain")" "complete"
check "1 aux backup recorded" "$(mval aux_count "$WORK/ok.walchain")" "1"
check "1 aux kind" "$(mval aux_1_kind "$WORK/ok.walchain")" "backup"
check "1 base manifest sha carried over" "$(mval base_manifest_sha256 "$WORK/ok.walchain")" "$MAN_SHA"

# --- 2. valid chain verifies ------------------------------------------------
run_verify "$WORK/ok.walchain" "$WAL"
check "2 valid chain verifies (exit 0)" "$RC" "0"

# --- 3. idempotent re-emit --------------------------------------------------
OUT="$(bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --out "$WORK/ok.walchain" 2>&1)"; RC=$?
check "3 re-emit is idempotent (exit 0)" "$RC" "0"
case "$OUT" in *unchanged*) ok "3 re-emit reports unchanged";; *) no "3 re-emit reports unchanged";; esac

# --- 3b/3c. Growing store updates the chain; shrinking store is refused ----
GW="$WORK/grow-wal"; mkdir -p "$GW"; for i in 0 1 2; do mkseg "$GW" "$i"; done
bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$GW" --out "$WORK/grow.walchain" >/dev/null 2>&1
check "3b first emit (3 segments)" "$(mval segment_count "$WORK/grow.walchain")" "3"
mkseg "$GW" 3
OUT="$(bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$GW" --out "$WORK/grow.walchain" 2>&1)"; RC=$?
check "3b growing store updates the chain" "$RC" "0"
case "$OUT" in *"(updated from 3 segments)"*) ok "3b update is reported, not silent";; *) no "3b update is reported, not silent";; esac
check "3b coverage extended" "$(mval coverage_end_lsn "$WORK/grow.walchain")" "0/3000000"
rm -f "$GW/$(seg 3)"
bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$GW" --out "$WORK/grow.walchain" >/dev/null 2>&1
check "3c shrinking store refuses to overwrite" "$?" "1"
check "3c manifest kept the larger coverage" "$(mval coverage_end_lsn "$WORK/grow.walchain")" "0/3000000"

# --- 4. divergent pre-existing chain is not overwritten ---------------------
printf 'format=pg-wal-chain\nschema_version=1\nbase_set=other\nstatus=complete\n' > "$WORK/divergent.walchain"
run_emit "$BASE_MAN" "$WAL" "$WORK/divergent.walchain"
check "4 divergent existing chain refused" "$RC" "1"
check "4 divergent chain untouched" "$(mval base_set "$WORK/divergent.walchain")" "other"

# --- 5. missing referenced segment ------------------------------------------
cp "$WORK/ok.walchain" "$WORK/c5.walchain"
mv "$WAL/$(seg 2)" "$WORK/seg2.keep"
run_verify "$WORK/c5.walchain" "$WAL"
check "5 missing segment refuses" "$RC" "1"
mv "$WORK/seg2.keep" "$WAL/$(seg 2)"

# --- 6. corrupt segment (same size, different content) ----------------------
printf 'X' | dd of="$WAL/$(seg 3)" bs=1 seek=0 conv=notrunc status=none
run_verify "$WORK/ok.walchain" "$WAL"
check "6 corrupt segment refuses" "$RC" "1"
mkseg "$WAL" 3

# --- 7. divergent size ------------------------------------------------------
head -c 8 /dev/zero > "$WAL/$(seg 3)"
run_verify "$WORK/ok.walchain" "$WAL"
check "7 divergent size refuses" "$RC" "1"
mkseg "$WAL" 3

# --- 8. declared coverage that cannot be proven -----------------------------
sed 's|^coverage_end_lsn=.*|coverage_end_lsn=0/90|' "$WORK/ok.walchain" > "$WORK/c8.walchain"
run_verify "$WORK/c8.walchain" "$WAL"
check "8 unprovable declared coverage refuses" "$RC" "1"

# --- 9. invalid / traversal-ish names in --wal-dir --------------------------
W9="$WORK/wal9"; mkdir -p "$W9"; cp "$WAL/"* "$W9/"
rm -f "$W9/$(seg 3).00000028.backup"
cp "$WAL/$(seg 2)" "$W9/000000010000000000000002.bak"      # unknown suffix
run_emit "$BASE_MAN" "$W9" "$WORK/c9.walchain"
check "9 unknown artefact name refuses" "$RC" "1"
rm -f "$W9/000000010000000000000002.bak"
cp "$WAL/$(seg 2)" "$W9/00000001000000000000000a"           # lowercase segment
run_emit "$BASE_MAN" "$W9" "$WORK/c9b.walchain"
check "9 lowercase segment name refuses" "$RC" "1"

# --- 10. unexpected file in --wal-dir ---------------------------------------
W10="$WORK/wal10"; mkdir -p "$W10"; cp "$WAL/"* "$W10/"; touch "$W10/notes.txt"
run_emit "$BASE_MAN" "$W10" "$WORK/c10.walchain"
check "10 unexpected file refuses" "$RC" "1"

# --- 11. hole in the chain --------------------------------------------------
W11="$WORK/wal11"; mkdir -p "$W11"; cp "$WAL/$(seg 2)" "$W11/"; cp "$WAL/$(seg 3)" "$W11/"
run_emit "$BASE_MAN" "$W11" "$WORK/c11.walchain"
check "11 gapped chain refuses" "$RC" "1"

# --- 12. base segment missing ----------------------------------------------
W12="$WORK/wal12"; mkdir -p "$W12"; cp "$WAL/$(seg 3)" "$W12/"
run_emit "$BASE_MAN" "$W12" "$WORK/c12.walchain"
check "12 base segment missing refuses" "$RC" "1"

# --- 13/14. foreign timeline with and without history ----------------------
W13="$WORK/wal13"; mkdir -p "$W13"; cp "$WAL/$(seg 0)" "$W13/"
printf '000000020000000000000003' > /dev/null
truncate -s "$SEGSZ" "$W13/000000020000000000000003"
run_emit "$BASE_MAN" "$W13" "$WORK/c13.walchain"
check "13 foreign timeline without history refuses" "$RC" "1"
truncate -s "$SEGSZ" "$W13/00000002.history"
run_emit "$BASE_MAN" "$W13" "$WORK/c14.walchain"
check "14 foreign timeline with history emits" "$RC" "0"
check "14 foreign segment recorded" "$(mval foreign_segment_count "$WORK/c14.walchain")" "1"
check "14 coverage not extended by foreign timeline" "$(mval coverage_end_lsn "$WORK/c14.walchain")" "0/20"
run_verify "$WORK/c14.walchain" "$W13"
check "14 chain with foreign timeline verifies" "$RC" "0"

# --- 15. base manifest without manifest_sha256 -----------------------------
printf 'format=pg-base-tar-set\nschema_version=1\nset_id=base2\nbase_lsn=0/20\nbase_timeline=1\nstatus=complete\n' > "$WORK/base2.pmanifest"
run_emit "$WORK/base2.pmanifest" "$WAL" "$WORK/c15.walchain"
check "15 base without manifest_sha256 refuses" "$RC" "1"

# --- 16. unsupported base schema_version -----------------------------------
sed 's|^schema_version=1$|schema_version=9|' "$BASE_MAN" > "$WORK/base3.pmanifest"
run_emit "$WORK/base3.pmanifest" "$WAL" "$WORK/c16.walchain"
check "16 unsupported base schema refuses" "$RC" "1"

# --- 17/18. chain manifest problems ----------------------------------------
run_verify "$WORK/does-not-exist.walchain" "$WAL"
check "17 missing chain manifest refuses" "$RC" "1"
sed 's|^schema_version=1$|schema_version=9|' "$WORK/ok.walchain" > "$WORK/c18.walchain"
run_verify "$WORK/c18.walchain" "$WAL"
check "18 unsupported chain schema refuses" "$RC" "1"

# --- 19. divergent auxiliary artefact --------------------------------------
head -c 5 /dev/zero > "$WAL/$(seg 3).00000028.backup"
run_verify "$WORK/ok.walchain" "$WAL"
check "19 divergent aux artefact refuses" "$RC" "1"
head -c 12 /dev/zero > "$WAL/$(seg 3).00000028.backup"

# --- 20. aux kind does not match its name ----------------------------------
sed 's|^aux_1_kind=backup$|aux_1_kind=history|' "$WORK/ok.walchain" > "$WORK/c20.walchain"
run_verify "$WORK/c20.walchain" "$WAL"
check "20 aux kind mismatch refuses" "$RC" "1"

# --- 21. symlink in --wal-dir ----------------------------------------------
W21="$WORK/wal21"; mkdir -p "$W21"; cp "$WAL/"* "$W21/"
rm -f "$W21/$(seg 2)"; ln -s "$WAL/$(seg 2)" "$W21/$(seg 2)"
run_emit "$BASE_MAN" "$W21" "$WORK/c21.walchain"
check "21 symlink in wal-dir refuses" "$RC" "1"

# --- 22. segment declared on another timeline ------------------------------
sed 's|^segment_2_timeline=1$|segment_2_timeline=2|' "$WORK/ok.walchain" > "$WORK/c22.walchain"
run_verify "$WORK/c22.walchain" "$WAL"
check "22 wrong timeline in manifest refuses" "$RC" "1"

# --- 23. non-contiguous manifest ------------------------------------------
awk 'NR==1{next} {print}' "$WORK/ok.walchain" >/dev/null
{ grep -v '^segment_' "$WORK/ok.walchain"; } > "$WORK/c23.walchain"
{
  grep -v '^segment_[0-9]' "$WORK/ok.walchain"
  printf 'segment_count=2\n'
  for f in segment_1 segment_2; do
    grep "^${f}_" "$WORK/ok.walchain"
  done
} > "$WORK/c23b.walchain"
# swap the two segment names so the chain is no longer contiguous
sed -e 's|^segment_1_name=\(.*\)$|segment_1_name=TMP|' -e 's|^segment_2_name=\(.*\)$|segment_1_name=\1|' -e 's|^segment_1_name=TMP$|segment_2_name=SEG1|' "$WORK/c23b.walchain" > "$WORK/c23c.walchain"
run_verify "$WORK/c23c.walchain" "$WAL"
check "23 non-contiguous manifest refuses" "$RC" "1"

# --- 24. unknown argument / missing mode ----------------------------------
bash "$CHAIN_SH" --wal-dir "$WAL" >/dev/null 2>&1
check "24 missing mode refuses" "$?" "1"
bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --bogus x >/dev/null 2>&1
check "24 unknown argument refuses" "$?" "1"
bash "$CHAIN_SH" --help >/dev/null 2>&1
check "24 --help exits 0" "$?" "0"

# ===========================================================================
# R1 integration: the verified chain authorises a target BEYOND the base's own
# declared WAL-Ranges, while the legacy path keeps refusing it.
# ===========================================================================
RESTORE="$ROOT_DIR/scripts/ops/postgres-restore.sh"
UNTIL="2026-01-02T03:04:05Z"

make_base_set() {  # make_base_set <dir> <sid> <lsn> <tl> <wal_start> <wal_end>
  local dir="$1" sid="$2" lsn="$3" tl="$4" ws="$5" we="$6" stage sb sw sm bb bw bm
  stage="$WORK/stage.$sid"; rm -rf "$stage"; mkdir -p "$stage" "$dir"
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
  {
    printf 'format=pg-base-tar-set\nschema_version=1\nset_id=%s\ncreated_at=2026-01-01T00:00:00Z\n' "$sid"
    printf 'postgres_version=16\nbase_lsn=%s\nbase_timeline=%s\n' "$lsn" "$tl"
    printf 'base_tar_file=%s.base.tar\nbase_tar_sha256=%s\nbase_tar_bytes=%s\n' "$sid" "$sb" "$bb"
    printf 'pgwal_tar_file=%s.pg_wal.tar\npgwal_tar_sha256=%s\npgwal_tar_bytes=%s\n' "$sid" "$sw" "$bw"
    printf 'manifest_file=%s.backup_manifest\nmanifest_sha256=%s\nmanifest_bytes=%s\n' "$sid" "$sm" "$bm"
    printf 'wal_range_count=1\nwal_range_1_timeline=%s\nwal_range_1_start_lsn=%s\nwal_range_1_end_lsn=%s\n' "$tl" "$ws" "$we"
    printf 'status=complete\n'
  } > "$stage/${sid}.pmanifest"
  mv "$stage/${sid}.pmanifest" "$dir/"; mv "$stage/base.tar" "$dir/${sid}.base.tar"
  mv "$stage/pg_wal.tar" "$dir/${sid}.pg_wal.tar"; mv "$stage/backup_manifest" "$dir/${sid}.backup_manifest"
  rm -rf "$stage"
}

RSET="$WORK/rset"
# Narrow declared range (inside segment 2 only) while the chain covers up to 0/50.
make_base_set "$RSET" r1 0/20 1 0/20 0/2F
RWAL="$WORK/rwal"; mkdir -p "$RWAL"
for i in 0 1 2 3; do mkseg "$RWAL" "$i"; done
bash "$CHAIN_SH" --emit --base "$RSET/r1.pmanifest" --wal-dir "$RWAL" --out "$WORK/r1.walchain" >/dev/null 2>&1
check "R1 chain emitted for the narrow base" "$?" "0"
check "R1 chain coverage reaches 0/50" "$(mval coverage_end_lsn "$WORK/r1.walchain")" "0/3000000"

run_pitr_r1() {  # run_pitr_r1 <tag> <ulsn> [extra args...] ; UNTIL_OVERRIDE replaces --until
  local tag="$1" ulsn="$2"; shift 2
  local until="${UNTIL_OVERRIDE:-$UNTIL}"
  RC=0
  bash "$RESTORE" --pitr --base "$RSET/r1.pmanifest" --wal-dir "$RWAL" \
    --until "$until" --until-lsn "$ulsn" --out "$WORK/out.$tag" --wal-segsize "$SEGSZ" "$@" \
    >"$WORK/out.$tag.log" 2>&1 || RC=$?
}

# 25. THE R1 FIX: target beyond the declared range, inside the verified chain.
run_pitr_r1 chain-ok 0/2000000 --wal-chain "$WORK/r1.walchain"
check "25 chain authorises target beyond declared range" "$RC" "0"
check "25 summary reports chain=1" "$(grep -c '^pitr=prepared .*chain=1 ' "$WORK/out.chain-ok.log" || true)" "1"
check "25 chain verification was performed" "$(grep -c 'coverage authorised by the verified WAL chain' "$WORK/out.chain-ok.log" || true)" "1"

# 26. Compatibility: without the chain the legacy WAL-Ranges walk still refuses.
run_pitr_r1 legacy 0/2000000
check "26 legacy path still refuses (unchanged)" "$RC" "1"
check "26 legacy refusal names the declared ranges" "$(grep -c 'not fully covered by the declared WAL-Ranges' "$WORK/out.legacy.log" || true)" "1"

# 27. Target beyond the verified coverage is still refused.
run_pitr_r1 beyond 0/4000000 --wal-chain "$WORK/r1.walchain"
check "27 target beyond chain coverage refuses" "$RC" "1"
check "27 refusal names the coverage end" "$(grep -c 'not covered by the verified WAL chain' "$WORK/out.beyond.log" || true)" "1"

# 28. Chain for a different base set is refused.
# With H-01 the refusal is now EARLIER and stronger: the chain cannot even be
# linked to a set (there is no <other>.pmanifest), so the link check fails first.
sed 's|^base_set=r1$|base_set=other|' "$WORK/r1.walchain" > "$WORK/other.walchain"
run_pitr_r1 other 0/2000000 --wal-chain "$WORK/other.walchain"
check "28 chain for another set refuses" "$RC" "1"
check "28 refusal names the chain link check" "$(grep -c 'does not verify against --wal-dir and the physical set' "$WORK/out.other.log" || true)" "1"

# 29. Chain whose base_lsn does not match the base manifest.
sed 's|^base_lsn=0/20$|base_lsn=0/30|' "$WORK/r1.walchain" > "$WORK/badlsn.walchain"
run_pitr_r1 badlsn 0/2000000 --wal-chain "$WORK/badlsn.walchain"
check "29 mismatched chain base_lsn refuses" "$RC" "1"

# 30. Tampered archived segment: the chain no longer verifies.
cp "$RWAL/$(seg 3)" "$WORK/seg3.keep"
printf 'Z' | dd of="$RWAL/$(seg 3)" bs=1 seek=0 conv=notrunc status=none
run_pitr_r1 tampered 0/2000000 --wal-chain "$WORK/r1.walchain"
check "30 tampered segment refuses" "$RC" "1"
check "30 refusal names the chain verification" "$(grep -c 'does not verify against --wal-dir' "$WORK/out.tampered.log" || true)" "1"
cp "$WORK/seg3.keep" "$RWAL/$(seg 3)"

# 31. Explicit --wal-chain that does not exist.
run_pitr_r1 nofile 0/2000000 --wal-chain "$WORK/missing.walchain"
check "31 missing --wal-chain refuses" "$RC" "1"
check "31 refusal names --wal-chain" "$(grep -c -- '--wal-chain not found' "$WORK/out.nofile.log" || true)" "1"

# 32. Auto-discovery of <base>.walchain next to the base manifest.
cp "$WORK/r1.walchain" "$RSET/r1.walchain"
run_pitr_r1 auto 0/2000000
check "32 auto-discovered chain authorises the target" "$RC" "0"
check "32 auto path reports chain=1" "$(grep -c '^pitr=prepared .*chain=1 ' "$WORK/out.auto.log" || true)" "1"
rm -f "$RSET/r1.walchain"

# 33. The emitted config still holds exactly one recovery target, PG16-acceptable.
check "33 one recovery target with chain" "$(grep -cE '^recovery_target_(time|lsn|xid|name) =' "$WORK/out.chain-ok/postgresql.pitr.conf")" "1"
check "33 recovery_target_time is PG16-acceptable" "$(grep -c "^recovery_target_time = '2026-01-02T03:04:05+00'$" "$WORK/out.chain-ok/postgresql.pitr.conf")" "1"

# 34. Legacy path unaffected when the base has no declared ranges at all.
make_base_set "$WORK/rset2" r2 0/20 1 0/20 0/2F
bash "$CHAIN_SH" --emit --base "$WORK/rset2/r2.pmanifest" --wal-dir "$RWAL" --out "$WORK/r2.walchain" >/dev/null 2>&1
check "34 chain emits for a second set" "$?" "0"
RC=0
bash "$RESTORE" --pitr --base "$WORK/rset2/r2.pmanifest" --wal-dir "$RWAL" --until "$UNTIL" \
  --until-lsn 0/1000000 --out "$WORK/out.r2" --wal-segsize "$SEGSZ" --wal-chain "$WORK/r2.walchain" >/dev/null 2>&1 || RC=$?
check "34 second set chain path works" "$RC" "0"

# ===========================================================================
# Off-host integration (F-P6): logical flow unchanged, physical set + WAL chain
# published with the chain manifest as the commit record.
# ===========================================================================
OSTORE="$WORK/ostore"; mkdir -p "$OSTORE"; OLOG="$WORK/olog"; : > "$OLOG"
# M31.8: the transport is three scripts (PUT / HEAD / GET) sharing a store and a
# log. The client reads every object back before it reports success, so a double
# that can only PUT cannot run the client at all any more; and the log has to
# distinguish a write from a read, because "the chain was published last" is an
# assertion about PUTs only.
#
# Log records: PUT|<key> | HEAD|<key> | GET|<key>
# Knobs: O_DOUBLE_FAIL_KEY (the PUT fails), O_DOUBLE_DIVERGE_KEY (the PUT refuses
# when the stored object differs: the backstop behind the client's own guard),
# O_HEAD_ON + O_HEAD_MODE=blind (the probe answers "absent" for an object that
# exists: the race the client's guard cannot close).
cat > "$WORK/s3put.sh" <<'EOS'
#!/usr/bin/env bash
# s3put.sh <file> <key> [retain_until] [sha256]
set -uo pipefail
STORE="${O_DOUBLE_STORE:?}"; LOG="${O_DOUBLE_LOG:?}"
file="$1"; key="$2"
printf 'PUT|%s\n' "$key" >> "$LOG"
if [[ -n "${O_DOUBLE_FAIL_KEY:-}" ]] && [[ "$key" == *"${O_DOUBLE_FAIL_KEY}"* ]]; then
  echo "s3double: injected failure for $key" >&2; exit 1
fi
if [[ -n "${O_DOUBLE_DIVERGE_KEY:-}" ]] && [[ "$key" == *"${O_DOUBLE_DIVERGE_KEY}"* ]]; then
  if [[ -f "$STORE/$key" ]] && ! cmp -s "$file" "$STORE/$key"; then
    echo "s3double: refusing to overwrite a divergent object: $key" >&2; exit 2
  fi
fi
mkdir -p "$STORE/$(dirname "$key")"
cp -f "$file" "$STORE/$key"
EOS
cat > "$WORK/s3head.sh" <<'EOS'
#!/usr/bin/env bash
# s3head.sh <key> -> size on stdout; 0 exists / 3 absent / 1 undetermined
set -uo pipefail
STORE="${O_DOUBLE_STORE:?}"; LOG="${O_DOUBLE_LOG:?}"
printf 'HEAD|%s\n' "$1" >> "$LOG"
if [[ -n "${O_HEAD_ON:-}" && "$1" == *"${O_HEAD_ON}"* && "${O_HEAD_MODE:-}" == "blind" ]]; then
  exit 3
fi
if [[ -f "$STORE/$1" ]]; then
  printf '%s' "$(wc -c < "$STORE/$1" | tr -d ' \r\n')"
  exit 0
fi
exit 3
EOS
cat > "$WORK/s3get.sh" <<'EOS'
#!/usr/bin/env bash
# s3get.sh <key> <dest>
set -uo pipefail
STORE="${O_DOUBLE_STORE:?}"; LOG="${O_DOUBLE_LOG:?}"
printf 'GET|%s\n' "$1" >> "$LOG"
if [[ ! -f "$STORE/$1" ]]; then echo "s3double: no such object: $1" >&2; exit 3; fi
cp -f "$STORE/$1" "$2"
EOS
chmod +x "$WORK/s3put.sh" "$WORK/s3head.sh" "$WORK/s3get.sh"

# Only the PUT records, in order: the read-back adds HEAD/GET lines to the same log.
oputs() { grep '^PUT|' "$OLOG" 2>/dev/null || true; }

printf 'dump-bytes\n' > "$WORK/logical.dump"
printf 'roles\n' > "$WORK/logical.roles.sql"
# M31.8 (C1): the manifest must describe the files it travels with, so the fixture
# carries real digests. A fixture with a placeholder digest would only exercise the
# refusal path.
printf 'format=pg_dump-custom\ndump_sha256=%s\nroles_sha256=%s\n' \
  "$(sha256sum < "$WORK/logical.dump" | awk '{print $1}')" \
  "$(sha256sum < "$WORK/logical.roles.sql" | awk '{print $1}')" > "$WORK/logical.manifest"

run_offhost() {  # run_offhost <tag> [extra args...]
  local tag="$1"; shift
  : > "$OLOG"
  RC=0
  BACKUP_BUCKET=bucket OFFHOST_S3_CMD="$WORK/s3put.sh" \
    OFFHOST_S3_HEAD_CMD="$WORK/s3head.sh" OFFHOST_S3_GET_CMD="$WORK/s3get.sh" \
    O_DOUBLE_STORE="$OSTORE" O_DOUBLE_LOG="$OLOG" \
    B2_S3_ENDPOINT=http://s3.invalid B2_S3_REGION=test-region \
    BACKUP_PREFIX=test OFFHOST_UPLOAD_RETRIES=1 OFFHOST_UPLOAD_RETRY_DELAY_SECONDS=0 \
    bash "$ROOT_DIR/scripts/ops/offhost-upload.sh" --backup "$WORK/logical.dump" "$@" \
    >"$WORK/off.$tag.log" 2>&1 || RC=$?
}

# The off-host physical flow expects the chain next to the base manifest
# (<set_id>.walchain), which is where wal-chain-manifest.sh publishes it.
cp "$WORK/r1.walchain" "$RSET/r1.walchain"

# 35. Logical-only flow is unchanged.
run_offhost logical
check "35 logical upload exits 0" "$RC" "0"
check "35 logical uploads exactly 3 objects" "$(oputs | grep -c .)" "3"
check "35 manifest is the last logical object" "$(oputs | tail -1)" "PUT|backups/test/logical.manifest"
check "35 logical summary unchanged" "$(grep -c '^offhost=uploaded bucket=bucket prefix=test base=logical objects=3 physical=none' "$WORK/off.logical.log")" "1"
check "35 transport reported as simulated" "$(grep -c 'transport=simulated' "$WORK/off.logical.log")" "1"
# M31.8 (C2): the summary claims verification only because every object was read
# back, and the log proves the reads happened.
check "35 logical summary claims 3/3 verified" "$(grep -c 'verified=3/3 identical=0 remote_verified=yes' "$WORK/off.logical.log")" "1"
check "35 three objects were read back" "$(grep -c '^GET|' "$OLOG")" "3"
check "35 six probes (pre-check + read-back)" "$(grep -c '^HEAD|' "$OLOG")" "6"

# 36. Physical set + chain are published, chain LAST.
# The logical set is always published too: 3 logical objects + 9 physical ones
# (4 members + 4 segments + the chain manifest).
run_offhost physical --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL"
check "36 physical upload exits 0" "$RC" "0"
check "36 logical+physical objects uploaded" "$(oputs | grep -c .)" "12"
check "36 chain manifest is the last object" "$(oputs | tail -1)" "PUT|backups/test/physical/r1/r1.walchain"
check "36 members published" "$(grep -c '^PUT|backups/test/physical/r1/r1.base.tar$' "$OLOG")" "1"
check "36 segments published under wal/" "$(grep -c '^PUT|backups/test/physical/r1/wal/00000001000000000000000[0123]$' "$OLOG")" "4"
check "36 physical summary reports the set" "$(grep -c '^offhost=uploaded .* physical=r1 transport=simulated' "$WORK/off.physical.log")" "1"
# The physical run verifies all 12 objects, chain included.
check "36 physical summary claims 12/12 verified" "$(grep -c 'verified=12/12 .* remote_verified=yes' "$WORK/off.physical.log")" "1"
# 12 read-backs + 3 pre-check reads: the logical objects were already stored by test
# 35, so the divergence guard reads them before re-publishing them.
check "36 the 12 objects were read back (plus 3 pre-check reads)" "$(grep -c '^GET|' "$OLOG")" "15"
check "36 the chain itself was read back" "$(grep -c '^GET|backups/test/physical/r1/r1.walchain$' "$OLOG")" "1"

# 37. Re-running is idempotent (same keys, still exit 0). The second run finds every
# object already stored and byte-identical, which the guard reports as identical.
run_offhost physical2 --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL"
check "37 re-run exits 0" "$RC" "0"
check "37 same number of objects" "$(oputs | grep -c .)" "12"
check "37 the guard found all 12 objects identical" "$(grep -c 'identical=12' "$WORK/off.physical2.log")" "1"
check "37 the re-run still verifies the remote" "$(grep -c 'verified=12/12 .* remote_verified=yes' "$WORK/off.physical2.log")" "1"

# 38. Missing chain manifest: refused BEFORE any upload.
rm -f "$RSET/r1.walchain"
run_offhost nochain --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL"
check "38 missing chain refuses" "$RC" "1"
check "38 nothing was uploaded" "$(grep -c . "$OLOG")" "0"
check "38 refusal names the chain" "$(grep -c 'complementary WAL chain manifest not found' "$WORK/off.nochain.log")" "1"
cp "$WORK/r1.walchain" "$RSET/r1.walchain"   # restore for the remaining cases

# 39. Tampered segment: refused before any upload.
cp "$RWAL/$(seg 1)" "$WORK/seg1.keep"
printf 'Q' | dd of="$RWAL/$(seg 1)" bs=1 seek=0 conv=notrunc status=none
run_offhost tampered --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL"
check "39 tampered segment refuses" "$RC" "1"
check "39 nothing was uploaded" "$(grep -c . "$OLOG")" "0"
cp "$WORK/seg1.keep" "$RWAL/$(seg 1)"

# 40. --wal-dir is mandatory with --physical-set.
run_offhost nowal --physical-set "$RSET/r1.pmanifest"
check "40 missing --wal-dir refuses" "$RC" "1"

# 41. Dry-run performs no uploads and still validates.
run_offhost dry --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL" --dry-run
check "41 dry-run exits 0" "$RC" "0"
check "41 dry-run uploads nothing" "$(grep -c . "$OLOG")" "0"
check "41 dry-run reports physical set" "$(grep -c '^offhost=dry-run .* physical=r1' "$WORK/off.dry.log")" "1"

# ===========================================================================
# M31.6 findings: H-01 (link to the PostgreSQL manifest), H-02 (temporal target),
# H-03 (LSN arithmetic), H-04 (segment size), H-05 (upload signal), H-06
# (divergence branch of the transport double).
# ===========================================================================

# --- H-01: the chain must be linked to the physical set --------------------
# 42. --verify without --set-dir must refuse (a chain alone proves nothing).
RC=0
bash "$CHAIN_SH" --verify --chain "$WORK/ok.walchain" --wal-dir "$WAL" >/dev/null 2>&1 || RC=$?
check "42 verify without --set-dir refuses" "$RC" "1"

# 43. the PostgreSQL manifest is missing from the set directory.
mv "$WORK/base1.backup_manifest" "$WORK/base1.backup_manifest.keep"
run_verify "$WORK/ok.walchain" "$WAL"
check "43 missing PostgreSQL manifest refuses" "$RC" "1"
run_emit "$BASE_MAN" "$WAL" "$WORK/h01emit.walchain"
check "43 emit also refuses without the PostgreSQL manifest" "$RC" "1"
mv "$WORK/base1.backup_manifest.keep" "$WORK/base1.backup_manifest"

# 44. the PostgreSQL manifest was MODIFIED (digest no longer matches).
cp "$WORK/base1.backup_manifest" "$WORK/base1.backup_manifest.keep"
printf 'tampered\n' >> "$WORK/base1.backup_manifest"
run_verify "$WORK/ok.walchain" "$WAL"
check "44 modified PostgreSQL manifest refuses" "$RC" "1"
run_emit "$BASE_MAN" "$WAL" "$WORK/h01emit2.walchain"
check "44 emit refuses a modified PostgreSQL manifest" "$RC" "1"
mv "$WORK/base1.backup_manifest.keep" "$WORK/base1.backup_manifest"

# 45. substituted manifest from ANOTHER set (same name, different content).
printf 'pg-manifest-from-another-set\n' > "$WORK/base1.backup_manifest"
run_verify "$WORK/ok.walchain" "$WAL"
check "45 substituted PostgreSQL manifest refuses" "$RC" "1"
printf 'pg-manifest-base1\n' > "$WORK/base1.backup_manifest"

# 46. path traversal in manifest_file must be rejected by the emit.
sed 's|^manifest_file=base1.backup_manifest$|manifest_file=../evil.backup_manifest|' "$BASE_MAN" > "$WORK/trav.pmanifest"
run_emit "$WORK/trav.pmanifest" "$WAL" "$WORK/h01emit3.walchain"
check "46 traversal in manifest_file refuses" "$RC" "1"

# 47. the chain cannot be linked to a set that is not in --set-dir.
RC=0
bash "$CHAIN_SH" --verify --chain "$WORK/ok.walchain" --wal-dir "$WAL" --set-dir "$WORK/nonexistent" >/dev/null 2>&1 || RC=$?
check "47 unknown --set-dir refuses" "$RC" "1"

# --- H-02: a temporal target is never reported as validated ----------------
# 48. The M31.5 probe: a far-future --until with an in-coverage --until-lsn.
UNTIL_OVERRIDE=2099-12-31T23:59:59Z run_pitr_r1 farfuture 0/2000000 --wal-chain "$WORK/r1.walchain"
check "48 far-future target still exits 0 (config is prepared)" "$RC" "0"
check "48 signal is pitr=prepared" "$(grep -c '^pitr=prepared ' "$WORK/out.farfuture.log" || true)" "1"
check "48 signal states target=unverified" "$(grep -c 'target=unverified' "$WORK/out.farfuture.log" || true)" "1"
check "48 NO success signal is printed" "$(grep -c '^pitr=ok' "$WORK/out.farfuture.log" || true)" "0"
check "48 note explains the external assertion" "$(grep -c 'temporal GOAL, not a verified target' "$WORK/out.farfuture.log" || true)" "1"
check "48 emitted config warns that reaching T is not proven" "$(grep -c 'NOT proven offline' "$WORK/out.farfuture/postgresql.pitr.conf" || true)" "1"

# --- H-03: LSN arithmetic is range-checked before comparing ----------------
# 49. an out-of-range high half must be rejected (no silent overflow).
sed 's|^coverage_end_lsn=.*|coverage_end_lsn=FFFFFFFF/FFFFFFFF|' "$WORK/ok.walchain" > "$WORK/h03range.walchain"
OUT="$(bash "$CHAIN_SH" --verify --chain "$WORK/h03range.walchain" --wal-dir "$WAL" --set-dir "$WORK" 2>&1)"; RC=$?
check "49 out-of-range coverage LSN refuses" "$RC" "1"
case "$OUT" in *"exceeds the supported int64 range"*) ok "49 refusal names the int64 range";; *) no "49 refusal names the int64 range";; esac

# 50. malformed base_lsn must be rejected as a syntax error.
sed 's|^base_lsn=.*|base_lsn=zz/20|' "$WORK/ok.walchain" > "$WORK/h03bad.walchain"
OUT="$(bash "$CHAIN_SH" --verify --chain "$WORK/h03bad.walchain" --wal-dir "$WAL" --set-dir "$WORK" 2>&1)"; RC=$?
check "50 malformed base_lsn refuses" "$RC" "1"
case "$OUT" in *"invalid LSN"*) ok "50 refusal names the malformed LSN";; *) no "50 refusal names the malformed LSN";; esac

# 51. a monotone extension must not be accepted when the OLD manifest is invalid.
cp "$WORK/ok.walchain" "$WORK/h03ext.walchain"
sed -i 's|^coverage_end_lsn=.*|coverage_end_lsn=FFFFFFFF/FFFFFFFF|' "$WORK/h03ext.walchain"
mkseg "$WAL" 4
run_emit "$BASE_MAN" "$WAL" "$WORK/h03ext.walchain"
check "51 extension with an invalid old LSN refuses" "$RC" "1"
rm -f "$WAL/$(seg 4)"

# 52. the maximum admitted value parses (the failure is about coverage, not range).
sed 's|^coverage_end_lsn=.*|coverage_end_lsn=7FFFFFFF/FFFFFFFF|' "$WORK/ok.walchain" > "$WORK/h03max.walchain"
OUT="$(bash "$CHAIN_SH" --verify --chain "$WORK/h03max.walchain" --wal-dir "$WAL" --set-dir "$WORK" 2>&1)"; RC=$?
check "52 max-value LSN refuses on coverage" "$RC" "1"
case "$OUT" in *"cannot be proven"*) ok "52 max-value LSN parsed (coverage error, not range)";; *) no "52 max-value LSN parsed (coverage error, not range)";; esac
case "$OUT" in *"int64 range"*) no "52 must not be a range error";; *) ok "52 must not be a range error";; esac

# --- H-04: only 16 MiB segments are supported ------------------------------
# 53. an unsupported size must be rejected before anything is written.
OUT="$(WAL_CHAIN_SEGSIZE=16 bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --out "$WORK/h04a.walchain" 2>&1)"; RC=$?
check "53 unsupported segment size refuses" "$RC" "1"
case "$OUT" in *"not supported"*) ok "53 refusal names the unsupported size";; *) no "53 refusal names the unsupported size";; esac
check "53 nothing was written" "$([ -e "$WORK/h04a.walchain" ] && echo yes || echo no)" "no"

# 54. the supported size, passed explicitly, is accepted.
OUT="$(WAL_CHAIN_SEGSIZE=16777216 bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --out "$WORK/h04b.walchain" 2>&1)"; RC=$?
check "54 supported segment size accepted" "$RC" "0"
check "54 wal_segsize recorded" "$(mval wal_segsize "$WORK/h04b.walchain")" "16777216"

# 55. zero and non-numeric values are refused.
WAL_CHAIN_SEGSIZE=0 bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --out "$WORK/h04c.walchain" >/dev/null 2>&1
check "55 zero segment size refuses" "$?" "1"
WAL_CHAIN_SEGSIZE=abc bash "$CHAIN_SH" --emit --base "$BASE_MAN" --wal-dir "$WAL" --out "$WORK/h04d.walchain" >/dev/null 2>&1
check "55 non-numeric segment size refuses" "$?" "1"

# --- H-05 (M31.6) + M31.8 (C2): the upload signal states what was established --
# 56. The successful physical run reads every object back, so the summary may claim
# remote_verified=yes — and must still refuse to claim durability.
check "56 summary reports uploaded + verified" "$(grep -c '^offhost=uploaded .* remote_verified=yes' "$WORK/off.physical.log")" "1"
check "56 no misleading offhost=ok signal" "$(grep -c '^offhost=ok' "$WORK/off.physical.log" || true)" "0"
check "56 the note limits the claim to the stored bytes" \
  "$(grep -c 'durability, Object Lock and lifecycle are NOT verified' "$WORK/off.physical.log" || true)" "1"
check "56 the old 'not read back' wording is gone from a verified run" \
  "$(grep -c 'remote objects were not read back' "$WORK/off.physical.log" || true)" "0"

# --- M31.8 (C3): the client's own divergence guard --------------------------
# 57. A pre-existing remote object with DIFFERENT content: the client READS it
# before writing, refuses, and never publishes the chain. A FRESH store is used so
# the assertion is about this run only.
# This is now the client's guard, not the double's backstop: the pre-check reads the
# stored object and compares it with the local file. It is a read-then-write, NOT a
# conditional write — see test 58 for the window it cannot close.
O57="$WORK/ostore57"
mkdir -p "$O57/backups/test/physical/r1"
printf 'divergent-remote-content\n' > "$O57/backups/test/physical/r1/r1.base.tar"
: > "$OLOG"
RC=0
BACKUP_BUCKET=bucket OFFHOST_S3_CMD="$WORK/s3put.sh" \
  OFFHOST_S3_HEAD_CMD="$WORK/s3head.sh" OFFHOST_S3_GET_CMD="$WORK/s3get.sh" \
  O_DOUBLE_STORE="$O57" O_DOUBLE_LOG="$OLOG" \
  B2_S3_ENDPOINT=http://s3.invalid B2_S3_REGION=test-region \
  BACKUP_PREFIX=test OFFHOST_UPLOAD_RETRIES=1 OFFHOST_UPLOAD_RETRY_DELAY_SECONDS=0 \
  bash "$ROOT_DIR/scripts/ops/offhost-upload.sh" --backup "$WORK/logical.dump" \
  --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL" > "$WORK/off.diverge.log" 2>&1 || RC=$?
check "57 divergent remote object fails the transfer" "$RC" "76"
check "57 the divergent object was not overwritten" "$(cat "$O57/backups/test/physical/r1/r1.base.tar")" "divergent-remote-content"
check "57 the chain was NOT published" "$([ -e "$O57/backups/test/physical/r1/r1.walchain" ] && echo yes || echo no)" "no"
check "57 the CLIENT reported the refusal" \
  "$(grep -c 'REFUSING to overwrite a divergent object' "$WORK/off.diverge.log" || true)" "1"
check "57 no upload signal is printed on failure" "$(grep -c '^offhost=uploaded' "$WORK/off.diverge.log" || true)" "0"
# The object was probed before the write, and refused without downloading it: the
# stored size already differs, so the content comparison never had to run.
check "57 the divergent object was probed before the write" "$(grep -c '^HEAD|.*r1.base.tar$' "$OLOG")" "1"
check "57 the refusal needed no download (size decided it)" "$(grep -c '^GET|' "$OLOG")" "0"
check "57 the divergent object was never PUT" "$(oputs | grep -c 'r1.base.tar')" "0"

# --- M31.8 (C3, limitation): the window the guard cannot close ---------------
# 58. A probe that answers "absent" for an object that EXISTS. The client trusts it,
# attempts the PUT, and the transport's own backstop refuses. This pins the race: the
# guard narrows the window between the read and the write, it does not close it.
# Closing it needs a conditional write (If-None-Match) and evidence that the endpoint
# honours it — F-P7 work, and the reason this test is a limitation and not a feature.
O58="$WORK/ostore58"
mkdir -p "$O58/backups/test/physical/r1"
printf 'divergent-remote-content\n' > "$O58/backups/test/physical/r1/r1.base.tar"
: > "$OLOG"
RC=0
BACKUP_BUCKET=bucket OFFHOST_S3_CMD="$WORK/s3put.sh" \
  OFFHOST_S3_HEAD_CMD="$WORK/s3head.sh" OFFHOST_S3_GET_CMD="$WORK/s3get.sh" \
  O_DOUBLE_STORE="$O58" O_DOUBLE_LOG="$OLOG" O_DOUBLE_DIVERGE_KEY="r1.base.tar" \
  O_HEAD_ON="r1.base.tar" O_HEAD_MODE="blind" \
  B2_S3_ENDPOINT=http://s3.invalid B2_S3_REGION=test-region \
  BACKUP_PREFIX=test OFFHOST_UPLOAD_RETRIES=1 OFFHOST_UPLOAD_RETRY_DELAY_SECONDS=0 \
  bash "$ROOT_DIR/scripts/ops/offhost-upload.sh" --backup "$WORK/logical.dump" \
  --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL" > "$WORK/off.blind.log" 2>&1 || RC=$?
check "58 blind probe: the client attempts the PUT" "$(oputs | grep -c 'r1.base.tar')" "1"
check "58 the transport backstop refuses it" \
  "$(grep -c 'refusing to overwrite a divergent object' "$WORK/off.blind.log" || true)" "1"
check "58 the run fails with 76" "$RC" "76"
check "58 the divergent object survived" "$(cat "$O58/backups/test/physical/r1/r1.base.tar")" "divergent-remote-content"
check "58 the chain was not published" "$([ -e "$O58/backups/test/physical/r1/r1.walchain" ] && echo yes || echo no)" "no"
check "58 no upload signal is printed on failure" "$(grep -c '^offhost=uploaded' "$WORK/off.blind.log" || true)" "0"

# --- M31.10 (H-6): the commit record is published BEFORE the read-back --------
# 59. The chain manifest IS published and the final verification then detects a
# discrepancy, so the run must end 76, report remote_verified=no and never announce
# success. The assertions separate "objects published" from "remote integrity
# verified": finding the chain is evidence of publication ORDER, not of integrity.
# The probe for the chain key answers "absent" while the object exists
# (O_HEAD_ON + O_HEAD_MODE=blind), which is exactly the state this case needs:
# everything was PUT, and one object cannot be confirmed afterwards.
O59="$WORK/ostore59"
mkdir -p "$O59/backups/test/physical/r1"
rm -f "$WORK/commit-alert.json"
: > "$OLOG"
RC=0
BACKUP_BUCKET=bucket OFFHOST_S3_CMD="$WORK/s3put.sh" \
  OFFHOST_S3_HEAD_CMD="$WORK/s3head.sh" OFFHOST_S3_GET_CMD="$WORK/s3get.sh" \
  O_DOUBLE_STORE="$O59" O_DOUBLE_LOG="$OLOG" \
  O_HEAD_ON="r1.walchain" O_HEAD_MODE="blind" \
  ALERT_CMD="cat > $WORK/commit-alert.json" \
  B2_S3_ENDPOINT=http://s3.invalid B2_S3_REGION=test-region \
  BACKUP_PREFIX=test OFFHOST_UPLOAD_RETRIES=1 OFFHOST_UPLOAD_RETRY_DELAY_SECONDS=0 \
  bash "$ROOT_DIR/scripts/ops/offhost-upload.sh" --backup "$WORK/logical.dump" \
  --physical-set "$RSET/r1.pmanifest" --wal-dir "$RWAL" > "$WORK/off.commit.log" 2>&1 || RC=$?
check "59 el proceso termina 76" "$RC" "76"
# Published: everything went up, in order, chain last.
check "59 el commit record SI fue publicado" \
  "$([ -e "$O59/backups/test/physical/r1/r1.walchain" ] && echo yes || echo no)" "yes"
check "59 los 12 objetos se publicaron" "$(oputs | grep -c .)" "12"
check "59 la cadena fue el ultimo objeto publicado" \
  "$(oputs | tail -1)" "PUT|backups/test/physical/r1/r1.walchain"
# ...and yet the run does not claim integrity.
check "59 el resumen dice remote_verified=no" \
  "$(grep -c '^offhost=uploaded .* remote_verified=no' "$WORK/off.commit.log")" "1"
check "59 no se anuncia exito" \
  "$(grep -c 'remote_verified=yes' "$WORK/off.commit.log" || true)" "0"
check "59 el fallo se atribuye a la verificacion de la cadena" \
  "$(grep -c 'VERIFY FAILED .*r1.walchain' "$WORK/off.commit.log" || true)" "1"
check "59 11 de 12 objetos verificados" \
  "$(grep -c 'verified=11/12' "$WORK/off.commit.log")" "1"
check "59 la alerta del 76 se emite igualmente" \
  "$(grep -c '\"exit_code\":76' "$WORK/commit-alert.json" 2>/dev/null || true)" "1"
check "59 la alerta usa el evento documentado" \
  "$(grep -c '\"result\":\"partial_upload_failed\"' "$WORK/commit-alert.json" 2>/dev/null || true)" "1"

echo "----"
printf '  %s ok, %s fail\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]

