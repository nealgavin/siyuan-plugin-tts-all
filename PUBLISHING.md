# 上架思源集市 · 操作手册

> 本手册对应 **路线 B（作为独立新集市包上架）**。
> 仓库：`nealgavin/siyuan-plugin-tts-all` ｜ 包名：`siyuan-plugin-tts-all` ｜ 版本：`1.2.6`

---

## 当前进度（已核实）

| 步骤 | 状态 |
| --- | --- |
| 第 1 步：推送仓库 + 打 tag | ✅ 已完成（tag `v1.2.4` → `be961da`） |
| 第 1 步（v1.2.5）：重试 / 继续读 / 人声锁定 | ✅ 已推送（tag `v1.2.5` → `40785ba`，Release 已生成） |
| 第 1 步（v1.2.6）：取消继续按键，默认逐块续读 | ⏳ 本地已完成，待推送 tag `v1.2.6` |
| GitHub Actions 打包 | ✅ 已成功（run 36537545088） |
| 创建 Release | ✅ 已发布，资产 `package.zip` 93,632 字节 |
| 第 2 步：向集市提 PR | ⬜ **未完成 —— 这是「集市里看不到」的唯一原因** |
| 集市收录 | ⬜ 待 PR 合并 |

**关键结论**：推送成功 ≠ 集市可见。集市是一份人工维护的白名单
（`siyuan-note/bazaar` 仓库的 `plugins.txt`），必须提 PR 被合并后才会收录。
我核实过官方索引 `stage/plugins.json`：共 **529** 个插件，其中只有旧的
`siyuan-plugin-tts` v1.1.1，**没有** `siyuan-plugin-tts-all`。

---

## 为什么不是「更换维护者」

我核对了集市仓库 `siyuan-note/bazaar` 的校验源码（`rules/diff.go`），原文是：

> 更换维护者：**同 GitHub 仓库名**、不同 owner，且旧 owner/repo 已从列表删除。

你的新仓库叫 `siyuan-plugin-tts-all`，与已上架的 `zuoez02/siyuan-plugin-tts` **仓库名不同**，
所以不构成维护者转移，只能作为**新包**上架。同时集市规定已上架包的 `name` 不可更改
（`rules/manifest.go`：「已上架集市包的 `name` 不可更改」）。

**后果**：集市里会同时存在两个「文本朗读」条目——旧版停在 1.1.1（作者 zuoez02），
新版是本包。为此我已把新版显示名改为「**文本朗读（全平台）**」，便于用户区分。

---

## 第 1 步：推送仓库并打 tag ✅ 已完成

> 本节保留备查（下次发版还要用）。首次已于 2026-09-29 完成。

需要本机具备 GitHub 推送凭据（HTTPS 用户名 + Personal Access Token，或 SSH）。
`release.sh` 现在会在推送前做 `--dry-run` 预检，凭证不可用时立即退出并打印配置步骤，
不会留下「本地有 tag、远端没有」的孤儿状态。

```bash
cd /Users/nealgavin/Documents/siyuan/siyuan-plugin-tts
./release.sh
```

脚本会依次：校验清单 → 校验图标体积 → 校验 JS 语法 → 提交 → 打 tag `v1.2.5` → 推送。

推送时会要求输入 GitHub **用户名**和 **Personal Access Token**（不是密码）。
Token 需勾选 `repo` 权限，在 https://github.com/settings/tokens 生成。

推送成功后 GitHub Actions 会自动打包 `package.zip` 并创建 Release，约 1 分钟。

**验证 Release 已就绪**（必须能看到 `package.zip` 资产）：

```bash
curl -s https://api.github.com/repos/nealgavin/siyuan-plugin-tts-all/releases/latest \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['tag_name'],[a['name'] for a in d['assets']])"
```

---

## 第 2 步：向集市提 PR

1. Fork **https://github.com/siyuan-note/bazaar**（若已 fork，先同步 main）

2. 在仓库根目录的 `plugins.txt` **末尾追加一行**：

   ```
   nealgavin/siyuan-plugin-tts-all
   ```

   已按官方最新 `plugins.txt`（529 行）改好并严格校验：恰好新增 1 行、无删除、无重复。
   文件在 `/tmp/pr-ready/plugins.txt`，可直接使用（`.orig` 是原始备份）。

   diff 内容仅为：

   ```diff
   @@ -527,3 +527,4 @@
    famotime/siyuan-time-spent
    wmy2981/editor-siyuan
    HaoCeans/siyuan-mood
   +nealgavin/siyuan-plugin-tts-all
   ```

   > 注意：不要动第 48 行的 `zuoez02/siyuan-plugin-tts`。集市规定一个 PR
   > 只能做一件事（只新增 1 个包 / 只换维护者 / 只下架），混入删除会被判不合格。

3. 提 PR 到 `main` 分支。标题建议：

   ```
   Add plugin: nealgavin/siyuan-plugin-tts-all
   ```

   PR 正文已写好，可直接粘贴：`/tmp/pr-ready/PR_BODY.md`
   （含 PR 模板要求的 2 项侵权/开源确认、Release 自检项、与旧包的区别说明）。

4. 等待 **PR Check** 自动校验通过，维护者合并。

