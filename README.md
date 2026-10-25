# vscode-hypersnips

vscode-hypersnips 是一个面向 VS Code 的 LaTeX 数学公式 snippet 扩展。项目基于 HyperSnips，保留了类似 UltiSnips 的可编程 snippet 语法，并针对 Markdown / LaTeX 写作增加了数学环境识别和 `${VISUAL}` 选中文本替换能力。

仓库地址：<https://github.com/pasiooooo/vscode-hypersnips>

当前维护者：`pasiooooo`。扩展 ID：`pasiooooo.vscode-hypersnips`。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。GitHub Release 正文会直接展示对应版本的完整更新说明。

> 安装本 fork 前，请先禁用或卸载此前安装的旧版扩展及原版 HyperSnips，避免重复处理按键和 snippet。改名后仍兼容 `hsnips.*` 命令、设置与已有 `.hsnips` 文件，无需迁移 snippet 目录。

## 功能特性

- 使用 `.hsnips` 文件管理 snippet。
- 支持普通触发词、正则触发词、Tabstop、优先级和 JavaScript 插值。
- 支持 `A` 自动展开 flag。
- 支持 `m` 数学环境限定 flag。
- 能识别 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、`equation`、`align`、`gather` 等数学环境。
- 使用统一 LaTeX context engine，在注释、Markdown code、`verbatim` / `minted` / `lstlisting`、`\text{}`、`\label{}` 等位置避免误触发。
- 在 `align`、矩阵、`cases`、`array`、`tabular` 等环境中按 Enter，可自动给当前行补 `\\` 后换行。
- 在 `align`、矩阵、`cases`、`array`、`tabular` 等环境中按 Tab，可优先插入列分隔符 ` & `。
- 支持当前位置转换 LaTeX 环境，例如 `align` ↔ `aligned`、`\[...\]` → `equation*`、`tabular` → `tabularx`。
- 直接编辑 `\begin{...}` 或 `\end{...}` 名称时，会自动同步另一端环境名。
- 支持快速包裹/解包常见数学结构。
- 提供 Monaco snippet 管理器，可搜索、诊断、预览并编辑完整 `.hsnips` 源码。
- 支持 snippet profiles，可在基础 snippets 之上切换不同写作场景的 snippet 集合。
- 支持 `${VISUAL}`，可把最近选中的文本带入 snippet。
- 为 `.hsnips` 文件提供语法高亮。

## 快速开始

1. 在命令面板运行 `vscode-hypersnips: Open Snippets Directory`。
2. 在打开的目录中新建目标语言对应的 snippet 文件，例如：
   - `markdown.hsnips`：用于 Markdown。
   - `latex.hsnips`：用于 LaTeX。
   - `all.hsnips`：用于所有语言。
3. 写入 snippet 并保存。保存 `.hsnips` 文件后，扩展会自动重新加载 snippets。

Markdown 默认可能不会弹出补全提示。建议在 VS Code 的 `settings.json` 中加入：

```json
"[markdown]": {
  "editor.quickSuggestions": true
}
```

## Snippet 目录

默认 snippet 目录如下：

- Windows：`%APPDATA%\Code\User\hsnips\(language).hsnips`
- macOS：`$HOME/Library/Application Support/Code/User/hsnips/(language).hsnips`
- Linux：`$HOME/.config/Code/User/hsnips/(language).hsnips`

也可以通过 `hsnips.windows`、`hsnips.mac`、`hsnips.linux` 配置项自定义路径。

## Snippet Profiles

默认情况下，扩展加载 snippet 根目录下的 `*.hsnips` 文件。你也可以在根目录下建立 profile：

```text
hsnips/
  latex.hsnips
  all.hsnips
  profiles/
    notes/
      latex.hsnips
      all.hsnips
    paper/
      latex.hsnips
```

运行 `vscode-hypersnips: Select Snippet Profile` 可以切换当前 profile。加载顺序是 base snippets 加 active profile snippets；同语言 snippets 合并后继续按 priority 排序。`hsnips.profiles.activeProfile` 为空时只加载 base。

## Context 配置

