#!/usr/bin/env bash
#
# 一键发布脚本（路线 B：作为独立新集市包发布）
#
# 用法：
#   ./release.sh              # 使用 plugin.json 中的版本号
#   ./release.sh 1.2.7        # 指定版本号并自动写入 plugin.json
#
# 说明：本仓库是独立上架的集市插件（非 zuoez02 的维护者转移）。
#       每次推 tag 后 GitHub Actions 会自动打包 package.zip 并创建 Release，
#       集市会在 1~3 小时内自动跟随更新。
#
# 前置条件：本机需能推送到 GitHub。
#   ⚠ GitHub 已不支持用「账号密码」做 Git 认证，Password 处必须填
#     Personal Access Token（PAT），不是你的 GitHub 登录密码。
#   凭证配置失败时脚本会打印详细步骤。
#
set -euo pipefail

cd "$(dirname "$0")"

REPO="nealgavin/siyuan-plugin-tts-all"
BRANCH="main"

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "▶ $*"; }

# 凭证配置指引：推送失败时打印，避免只给一句「失败了」而无从下手
cred_help() {
  local remote
  remote="$(git remote get-url origin 2>/dev/null || echo '(未设置)')"
  cat <<'EOF'

────────────────────────────────────────────────────────────
如何配置 GitHub 推送凭证（任选其一）
────────────────────────────────────────────────────────────

【方式 A】Personal Access Token（推荐，最省事）
  1. 打开 https://github.com/settings/tokens
     选 "Generate new token (classic)"
  2. 勾选 repo 权限，生成后复制 token（只显示一次，关掉就看不到）
  3. 重新运行 ./release.sh，提示时输入：
        Username: nealgavin
        Password: <粘贴刚才的 token>   ← 不是 GitHub 登录密码
  4. token 会存入 macOS 钥匙串，之后不再需要重复输入

  若钥匙串没记住，可改用一次性内嵌方式（注意会留在 shell 历史里）：
        git remote set-url origin https://<token>@github.com/nealgavin/siyuan-plugin-tts-all.git

【方式 B】SSH
  你本机已有 ~/.ssh/id_ed25519，但尚未添加到 GitHub：
  1. 复制公钥：  pbcopy < ~/.ssh/id_ed25519.pub
  2. 打开 https://github.com/settings/keys → New SSH key → 粘贴保存
  3. 切换 remote 为 SSH：
        git remote set-url origin git@github.com:nealgavin/siyuan-plugin-tts-all.git
  4. 验证：      ssh -T git@github.com

EOF
  echo "【当前 remote】"
  echo "  $remote"
  echo
}

command -v node >/dev/null || die "未找到 node，请先安装"
command -v git  >/dev/null || die "未找到 git"

# ── 1. 确定版本号 ────────────────────────────────────────────────
CUR_VERSION=$(node -p "require('./plugin.json').version")
VERSION="${1:-$CUR_VERSION}"

if [ -n "${1:-}" ] && [ "$1" != "$CUR_VERSION" ]; then
  info "写入新版本号：$CUR_VERSION → $VERSION"
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("plugin.json", "utf8"));
    m.version = process.argv[1];
    fs.writeFileSync("plugin.json", JSON.stringify(m, null, 4) + "\n");
  ' "$VERSION"
fi

CUR_VERSION=$(node -p "require('./plugin.json').version")
TAG="v$CUR_VERSION"
info "发布版本：$TAG"

# ── 2. 合法性校验 ────────────────────────────────────────────────
info "校验 plugin.json"
node -e '
  const m = require("./plugin.json");
  const allowed = new Set(["name","author","url","version","displayName","description",
    "readme","icon","preview","funding","keywords","minAppVersion",
    "backends","frontends","kernels","bootAppearances","disabledInPublish","publish"]);
  const bad = Object.keys(m).filter(k => !allowed.has(k));
  if (bad.length) { console.error("  ❌ 含集市不允许的字段: " + bad.join(", ")); process.exit(1); }
  for (const req of ["name","author","url","version","readme"]) {
    if (!m[req]) { console.error("  ❌ 缺少必填字段: " + req); process.exit(1); }
  }
  console.log("  ✓ 字段合法");
' || die "plugin.json 校验失败"

