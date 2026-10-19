# Background Profile Sync（背景跟随 VS Code 配置文件）

> 仓库：[GitHub](https://github.com/linpigeon/vscode-bg-profile-sync) ·
> [GitCode](https://gitcode.com/gcw_Dt5aZ2Tj/vscode-bg-profile-sync) ·
> [Gitea](https://git.pigeon-lin.top/lin/vscode-bg-profile-sync)
> · 发布：[GitHub v2.1.1](https://github.com/linpigeon/vscode-bg-profile-sync/releases/tag/v2.1.1) /
> [Gitea v2.1.1](https://git.pigeon-lin.top/lin/vscode-bg-profile-sync/releases/tag/v2.1.1)

`shalldie.background` 的背景图是注入到 **VS Code 安装目录**里的
`out/vs/code/electron-browser/workbench/workbench.html`，这个文件是全局唯一的；
而 VS Code 的「配置文件(profile)」只切换 `settings.json`。
所以切换配置文件时背景不会跟着变 —— 你看到的永远是上一个写进 html 的图。

这个扩展补的就是这一环，并且从 **2.x 起默认走「加载器」方案：换 profile 只改一个 JSON 文件，
背景在 ~100ms 内自动换掉，不需要重载窗口。**

## 两种模式（`bgProfileSync.syncMode`）

### `loader`（默认，2.x）

html 里只装一个**稳定不变**的加载器脚本，扩展开关/换 profile 都只改安装目录里的
`bg-profile-sync.json`：

```
workbench.html  ──(注入一次，含 stderr 抑制/主题变量/加载器)──►  加载器（每 80ms / 400ms 轮询）
                                                                    │ fetch(vscode-file://…/bg-profile-sync.json)
                                                                    ▼
                                                     <style id="bg-profile-sync-style"> CSS </style>
```

切 profile 的时间线（实测）：

| 时刻 | 发生什么 |
| :--- | :--- |
| 0s | 你选「切换配置文件」，**VS Code 自己**重载窗口（这一步我们管不了） |
| ~1-2s | 窗口起来，加载器开始轮询，先读到的是上一个 profile 的 JSON |
| ~1.5-2s | 新窗口的扩展宿主启动，把当前 profile 的 CSS 写进 JSON |
| **+80ms 内** | 加载器读到新 JSON，换掉 `<style>`，**背景切过去 —— 没有第二次重载** |

改配置（比如把 `opacity` 从 0.2 调到 0.4）同理：写 JSON → 加载器套用，**连窗口都不用重载**。
实测：手动改 JSON 后 **45ms** 生效（旧版要弹「点击应用」+ 重载）。

### 多窗口：每个窗口用自己的配置文件

payload 不是"一份背景"，而是**所有配置文件的地图**：`entries`（哈希 → CSS 帧，相同配置去重）
+ `profiles`（配置文件名字 → 哈希）+ `fallback`（当前窗口的哈希）。渲染进程从窗口标题认出自己：

```
扩展: xxx - UniversityReminder - TypeScript - Visual Studio Code
                                  ^^^^^^^^^^ 倒数第二段 = profile 名
```

VS Code 默认标题模板是 `${activeEditorShort} - ${rootName} - ${profileName} - ${appName}`，
所以按倒数第二段匹配 `profiles` 表；匹配上就**锁定**（不重载就不会换 profile，切文件导致的标题变化不影响），
锁不上才用 `fallback`（= 最后写 payload 的那个窗口的配置，即旧行为）。

结论：**多个窗口各显示自己配置文件的壁纸，互不干扰**。

### `html`（旧行为，兜底）

把配置生成（或委托 `shalldie.background` 的 `extension.background.install`）成注入块直接写进
`workbench.html`，改完需要重载一次窗口。在两种情况下会自动用它：

- 当前 profile 配了 `background.editor`（那一段是编辑器区域的 DOM 规则，只有 html 模式渲染）；
- 你自己把 `bgProfileSync.syncMode` 设成 `html`。

## 为什么加载器是这么写的（都在这台机器上实测过）

| 假设 | 实测结果 |
| :--- | :--- |
| renderer 里能用 `require('fs')`（`vscode-custom-css` / APC 的做法） | ❌ **`require` 是 undefined**（VS Code 1.142 / Electron 40 已关掉 nodeIntegration） |
| 能用 `fetch()` 读 `vscode-file://` | ✅ **能，但只限 app 目录内的文件**；`.tmp` 之类外部路径一律 `Failed to fetch` |
| 能用 `<link rel=stylesheet>` 读 `vscode-file://` | ✅ 同样只限 app 目录（外部路径 `onerror`） |
| 动态 `<script src>` 注入 | ❌ 被 `require-trusted-types-for 'script'` 拦（抛异常） |
| `<style>.textContent` | ✅ 可用（background 扩展自己也这么干） |
| `WebSocket(ws://127.0.0.1:…)` | ✅ CSP 放行（`connect-src` 里有 `ws:`），但要自己起本地服务，没走这条路 |

所以：**JSON 必须放在 app 目录里**（和 `workbench.html` 同目录），加载器用 `fetch` 读它；
CSS 通过 `<style>.textContent` 套用 —— 全程不碰 `require`、不碰 Trusted Types。

加载器轮询节奏：窗口加载后 **20 秒内 80ms**（正好覆盖切 profile 后扩展写 JSON 的那段），
之后降到 **400ms** 省电。窗口每次重载都会重新进入快轮询。

## 安装（直接用 vsix，无需构建）

从 [Releases](https://github.com/linpigeon/vscode-bg-profile-sync/releases) 下载
`local.bg-profile-sync-<版本>.vsix`，然后：

```powershell
# 装进 Default 配置文件
& "D:\Microsoft VS Code\bin\code.cmd" --install-extension .\local.bg-profile-sync-2.3.1.vsix --force
# 或装进指定配置文件（会同时建好该配置文件）
& "D:\Microsoft VS Code\bin\code.cmd" --profile Python --install-extension .\local.bg-profile-sync-2.3.1.vsix --force
```

命令行脚本（`status.js` / `restore.js` / `build-vsix.ps1` / `install-vsix.ps1`）会自动探测
VS Code 安装目录；装在非默认位置（便携版等）时用环境变量指定：

```powershell
$env:VSCODE_APP_ROOT   = 'D:\VSCode\resources\app'          # 直接给 resources\app
# 或 $env:VSCODE_INSTALL_ROOT = 'D:\VSCode'                  # 给安装根目录
$env:VSCODE_USER_DIR   = "$env:APPDATA\Code\User"           # 用户数据目录（可选）
```

## 安装（从源码打包）

```powershell
.\build-vsix.ps1      # 打包
.\install-vsix.ps1    # 装进所有配置文件（Default + 每个命名 profile）
```

首次装好后第一次打开窗口会**多一次重载**（把 html 里的旧注入块换成加载器），之后就再也不会因为背景重载了。
VS Code 大版本升级会换安装目录，同样会在升级后第一次打开窗口时自动重装加载器（一次重载）。

## 使用

- 正常切换配置文件即可。
- 「Background Profile Sync: 立即同步背景」：手动触发一次。
- 「Background Profile Sync: 诊断：打印当前同步状态」：把模式、loader 版本、payload 路径/内容、
  当前 profile 哈希等打到输出面板 `Background Profile Sync`。

## 配置项

| 配置 | 默认 | 说明 |
| :--- | :--- | :--- |
| `bgProfileSync.syncMode` | `loader` | `loader` = 零重载（推荐）；`html` = 旧行为，每次改配置重载一次 |
| `bgProfileSync.enabled` | `true` | 关掉后本扩展完全不动作 |
| `bgProfileSync.emptyBehavior` | `clear` | 当前 profile 没配背景图时：`clear` = 清空背景；`keep` = 保持现有背景不变 |

## 已知限制

1. **首次安装 / VS Code 升级后会有一次重载**：要把 html 里的注入块换成加载器，这一次绕不过去。
2. **多窗口靠标题识别 profile**：如果你自定义了 `window.title` 且去掉了 `${profileName}`，
   窗口就认不出自己，会退回"最后写 payload 的那个 profile"的旧行为（仍然是零重载，只是可能串台）。
   另外 Default 配置文件不显示 profile 名，也会走 fallback。
3. **`background.editor` 段**：loader 模式不渲染它（会自动切到 html 模式，代价是一次重载）。
4. **别在 `shalldie.background` 里点「应用」**：它会把注入块重写成静态的，覆盖加载器；
   我们会在下一次窗口加载时自动装回加载器（代价是一次重载）。它装不装都不影响本扩展读配置。
5. **远程 / Web 窗口**：声明了 `extensionKind: ["ui"]`，在 Remote-SSH 窗口里也跑在本地 UI 侧；
   `appHost` 不是 `desktop` 时直接跳过。
6. **安装目录必须可写**（D 盘自定义安装一般没问题）。

## 诊断

```powershell
node status.js
```

打印模式（loader v4 / html）、payload 的 hash/帧数/mtime，以及每个配置文件的
`bgExt / config / 一致 / 就位 / 状态 / 图片 / hash`。

`node restore.js` 会清掉 html 里的注入块**并删掉 payload 文件**（自动备份 html）。

## 卸载

```powershell
.\uninstall.ps1              # 从所有配置文件卸载本扩展
node restore.js              # 还原 workbench.html + 删除 payload
```

## 文件

| 文件 | 说明 |
| :--- | :--- |
| `sync.js` | 纯逻辑：读配置、拼 `vscode-file` 地址、判断一致性、生成注入块/加载器/payload、校验与原子写入 |
| `extension.js` | 扩展入口：两种模式的同步流程、配置变更监听、输出面板、诊断命令 |
| `test/run-tests.js` | 单元 + 端到端测试（用真实 `workbench.html` 和真实 profile 配置，63 个用例） |
| `build-vsix.ps1` / `install-vsix.ps1` / `uninstall.ps1` | 打包 / 安装 / 卸载 |
| `status.js` / `restore.js` | 诊断 / 还原 |
| `.backup/` | 第一次改动前手工留的 `workbench.html` 备份（扩展自己的备份在 globalStorage） |

> PowerShell 脚本保持纯 ASCII；读 UTF-8 文件要用 `[IO.File]::ReadAllText(..., UTF8)`。
> JS 里读配置/写文件都不依赖外部包。

## 版本历史

### 2.3.1

- 修正 storage.json 路径（实际在 <userData>/User/globalStorage/ 下），否则只认出 Default 一个配置文件。

### 2.3.0

- **多窗口各用各的背景**：payload 改成「所有配置文件的地图」（`entries` + `profiles` + `fallback`），
  渲染进程按窗口标题里的 profile 名挑自己那份并锁定；标题认不出来才退回旧行为。
- 加载器 v4（旧格式 payload 仍兼容）；配置文件列表直接从用户目录枚举（`User/settings.json` +
  `profiles/*/settings.json`，名字取自 `globalStorage/storage.json`）。

### 2.1.1

- 加载器 v3：`debug` 测试标记用完会**还原原标题**（v2 之前是清空，会把窗口标题弄没）。

### 2.1.0

- 加载器轮询：头 20 秒 80ms、之后 400ms（实测关键路径 149ms 生效）。
- `debug` 标记用完后自动还原窗口标题。

### 2.0.0

- **换成「加载器」架构**：html 只注入一次稳定脚本，背景 CSS 由扩展写到
  `<安装目录>/…/bg-profile-sync.json`，加载器 `fetch` + `<style>` 套用。
  换 profile / 改配置不再重载窗口（实测切换后扩展只激活 1 次 = 零额外重载）。
- 新增 `bgProfileSync.syncMode`（`loader` / `html`）；`background.editor` 自动回退 html 模式。
- 保留 1.x 的 html 写入安全措施（自检 + 原子写 + 备份）作为兜底路径。

### 1.1.1

- 修掉一个自己埋的死循环风险：`upToDate` 只用「同步标记 + 图片集合」，标量样式校验只用于「省一次重载」的捷径。

### 1.1.0

- 省掉多余重载（标量样式校验）；修 `background.editor` 被清空、图解析不出被清空两个 bug；
  写入自检 + globalStorage 备份；输出面板 + 诊断命令；非桌面版跳过；`<` 转义。

### 1.0.0

- 初版：窗口启动时对比当前 profile 配置与安装目录注入，必要时委托 `shalldie.background`
  重写或自己生成注入块，然后重载窗口。
