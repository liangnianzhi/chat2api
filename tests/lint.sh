#!/usr/bin/env bash
#
# Repo-wide static checks: line endings, shell syntax, node syntax.
#
#   ./tests/lint.sh         (or: bash tests/lint.sh)
#
# Exits 0 when the tree is clean. Used by CI's lint job and by hand before
# committing; it deliberately does not need docker.
#
# Needs bash and node, and nothing else. That sentence used to be a quiet lie:
# the BOM check piped through od, which a GitHub runner does not install, and
# the whole lint step died on that line before it could report anything. Every
# external command here is now coreutils-or-shell, and the script is written in
# plain sh where it costs nothing, so dash can run it too.
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

# grep 用 $'...' 只有 bash 认，dash 会去找反斜杠加 r 两个字符，所以把 CR
# 存在变量里（命令替换会吃掉末尾换行，不能直接 "$(printf '\r')"）。
CR=$(printf '\r')

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; FAILED=1; }
info() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Tracked-ish source files. .git is excluded; node_modules never reaches here.
listing() {
  if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    # In a checkout: ask git, so build artifacts and data/ never get scanned.
    git ls-files "$@"
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
  if LC_ALL=C grep -q "$CR" "$f" 2>/dev/null; then
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
  # 用 shell 内建读前三个字节，不依赖 head/od/tr：GitHub 的 runner 不保证
  # 装了 od（coreutils 里它是可选项），2026-11-03 的 main 构建就是在这里
  # 以 "line 74: od: command not found" 挂掉的。
  bom=""
  IFS= read -r -n 3 bom < "$f" || true
  # 不用 $'...'：dash 会把它当成反斜杠加字母。直接拿 printf 造出的三个字节比。
  if [ "$bom" = "$(printf '\357\273\277')" ]; then
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
  # 两个解释器都查。tests/smoke.sh 声明 `#!/usr/bin/env bash` 且用了数组，
  # 但它也是唯一在 CI 里真正被当作 bash 跑的脚本，所以 bash -n 才是它的关键；
  # deploy.sh / shim/entrypoint.sh / tests/auth_probe.sh 声明 `#!/bin/sh`，
  # 在镜像（debian）里跑在 dash 下，sh -n 是关键。两者都做，谁坏了都看得见。
  if bash -n "$f" 2>"$ERRLOG"; then
    pass "syntax (bash): $f"
  else
    fail "syntax (bash): $f"
    sed 's/^/        /' "$ERRLOG" >&2
  fi
  if sh -n "$f" 2>"$ERRLOG"; then
    pass "syntax (sh): $f"
  else
    fail "syntax (sh): $f"
    sed 's/^/        /' "$ERRLOG" >&2
  fi
done <<EOF
$(listing)
EOF
[ "$sh_total" -gt 0 ] || fail 'no shell scripts found -- listing is broken'

info 'Node syntax'
# 不要写 "if ! command -v node"：找不到命令时 command -v 返回非零，
# "if !" 本身在 POSIX sh 里是没问题的，但这一行曾经在 CI 上让整段检查
# 被跳过（缺少 node 时既不报错也不检查）。这里用正向判断，找不到就明确失败。
if command -v node >/dev/null 2>&1; then
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
else
  fail 'node not found in PATH'
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
