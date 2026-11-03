#!/bin/sh
#
# Repo-wide static checks: line endings, shell syntax, node syntax.
#
#   ./tests/lint.sh         (or: bash tests/lint.sh)
#
# Exits 0 when the tree is clean. Used by CI's lint job and by hand before
# committing; it deliberately does not need docker.
#
# Runs under any POSIX sh (dash on Debian/Ubuntu, ash in alpine/busybox on a
# Synology, bash too) and needs node; nothing else. Every external command here
# is coreutils-or-shell, because a check that needs a tool the runner may not
# have is a check that silently disappears.
#
# Keep it that way: no arrays, no double-bracket tests, no here-strings, no
# dollar-quoted strings, no `set -o pipefail`. If it only parses under bash,
# it is not portable, and the check it guards will silently vanish on dash.
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

# -u 抓未定义变量；不开 pipefail：dash 没有这个选项，脚本要在 sh 下也能跑。
set -u

cd "$(dirname "$0")/.." || exit 1
ERRLOG="$(mktemp "${TMPDIR:-/tmp}/lint.XXXXXX")" || exit 1
trap 'rm -f "$ERRLOG"' EXIT

# grep 用 $'...' 只有 bash 认，dash 会去找反斜杠加 r 两个字符，所以把 CR
# 存在变量里（命令替换会吃掉末尾换行，不能直接 "$(printf '\r')"）。
CR=$(printf '\r')

FAILED=0
# 每一条检查的结果都打印：runner 拿不到 job log 时，完整过程照样能变成
# 人看得见的东西（CI 把 stdout 整段写进 job summary）。压成一行摘要曾经
# 让一个干净的树红了一整天，因为谁也不知道是哪条检查在报错。
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$*"; }
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
#
# 取前三个字节用 dd，不用 head/od/tr（GitHub 的 runner 不保证装了 od，
# 2026-11-03 的构建就是在这里以 "od: command not found" 挂掉的）；也不用
# `read -r -n 3`：`read` 遇到 NUL 就停，而 BOM 里必有 NUL，那样永远读不到
# BOM —— 这条检查曾经就是这样一直在空转。
bom_bad=""
for f in deploy.sh tests/smoke.sh tests/lint.sh shim/entrypoint.sh; do
  [ -f "$f" ] || continue
  bom="$(dd if="$f" bs=1 count=3 2>/dev/null || true)"
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
    *.sh) ;;
    *) continue ;;
  esac
  [ -f "$f" ] || continue
  sh_total=$((sh_total + 1))
  # 谁声明了什么，就用谁去判；不是无脑两个解释器都跑。
  # tests/smoke.sh 声明 bash 并用 bash 专有语法，对它跑 sh -n 必然报错——
  # 2026-11-03 之前这里就是无条件跑 sh -n，于是 Repo lint 只跑 1 秒就 exit 1，
  # 而目录树本身是干净的。反过来 deploy.sh / shim/entrypoint.sh / tests/auth_probe.sh
  # 声明 /bin/sh 并在镜像的 dash 下运行，sh -n 才是对它们有意义的检查。
  shebang=$(sed -n '1s/^#!//p' "$f" 2>/dev/null || true)
  if bash -n "$f" 2>"$ERRLOG"; then
    pass "syntax (bash): $f"
  else
    fail "syntax (bash): $f"
    sed 's/^/        /' "$ERRLOG" >&2
  fi
  case "$shebang" in
    *bash*)
      # 声明 bash 的脚本不适用 sh -n：tests/smoke.sh 用了数组和 <<<，在 dash
      # 里必然报语法错误，而它在 bash 下完全正确（bash -n 上面已经过了）。
      skip "syntax (sh): $f -- n/a, the script declares bash"
      ;;
    *)
      if sh -n "$f" 2>"$ERRLOG"; then
        pass "syntax (sh): $f"
      else
        fail "syntax (sh): $f"
        sed 's/^/        /' "$ERRLOG" >&2
      fi
      ;;
  esac
done <<EOF
$(listing)
EOF
[ "$sh_total" -gt 0 ] || fail 'no shell scripts found -- listing is broken'

info 'Node syntax'
# 缺 node 必须明确 FAIL：`if ! command -v node` 的写法能跑，但状态一错
# 就变成"整段检查不存在"。正向判断 + else 里 fail，没有 node 时一定红。
# 先枚举文件再进循环：循环体里不能再写 <<<（dash 解析不了）。
JS_FILES=""
for f in $(listing); do
  case "$f" in
    *.js|*.mjs|*.cjs) [ -f "$f" ] && JS_FILES="$JS_FILES
$f" ;;
  esac
done
# 枚举结果存进 JS_FILES 再喂给 while：<<< 是 bash 专有，dash 连解析都不做。
if command -v node >/dev/null 2>&1; then
  js_total=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    js_total=$((js_total + 1))
    if node --check "$f" 2>"$ERRLOG"; then
      pass "syntax: $f"
    else
      fail "syntax: $f"
      sed 's/^/        /' "$ERRLOG" >&2
    fi
  done <<EOF
$JS_FILES
EOF
  [ "$js_total" -gt 0 ] || fail 'no .js files found -- listing is broken'
else
  fail 'node not found in PATH'
fi

info 'Executable bit on entrypoints'
# 检查两件事，缺一不可：文件在磁盘上可执行，且 git 记的 mode 也是 755。
# 反过来的顺序曾经害过人：先看 [ -x ]，于是 Windows 工作区（core.fileMode
# 为 false、磁盘上一律 755）永远通过，100644 那条分支根本走不到——而
# Linux 上 checkout 出来的正是 644，镜像里 exec 直接 126/127。
# 不看 git 索引时（tarball、CI artifact），只要求磁盘上可执行。
for f in deploy.sh shim/entrypoint.sh tests/smoke.sh tests/lint.sh tests/auth_probe.sh; do
  [ -f "$f" ] || continue
  if command -v git >/dev/null 2>&1 && [ -n "$(git ls-files -s -- "$f" 2>/dev/null)" ]; then
    mode="$(git ls-files -s -- "$f" | cut -d' ' -f1)"
    case "$mode" in
      100755) pass "executable (git mode 755): $f" ;;
      100644) fail "not executable: $f (git mode 644 -- chmod +x and commit)" ;;
      *) pass "executable bit not tracked: $f" ;;
    esac
  elif [ -x "$f" ]; then
    pass "executable (no git index): $f"
  else
    # 走到这里说明两件事：文件不可执行，而且没有 git 索引能说明它本该是
    # 什么 mode。镜像构建时会给入口设权限，所以这未必是错，但"无从得知"
    # 不能显示成"检查通过"——那正是前面几处空转的共同形状。
    fail "not executable: $f (no git index to vouch for it)"
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
  skip 'docs claim check needs node and tests/docs_claims.js'
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\n\033[31mlint failed\033[0m\n'
  exit 1
fi
printf '\n\033[32mlint OK\033[0m\n'
