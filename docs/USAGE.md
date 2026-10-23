# WoS 工具详细用法

## 工具：`wos_fetch`

免浏览器直连 WoS 核心合集。返回 Markdown 记录表；完整原始 NDJSON 落盘。

### 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `query` | ✅ | — | 检索词，如 `ZrVSi`、`"Sr2RuO4" AND superconduct*` |
| `field` | | `TS` | `TS` 主题 / `TI` 标题 / `AU` 作者 / `AI` 作者标识符 / `SO` 来源出版物 / `PY` 年份 / `AB` 摘要 / `ALL` 所有字段 / `DO` DOI / `OG` 机构 |
| `sort` | | `relevance` | `relevance` / `date` / `times-cited` / `usage-count` |
| `count` | | `50` | 每页条数，1–200 |
| `page` | | `1` | 第几页 |
| `max_rows` | | `30` | 表格最多几行，1–200 |
| `save` | | `true` | 是否落盘 NDJSON |
| `cookie_file` | | 配置值 | 覆盖 cookie 文件路径（一般不用） |

### 返回

- `message`：命中数、记录表、qid、页面 URL、NDJSON 路径。
- `data`：JSON 字符串，含 `records` / `ndjsonPath` / `cookieSource` 等。

### 凭据优先级

1. 工具参数 `cookie_file`；
2. DSH 凭据 `DSH_WOS_COOKIE`（设置页写入）；
3. 环境变量 `WOS_COOKIE`；
4. 文件 `<dataDir>/cookie.txt`。

### 检索习惯

- 默认习惯见 [HABITS.md](HABITS.md)。
- 修改：在对话里口述，DSH 调用 `wos_habits(action="write", content="...")`。
- 读取 / 重置：`wos_habits(action="read")` / `wos_habits(action="reset")`。
- 文档位置：`<dataDir>/habits.md`（dataDir 默认 `$DSH_HOME/storages/wos-fetch`，可在设置页改）。
- 系统提示每条消息动态读取；保存后下一条消息生效。

### 已知限制

- **网络前提**：当前电脑必须能访问 WoS；校园网/VPN 断开会失败。
- cookie 会过期；没有自动刷新。
- WoS 接口不是公开 API，字段/端点可能随站点更新变化。
- 没有导出/标记列表功能；需要登录态操作时仍要走浏览器。