扩展内置了常见 LaTeX 数学、分行、分列和文本命令判断。若你有自定义环境，可以在 `settings.json` 里追加：

```json
{
  "hsnips.context.extraMathEnvironments": ["myproofmath"],
  "hsnips.context.extraRowBreakEnvironments": ["myalign"],
  "hsnips.context.extraAlignmentEnvironments": ["myarray"],
  "hsnips.context.extraTextLikeCommands": ["mytext"]
}
```

这些配置会同时影响 `m` 数学 snippet、智能 Enter、智能 Tab 和相关 context key。

## 基本语法

一个 `.hsnips` 文件可以包含 `global` JavaScript 代码块和多个 `snippet` 代码块：

```hsnips
global
// 当前文件内所有 snippet 可共享的 JavaScript 代码
endglobal

snippet trigger "description" flags
body
endsnippet
```

`trigger` 可以是普通字符串，也可以是用反引号包裹的正则表达式。正则触发词如果没有以 `$` 结尾，解析时会自动补上行尾匹配。

```hsnips
snippet RR "Real numbers" iAm
\mathbb{R}
endsnippet
```

在数学环境中输入 `RR`，会自动展开为 `\mathbb{R}`。

## Flags

`flags` 写在 snippet 描述后面，用来控制触发行为：

- `A`：自动展开，触发词匹配后立即展开。
- `i`：允许在单词内部展开。
- `w`：按 word boundary 匹配。
- `b`：只在行首展开。
- `M`：启用多行正则匹配。
- `m`：只在数学环境中展开。
- `t`：只在非数学环境中展开，适合 `align`、`dm` 这类会创建 display math 的 snippet。

其中 `i`、`w`、`b` 主要用于普通字符串触发词；正则 snippet 常用 `A`、`M`、`m`。

## JavaScript 插值

snippet body 中可以用两个反引号包裹 JavaScript 代码。代码会在展开时执行，也会在相关 tabstop 内容变化时重新计算。

```hsnips
snippet dategreeting "Current date"
Today is ``rv = new Date().toDateString()``.
endsnippet
```

插值代码中可使用的变量：

- `rv`：返回值，会替换当前插值位置。
- `t`：tabstop 内容数组。
- `m`：正则触发词的匹配结果数组。
- `w`：当前 workspace URI。
- `path`：当前文档 URI。

同一个 snippet 内，前一个插值块中定义的变量可以被后续插值块继续使用。代码块中也可以使用 Node.js 的 `require`。

## 正则展开示例

```hsnips
snippet `((\d+)|(\d*)(\\)?([A-Za-z]+)((\^|_)(\{\d+\}|\d))*)/` "Fraction" Am
\frac{``rv = m[1]``}{$1}$0
endsnippet
```

在数学环境中输入 `1/`，会展开为：

```tex
\frac{1}{}
```

这里的 `A` 表示自动展开，`m` 表示只在数学环境中生效。

## 多行公式辅助

在 `align`、`align*`、`aligned`、`gather`、矩阵、`cases`、`array`、`tabular` 等多行/分列环境中，按 Enter 会自动处理换行：

```tex
\begin{align}
a &= b
% 按 Enter 后变为：
a &= b \\

\end{align}
```

以下情况只执行普通换行，不会重复补 `\\`：

- 当前行为空。
- 当前行只有 `\begin{...}` 或 `\end{...}`。
- 当前行已经以 `\\` 结尾且无需补齐列。
- 光标右侧还有非空内容。

在矩阵类环境中，按 Tab 会插入 ` & `，用于快速切换到下一列：

```tex
\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}
```

当前支持 Tab 插入 ` & ` 的环境包括 `align`、`align*`、`aligned`、`alignedat`、`matrix`、`pmatrix`、`bmatrix`、`Bmatrix`、`vmatrix`、`Vmatrix`、`smallmatrix`、`cases`、`array`、`tabular`、`tabular*`、`tabularx`、`longtable`。

在这些环境中，Tab 会优先插入 ` & `，不会被 snippet placeholder 跳转抢走；这对矩阵 snippet 展开后光标停在空单元格行的情况也生效。如果当前行不适合插入 ` & `，例如 `\begin{...}` / `\end{...}` 行、已经以 `\\` 结尾的行、注释中或 Markdown 代码块中，则退回默认 Tab/snippet 行为。

