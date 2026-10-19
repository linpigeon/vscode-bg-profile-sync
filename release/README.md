# release/

`local.bg-profile-sync-*.vsix` 是可直接 `code --install-extension` 的安装包。

- **GitHub（推荐，直链）**：
  <https://github.com/linpigeon/vscode-bg-profile-sync/releases/latest>
- **Gitea**（release 里也挂了资产）：
  <https://git.pigeon-lin.top/lin/vscode-bg-profile-sync/releases>
- **GitCode**（点开页面上的下载按钮；GitCode 的 raw 直链会返回 HTML 而不是二进制）：
  <https://gitcode.com/gcw_Dt5aZ2Tj/vscode-bg-profile-sync/tree/main/release>

安装：

```powershell
code --install-extension .\local.bg-profile-sync-2.3.1.vsix --force
# 装进指定配置文件：code --profile Python --install-extension .\local.bg-profile-sync-2.3.1.vsix --force
```
