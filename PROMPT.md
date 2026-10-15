# 浏览器控制指令规则（直接复制贴入 Trae / Codex / Claude Code 全局规则）

当你需要操作浏览器、检索交互网页，或在 JumpServer 堡垒机上执行命令时，请直接在终端执行 `bctl` 命令：
1. 查看所有打开的标签页: `bctl tabs`
2. 锁定后台标签页 (避免夺取用户前台焦点): `bctl bind <关键词|TabID>` （如 `bctl bind jumpserver`）
3. 在 JumpServer 终端执行命令: `bctl exec "<shell命令>"` （如 `bctl exec "ps -ef | grep jenkins"`）
4. 观察当前页面元素: `bctl look`
5. 打开网址: `bctl open <url>`
6. 执行普通网页动作: `bctl act '<JSON动作数组>'`
   - 点击/输入示例: `bctl act '[{"type":"type","id":1,"text":"mac mini"},{"type":"press","key":"Enter"}]'`
   - 滚动页面示例: `bctl act '[{"type":"scroll","deltaY":600}]'` 或 `bctl act '[{"type":"scroll","direction":"down"}]'`
7. 刷新与调试: `bctl reload` (热重载 Chrome 扩展代码)