这些环境（包括 `hsnips.context.extraAlignmentEnvironments` 添加的环境）还支持源码自动对齐：输入、删除、粘贴或智能 Tab／Enter 后，停顿约 150 ms，会调整当前环境中各行 `&`、行尾 `\\` 和行尾注释 `%` 前的空格。数学环境和表格中的行内公式还会对齐同一列中运算符结构相同的 `+`、`-`、`=`；表格环境保留普通文本中的连字符和等号。例如：

```tex
\begin{tabular}{llll}
  示例机构甲 & 测试人员甲    & 示例城    & DEMO \\ % 第一行
  Demo Lab   & Sample Person & Demo City &      \\ % 第二行
\end{tabular}
```

Windows 本地扩展会自动读取当前文件生效的字体、字号、字重和字间距，使用系统字体测量字符宽度并缓存，换字体后重新测量。首次测量可能稍慢，无需手动填写字体；所有测量都在本机完成。非等宽字体只能用整数个空格逼近目标位置，可能有不到一个空格的误差。其他系统、远程扩展宿主或系统测量不可用时，回退为 Unicode 列宽（中文及全角字符两列）。Tab 按编辑器的 Tab 宽度计算。

自动对齐默认开启。可在设置中关闭 **Hsnips: Auto Align: Enabled**，或在用户、工作区及语言专属设置中配置：

```json
"hsnips.autoAlign.enabled": false
```

设置立即生效，并取消尚未执行的对齐；智能 Tab 插入 ` & ` 和智能 Enter 仍可使用。

空格对齐只修改分隔处的空格，保留缩进、单元格内容和注释文字；`\&`、`\%`、花括号参数内的符号及一元正负号不参与对齐。独立注释行、代码块、verbatim 内容和包含嵌套环境边界的行保持原样，内层环境单独对齐。空格对齐需要有匹配的 `\begin`／`\end`，且数据行独占源码行。自动对齐与触发它的编辑合并撤销，撤销／重做本身不触发对齐。

自动对齐开启时，单光标在数据行末按 Enter 还会补齐当前行缺少的 `&`。优先参照同一环境中其他有效数据行的最大列数，当前行列数更多时也会提高目标；没有可用的多列参考行时，才使用表格声明的列数。例如在下面的 `D` 后按 Enter：

```tex
\begin{tabular}{lc}
  A & B & C \\
  D
\end{tabular}
```

会补齐为空单元格，并将两列声明扩展成三列；新增列默认左对齐 `l`：

```tex
\begin{tabular}{lcl}
  A & B & C \\
  D & & \\

\end{tabular}
```

已有 `l/c/r` 等列样式保留，列格式只扩展、不缩减；例如 `|lc|` 扩展为 `|lcl|`。支持 `p/m/b{宽度}`、`X`、静态 `*{数量}{格式}` 及常见列修饰。`\multicolumn{数量}{格式}{内容}` 按占用列数计算，转义 `\&`、注释、花括号内容和嵌套环境中的分隔符不计入外层行。

已有行尾 `\\`、`\\*`、`\\[间距]` 的缺列行也能补齐，尾注释留在原行，光标进入新行；补列、列格式扩展和换行可一起撤销。不会删除已有的多余分隔符，也不会批量改写其他行。未知自定义列类型、动态列数或无法可靠解析的结构会跳过补列和声明修改。关闭 `hsnips.autoAlign.enabled` 会同时关闭这两项新增行为。

如果修改或本地编译后按键行为没有变化，先执行 `npm run compile`，然后在 VS Code / Cursor 中运行 `Developer: Reload Window`。按键绑定和 `out/` 编译产物都需要重新加载后才会被当前扩展实例使用。

Enter 逻辑同时带有文档变更兜底：如果其他扩展或编辑器模式先把 Enter 处理成了普通换行，扩展会在换行后立即检查上一行并补上缺失的 `\\`；开启自动对齐时，同样执行补列和列格式扩展。

## 环境转换