5. **合并后的可见时间**：集市索引每 1~3 小时刷新一次（可看
   [Stage workflow](https://github.com/siyuan-note/bazaar/actions/workflows/stage.yml)）。
   索引更新后，在思源里 **重启一次**（或「设置 → 集市」手动刷新）即可看到，
   因为客户端会缓存集市索引。

---

## 合并后如何在思源里看到

1. 等索引刷新（或到 Stage workflow 页面确认已部署）
2. **完全退出并重启思源** —— 集市索引有本地缓存，不重启可能刷不出来
3. 打开「设置 → 集市 → 插件」，搜索 **朗读** 或向下浏览
4. 应能看到「**文本朗读（全平台）**」——注意与旧的「文本朗读」（作者 zuoez02，
   停在 v1.1.1）区分：新包的名字带「（全平台）」
5. 点「下载」，装好后到「设置 → 集市 → 已下载」里启用

> 若只想立刻在本机用上，**不必等集市**：把
> `/Users/nealgavin/Documents/siyuan/siyuan-plugin-tts` 整个目录拷到
> `<工作空间>/data/plugins/siyuan-plugin-tts-all/` 后重启思源即可（本地已装好 v1.2.6）。

---

## 已为你完成的校验

我按集市 `rules/*.go` 的规则做了完整模拟校验，**29 项全部通过**：

| 检查项 | 结果 |
| --- | --- |
| 必需文件 `README.md` / `index.js` / `plugin.json` | ✅ |
| 清单字段全在允许白名单内 | ✅ |
| `name` 仅可打印 ASCII、无保留字符、≤64 字节 | ✅ |
| `url` 严格等于 `https://github.com/nealgavin/siyuan-plugin-tts-all` | ✅ |
| `version` 为合法 semver（无 `v` 前缀） | ✅ |
| `readme` 含 `default` 键且文件存在 | ✅ |
| `icon.png` 26.3KB ≤ 64KB | ✅ |
| `preview.png` 26.3KB ≤ 512KB | ✅ |
| `backends` / `frontends` 类型正确、未与 `all` 混用 | ✅ |
| `package.zip` 路径全用正斜杠、包根结构正确 | ✅ |

### 已修正的问题

1. **`backends` 里的 `"browser"` 不是合法值** —— 集市/内核文档规定的后端只有
   `windows`/`linux`/`darwin`/`docker`/`android`/`ios`/`harmony`/`all`。「浏览器」是**前端**概念，
   已由 `frontends` 里的 `browser-desktop`/`browser-mobile` 覆盖，故删除该项。

2. **`icon.jpeg` → `icon.png`** —— 原图 350×286 是**横版**，而集市图标按正方形展示，
   直接拉伸会变形。我按原图白底补成 350×350 正方形后再缩到 256×256，输出 PNG8
   为 **26.3KB**（原 icon.png 是 39KB，且是旧图）。`icon.jpeg` 已删除。

3. **`preview.png` 按需求设为 `icon.png` 的副本** —— 两者字节相同
   （md5 `f84ad7b9…`，256×256）。集市不校验预览图尺寸，仅要求 ≤512KB，
   因此可以上架；但集市详情页的预览图会以 256×256 展示，观感偏小
   （官方示例建议 1024×768）。如需更大预览，后续替换 `preview.png` 即可。

4. **`plugin.json` 改名以区分** —— `displayName` 改为「文本朗读（全平台）」/
   "Text To Speech (All Platforms)"，并补上 `icon`、`preview`、`keywords` 字段。

5. **LICENSE 补充署名** —— MIT 要求保留原始版权声明。保留了
   `Copyright (c) 2023-present zuoez02 and contributors`，并追加你自己的行。

6. **README 增加来源致谢与安装说明**；新增 `.gitignore`（忽略 `.DS_Store`
   与 CI 生成的 `package.zip`）。

---

## 注意事项

- **两个插件可共存**：包名不同（`siyuan-plugin-tts-all` vs `siyuan-plugin-tts`），
  可同时安装。确认新版正常后再卸载旧版；朗读设置需重新选一次声源。
- **后续更新无需再提 PR**：以后只要 `./release.sh` 推新 tag，集市自动跟随。
  注意 `BASE_VERSION` 基线（当前 `1.2.3`），版本号只能升不能降。
- **`.gitignore` 已加**：`package.zip` 由 CI 生成，不入库；`release.sh` 需要入库
  （CI 不依赖它，但保留便于你一键发布）。
- **不要重复提 PR**：PR Check 失败时只需修好包仓库（重发 Release），
  约 20 分钟内会有定时任务自动重检并更新评论，不要另开新 PR。

## 环境限制（如实说明）

- 生成本文档的环境**没有** Git 推送凭据（钥匙串、环境变量、SSH 均取不到），
  因此第 1、2 步需在具备凭据的环境执行。
- 生成本文档的环境**无法读取图片内容**（模型 `deepseek-v4-flash-vision-exp`
  不支持图像输入），图标处理是按尺寸/像素/体积用 ImageMagick 定量完成的，
  **最终视觉效果建议打开 `icon.png` 确认**。
- 功能验证基于思源内核 API 实测 + 沙箱模拟，**未在鸿蒙真机上验证**。
- 集市规则校验是**本地按 `rules/*.go` 重写**的模拟（29 项），**不等于官方 CI**。
  本想直接运行官方校验器，但本机 Go 为 1.13.6，而集市 `go.mod` 要求 Go 1.26.5，
  无法编译；最终以 **PR Check 的结果为准**。
- 核实时 GitHub API 曾触发速率限制，故部分结论改用 `raw.githubusercontent.com` 直取。
