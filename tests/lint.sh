#!/usr/bin/env bash
#
# Repo-wide static checks: line endings, shell syntax, node syntax.
#
#   bash tests/lint.sh
#
# Exits 0 when the tree is clean. Used by CI's lint job and by hand before
# committing; it deliberately does not need docker.
#
# Runs anywhere bash exists (CI, the NAS, a laptop) with no dependencies
# beyond bash + node. Exits non-zero on the first category of failure so CI
# shows a clear red X; every failure is printed before exiting.
#
# Why each check exists:
#   * Line endings -- these files run inside a Linux container. A .sh or .js
#     that got CRLF on the way through a Windows checkout fails at exec time
#     with a cryptic "bad interpreter" or a silent syntax error. Cheap to
#     check, expensive to debug.
#   * Shell syntax -- a typo in deploy.sh or smoke.sh otherwise only shows up
#     during a real deployment.
#   * Node syntax -- catches half-applied edits in the shim before the image
#     build (which is minutes long) reaches them.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ERRLOG="$(mktemp "${TMPDIR:-/tmp}/lint.XXXXXX")" || exit 1
trap 'rm -f "$ERRLOG"' EXIT

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; FAILED=1; }
info() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Tracked-ish source files. .git is excluded; node_modules never reaches here.
listing() {
  if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    # In a checkout: ask git, so build artifacts and data/ never get scanned.
    git ls-files -z "$@" | tr '\0' '\n'
  else
    # Tarball / CI artifact without .git: walk the tree, skipping heavy dirs.
    find . -type f "$@" -not -path './.git/*' -not -path './node_modules/*' -not -path './data/*'
  fi
}

info 'Line endings (must be LF)'
crlf_bad=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # Only text formats we care about; binary blobs are skipped by name.
  case "$f" in
    *.sh|*.js|*.mjs|*.cjs|*.ts|*.json|*.yml|*.yaml|*.md) ;;
    *) continue ;;
  esac
  if LC_ALL=C grep -q $'\r' "$f" 2>/dev/null; then
    crlf_bad="$crlf_bad $f"
  fi
done <<EOF
$(listing)
EOF
if [ -n "$crlf_bad" ]; then
  for f in $crlf_bad; do fail "CRLF line endings: $f"; done
else
  pass 'all text files use LF'
fi

info 'Byte-order marks (must be none)'
# A BOM makes the shebang unreadable to the kernel ("#!/bin/sh" becomes
# "\xef\xbb\xbf#!/bin/sh"), so the container would fall back to sh with a
# confusing "bad interpreter" error.
bom_bad=""
for f in deploy.sh tests/smoke.sh tests/lint.sh shim/entrypoint.sh; do
  [ -f "$f" ] || continue
  if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    bom_bad="$bom_bad $f"
  fi
done
if [ -n "$bom_bad" ]; then
  for f in $bom_bad; do fail "UTF-8 BOM (breaks the shebang): $f"; done
else
  pass 'no BOM in scripts'
fi

info 'Shell syntax'
sh_total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.sh|deploy.sh) ;;
    *) continue ;;
  esac
  [ -f "$f" ] || continue
  sh_total=$((sh_total + 1))
  # Pick the parser from the shebang. tests/smoke.sh declares
  # #!/usr/bin/env bash and uses arrays and [[ ]], so sh -n on it is a
  # false positive. deploy.sh / shim/entrypoint.sh / tests/auth_probe.sh
  # declare #!/bin/sh and run under dash in the image (debian), so they
  # get checked by both bash -n and sh -n.
  shebang=$(head -n 1 "$f" 2>/dev/null || true)
  case "$shebang" in
    *bash*) want_sh=0 ;;
    *)      want_sh=1 ;;
  esac
  if bash -n "$f" 2>"$ERRLOG"; then
    pass "syntax (bash): $f"
  else
    fail "syntax (bash): $f"
    sed 's/^/        /' "$ERRLOG" >&2
  fi
  if [ "$want_sh" = 1 ]; then
    if sh -n "$f" 2>"$ERRLOG"; then
      pass "syntax (sh): $f"
    else
      fail "syntax (sh): $f"
      sed 's/^/        /' "$ERRLOG" >&2
    fi
  fi
done <<EOF
$(listing)
EOF
[ "$sh_total" -gt 0 ] || fail 'no shell scripts found -- listing is broken'

info 'Node syntax'
if ! command -v node; then
  fail 'node not found in PATH'
else
  js_total=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.js|*.mjs|*.cjs) ;;
      *) continue ;;
    esac
    [ -f "$f" ] || continue
    js_total=$((js_total + 1))
    if node --check "$f" 2>"$ERRLOG"; then
      pass "syntax: $f"
    else
      fail "syntax: $f"
      sed 's/^/        /' "$ERRLOG" >&2
    fi
  done <<EOF
$(listing)
EOF
  [ "$js_total" -gt 0 ] || fail 'no .js files found -- listing is broken'
fi

info 'Executable bit on entrypoints'
# git records the mode; a 644 deploy.sh on the NAS is a confusing failure.
for f in deploy.sh shim/entrypoint.sh tests/smoke.sh tests/lint.sh tests/auth_probe.sh; do
  [ -f "$f" ] || continue
  if [ -x "$f" ]; then
    pass "executable: $f"
  elif command -v git >/dev/null 2>&1 && [ -n "$(git ls-files -s -- "$f" 2>/dev/null)" ]; then
    mode="$(git ls-files -s -- "$f" | cut -d' ' -f1)"
    case "$mode" in
      100755) pass "executable (in git): $f" ;;
      100644) fail "not executable: $f (git mode 644)" ;;
      *) pass "executable bit not tracked: $f" ;;
    esac
  else
    # No .git here (tarball, CI artifact): the mode is unknown, not wrong --
    # the image sets it at build time, so this is informational only.
    printf '  \033[33mSKIP\033[0m  mode untracked (no git index): %s\n' "$f"
  fi
done

info 'Documented claims that go stale'
# tests/docs_claims.js turns the README's testable statements (script inventory,
# tuning defaults, routes, tuning table) into assertions against the code, so
# the documentation cannot drift silently. Needs only node, so it runs here.
if command -v node >/dev/null 2>&1 && [ -f tests/docs_claims.js ]; then
  if node tests/docs_claims.js 2>&1 | sed 's/^/        /'; then
    pass 'README matches the code (docs_claims.js)'
  else
    fail 'README is out of date with the code (see above)'
  fi
else
  printf '  \033[33mSKIP\033[0m  docs claim check needs node and tests/docs_claims.js\n'
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\n\033[31mlint failed\033[0m\n'
  exit 1
fi
printf '\n\033[32mlint OK\033[0m\n'