运行 `vscode-hypersnips: Convert LaTeX Environment` 可以转换当前光标所在环境：

- `align`、`align*`、`aligned`、`equation`、`equation*`、`split`、`gather`、`gather*`
- `matrix`、`pmatrix`、`bmatrix`、`Bmatrix`、`vmatrix`、`Vmatrix`、`smallmatrix`、`cases`
- `array`、`tabular`、`tabular*`、`tabularx`、`longtable`

如果光标在 `\[...\]` 或 `$$...$$` 内，会把 display math delimiter 转为所选环境。如果有选区且不在已有环境内，会用目标环境包裹选区。转换到表格类环境时会保留已有列格式；没有列格式时会提示输入，默认是 `c`，`tabularx` / `tabular*` 默认使用 `\linewidth`。

直接修改 `\begin{...}` 或 `\end{...}` 内的环境名时，扩展会尝试同步另一端名称。若自动同步没有触发，可以运行 `vscode-hypersnips: Rename Matching LaTeX Environment` 手动同步当前环境。

`vscode-hypersnips: Wrap Math Structure` 可以把选区或当前公式 body 包裹成 `aligned`、`cases`、`split`、`matrix`、`pmatrix`、`bmatrix`、`equation`、`align` 等结构。`vscode-hypersnips: Unwrap Math Structure` 会移除当前最外层支持的数学环境或 display math delimiter，并保留内部内容。

## Snippet 管理器

运行 `vscode-hypersnips: Open Snippet Manager` 可以打开 Webview 管理器：

- 按 `.hsnips` 文件浏览 snippet。
- 搜索 trigger、description、flags 和 body。
- 过滤有诊断、重复 trigger、自动展开、数学限定、动态和正则 snippet。
- 查看重复 trigger、非法 flags、空 trigger、缺少 `endsnippet` 等诊断。
- 使用内置 Monaco 编辑器直接编辑当前 `.hsnips` 文件完整源码；动态 snippet、正则 snippet 和 `global` 代码都可以在源码中修改。
- 点击列表中的 snippet 会跳转到源码位置；移动编辑器光标时，右侧详情会跟随当前 snippet。
- `New` 会在当前文件末尾插入简单 snippet 模板；`Delete` 会删除当前 snippet 源码块。两者都只修改 Webview buffer，点击 `Save` 后才写回磁盘。
- `Open Source` 仍可回到 VS Code / Cursor 原生编辑器中的源码位置。

管理器保存前会检查文件 hash、mtime，以及 VS Code / Cursor 中是否存在未保存的同名 `.hsnips` 文档；如果源文件被外部修改，会要求先 Reload，避免覆盖手动改动。若 Monaco 资源加载失败，管理器会自动降级到普通文本编辑区。

## `${VISUAL}`

`${VISUAL}` 会替换为最近 5 秒内选中的文本，适合用来包裹已有公式片段。

```hsnips
snippet fr "Fraction" iAm
\frac{${1:${VISUAL}}}{$2}
endsnippet
```

例如先选中 `x+y`，再在数学环境中输入 `fr`，可以得到：

```tex
\frac{x+y}{}
```

## 常用命令

扩展提供以下命令：

- `vscode-hypersnips: Open Snippets Directory`
- `vscode-hypersnips: Open Snippet File`
- `vscode-hypersnips: Open Snippet Manager`
- `vscode-hypersnips: Select Snippet Profile`
- `vscode-hypersnips: Open Active Snippet Profile`
- `vscode-hypersnips: Reload Snippets`
- `vscode-hypersnips: Convert LaTeX Environment`
- `vscode-hypersnips: Rename Matching LaTeX Environment`
- `vscode-hypersnips: Wrap Math Structure`
- `vscode-hypersnips: Unwrap Math Structure`
- `vscode-hypersnips: Smart Math Enter`
- `vscode-hypersnips: Insert Matrix Column Separator`
- `vscode-hypersnips: Smart Alignment Tab`

## 开发

使用 Node.js 22 或更新版本，安装依赖并编译：

```sh
npm ci
npm run compile
```

常用脚本：

