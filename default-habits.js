/**
 * 出厂默认的 WoS 检索习惯。
 *
 * 这份文本会在首次运行时写入 $DSH_HOME/storages/wos-fetch/habits.md。
 * 用户可以在对话里让 DSH 改写它；这里只负责“开箱即用”的起点。
 */

export const DEFAULT_HABITS = `# 课题组 WoS 检索习惯（默认）

1. 检索文献一律用 wos_fetch；不要凭记忆写文献，也不要用普通网页搜索代替 WoS。
2. 检索式必须覆盖不同的元素顺序排列（如 ScRuP / ScPRu / RuScP），111 型也要试。
3. 精确化学式加引号；查超导性质加 superconduct*；查结构加 structure / crystal / space group。
4. 先检索、再下结论。与结论相关的每篇文献都要按需读 NDJSON 里的摘要，不能只看标题。
5. 每条结论带检索式 + UT/DOI，并区分【实验】/【计算】/【数据库】/【本会话推断】。
6. 结果默认落盘（save=true），不要只在对话里过一遍。
7. 空间群以 MP 工具为准；MP 查不到时先问用户，不要自行判定。
8. 检索结果先按空间群归档，再按型号、材料整理。
`
