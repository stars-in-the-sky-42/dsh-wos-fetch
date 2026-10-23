# 安全与凭据

## cookie 存在哪

- 首选：DSH 凭据库 `$DSH_HOME/.credentials.yaml` 的 `refs.DSH_WOS_COOKIE`。
- 回退：`<dataDir>/cookie.txt`（默认 `$DSH_HOME/storages/wos-fetch/cookie.txt`）。
- 优先级：工具参数 `cookie_file` > 凭据库 > 环境变量 `WOS_COOKIE` > 文件。

## 不会发生什么

- 不会把 cookie 写进插件包、`cordis.patch.yml`、工具输出或日志。
- 不会把 cookie 发给 WoS 以外的域名。
- 设置页不会回显已保存的 cookie，只显示“已配置/未配置”和来源。

## 注意事项

- cookie 等同于密码：不要发给别人、不要提交到 git、不要贴进对话。
- 如果怀疑泄露：在 WoS 退出登录/重新登录使旧会话失效，然后在设置页保存新 cookie。
- 卸载插件不会自动删除凭据；需要时在设置页点“清除”，或手动编辑 `.credentials.yaml`。
- `$DSH_HOME/.credentials.yaml` 的权限应为仅当前用户可读（DSH 会检查）。