- `npm run compile`：编译 TypeScript 到 `out/`。
- `npm run watch`：开发时持续编译。
- `npm run lint`：运行 TypeScript 静态检查。
- `npm test`：运行核心 LaTeX 编辑逻辑测试。
- `npm run check`：依次运行静态检查和测试。
- `npm run package`：生成 `dist/vscode-hypersnips-<version>.vsix`。
- `npm run test:integration`：在独立用户数据、扩展、工作区及虚构片段目录中运行真实 VS Code 宿主测试。
- `npm run package:performance`：从干净工作树生成带提交短哈希的性能试用包。
- `npm run release:notes -- v<version>`：校验标签版本并生成 `tmp/release-notes.md`，仅供预览，不执行发布。

目录按职责组织：`src/` 为扩展源码，`test/` 为测试和 fixture，`scripts/` 为构建脚本，`images/` 为图标资源。`out/` 存放随插件分发的运行代码，`dist/` 存放正式安装包；测试编译结果、测试会话、下载缓存、日志、临时脚本及中间文件统一放在 `tmp/`，不在项目根目录散落生成过程文件。这些生成目录均不提交 Git，`tmp/`、测试和构建脚本不打入 VSIX。

Snippet Manager 使用 `monaco-editor` 的精简运行时资源。`vsce package` 会先运行 `npm run prepare-monaco`，只复制 Monaco editor core、worker、字体和语言包到 `media/monaco`，避免把整个 `node_modules/monaco-editor` 打进 VSIX。

本地打包：

```sh
npm run package
```

## Pull Request 与自动发布

开发改动先提交到分支，并将面向使用者的变化写入 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]`。推送到 `main`、`codex/performance-refactor` 或提交以 `main` 为目标的 Pull Request 时，GitHub Actions 会在 Linux 和 Windows 上运行回归及真实 VS Code 宿主测试，成功后生成 VSIX artifact。

性能试用通过后，由维护者创建 `codex/performance-refactor` → `main` 的 Pull Request，检查改动、测试结果及试用反馈，再选择 **Create a merge commit** 合并，以保留分阶段提交。若同步最新 `main` 后产生影响行为的改动，应重新测试并提供试用包。合并 PR 本身不会创建 Release。

准备正式发布时另开版本准备分支。以下以未来的 `0.1.5` 为例，当前试用包仍保持 `0.1.4`：

1. 将 `[Unreleased]` 的本次内容整理为 `## [0.1.5] - YYYY-MM-DD`，填入实际发布日期，顶部继续保留空的 `[Unreleased]`。
2. 更新版本并预览将来展示的 Release 正文：

```sh
npm version 0.1.5 --no-git-tag-version
npm run release:notes -- v0.1.5
npm run check
npm run package
```

3. 将 `package.json`、`package-lock.json` 和 `CHANGELOG.md` 一起提交，经 PR 检查后合入 `main`。版本准备阶段使用 `--no-git-tag-version`，避免在日志尚未完整时提前生成发布标签。
4. 在干净工作目录同步已经审核的 `main`，再创建新标签并推送：

```sh
git switch main
git pull --ff-only origin main
git tag -a v0.1.5 -m "Release v0.1.5"
git push origin v0.1.5
```

标签必须与 `package.json` 的版本一致，且 CHANGELOG 中必须有唯一、带日期、包含更新条目的对应章节。工作流提取该章节到 `tmp/release-notes.md`，通过独立的说明 artifact 传递给发布任务，再用 `gh release create --notes-file` 将标题、分类和条目直接展示在 GitHub Release 正文中。未发布内容和其他版本不会混入正文，验证、测试或打包失败均不会发布。

`CHANGELOG.md` 随 VSIX 分发，生成的说明文件、测试及构建脚本不进入扩展。流程仅由 `v<version>` 标签触发 GitHub Release，使用 GitHub 提供的 `GITHUB_TOKEN`，无需另配发布密钥；不会发布到 VS Code Marketplace。不要重用或移动已有的 `v0.1.4` 标签。

## 致谢

本项目派生自 HyperSnips 系列的可编程 snippet 引擎。当前仓库在原有能力基础上，面向 LaTeX / Markdown 数学写作继续维护和增强。