info "校验图标体积（集市上限：icon 64KB / preview 512KB）"
node -e '
  const fs = require("fs");
  const lim = { "icon.png": 64*1024, "preview.png": 512*1024 };
  let bad = false;
  for (const [f, max] of Object.entries(lim)) {
    if (!fs.existsSync(f)) { console.log(`  · ${f} 不存在，跳过`); continue; }
    const s = fs.statSync(f).size;
    const ok = s <= max;
    console.log(`  ${ok ? "✓" : "❌"} ${f}: ${(s/1024).toFixed(1)}KB / ${(max/1024).toFixed(0)}KB`);
    if (!ok) bad = true;
  }
  // 说明：本项目有意让 preview.png 与 icon.png 内容一致（预览图即图标），
  // 因此这里不做「两者不同」的断言；仅保留体积上限检查。
  process.exit(bad ? 1 : 0);
' || die "图片校验未通过"

info "校验 JS 语法"
node --check index.js && echo "  ✓ index.js 语法正确"

# ── 3. 版本必须高于最近一次发布 ──────────────────────────────────
# 本包以独立集市条目上架（route B），基线为首次上架版本 1.2.3。
# 后续发布若已上架新版本，可通过 BASE_VERSION 环境变量抬高基线。
info "版本比较（基线 ${BASE_VERSION:-1.2.3}）"
node -e '
  const cmp = (a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
    return 0;
  };
  const base = process.env.BASE_VERSION || "1.2.3";
  const v = require("./plugin.json").version;
  if (cmp(v, base) < 0) { console.error(`  ❌ ${v} 低于基线版本 ${base}`); process.exit(1); }
  console.log(`  ✓ ${v} >= ${base}`);
' || die "版本号未提升"

# ── 4. 提交并打 tag ──────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  info "提交改动"
  git add -A
  git commit -m "chore: 发布 $TAG"
else
  info "工作区干净，无需提交"
fi

# ── 4.5 推送前先校验凭证 ─────────────────────────────────────────
# 提前用 --dry-run 完成一次认证握手：凭证不可用时立即失败，
# 不会留下「本地已打 tag 但远端没有」的孤儿状态。
info "校验 GitHub 推送凭证"
if ! git push --dry-run origin "$BRANCH" >/dev/null 2>&1; then
  echo "❌ 推送凭证校验未通过（GitHub 不支持用账号密码推送）" >&2
  cred_help
  exit 1
fi
echo "  ✓ 凭证可用"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  # 本地已有该 tag：可能是上轮推送失败留下的孤儿。
  # 远端也有 → 说明已发布过，直接复用；远端没有 → 删掉重建（内容以当前代码为准）
  if git ls-remote --tags origin "$TAG" 2>/dev/null | grep -q .; then
    info "tag $TAG 已存在于远端，跳过创建"
  else
    info "本地已存在 tag $TAG 但远端没有，重建为当前代码"
    git tag -d "$TAG" >/dev/null
    git tag "$TAG"
  fi
else
  info "创建 tag $TAG"
  git tag "$TAG"
fi

# ── 5. 推送 ──────────────────────────────────────────────────────
echo
info "推送到 $REPO"
if ! git push origin "$BRANCH"; then
  git tag -d "$TAG" >/dev/null 2>&1 || true
  echo "❌ 推送分支失败（本地 tag $TAG 已回滚，可安全重跑）" >&2
  cred_help
  exit 1
fi
if ! git push origin "$TAG"; then
  die "推送 tag 失败：分支已推送成功，只需修复凭证后执行  git push origin $TAG"
fi

# ── 6. 完成 ──────────────────────────────────────────────────────
cat <<EOF

✅ 已推送 $TAG

GitHub Actions 正在自动打包并创建 Release：
  https://github.com/$REPO/actions

Release 生成后（约 1 分钟）可在该地址查看：
  https://github.com/$REPO/releases

上架状态（route B：作为独立新集市包上架）：
  本插件在集市中是独立条目，与 zuoez02/siyuan-plugin-tts 并存
  （后者停在 1.1.1，两者可同时安装）。上架后集市会自动跟随
  本仓库的 Release 更新，无需再次提 PR。

首次上架步骤：
  1. fork siyuan-note/bazaar，在 plugins.txt 末尾追加一行：
       $REPO
  2. 向 main 分支提 PR，等待 PR Check 通过并合并
  3. 之后每次发布只需推 tag，集市会在 1~3 小时内自动更新

EOF
