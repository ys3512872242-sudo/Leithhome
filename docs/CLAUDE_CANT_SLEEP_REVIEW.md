# `claude-cant-sleep` 对 Leithhome 的适配评估

审阅来源：

- https://github.com/reneyuxi0402/claude-cant-sleep
- https://github.com/reneyuxi0402/claude-cant-sleep/blob/master/README.zh.md
- https://github.com/reneyuxi0402/claude-cant-sleep/blob/master/skills/heartbeat/SKILL.md

## 原项目真正做了什么

它不是新的心理模型，而是一份 Claude Code Skill：用 `ScheduleWakeup` 每约 50 分钟唤醒一次会话。每次醒来先看时间和近期消息；用户十五分钟内仍活跃时不打扰，否则只选一项任务，完成后留言，再安排下一次唤醒。凌晨会把间隔拉长到两至三小时。

## 可以迁入 Leithhome 的原则

1. **先定向再行动**：每次 heartbeat 先读取当前状态、具体未完成事项、当前时间与最近互动，而不是随机产生一句话。
2. **活跃用户抑制**：最近十五分钟有用户消息时，不产生自主碎语，不打断正在进行的对话。
3. **一次只选一件事**：当前意图只能有一个主行动，避免同时“想研究、想亲近、想整理记忆”。
4. **允许什么都不做**：分数未越过阈值时只做时间衰减，不强行生成内容。
5. **昼夜节律**：夜间降低主动程度、延长检查间隔；疲惫高时优先休息。
6. **只在有结果时留痕**：内部动作确实完成或形成了有意义的新念头，才记录一条简短结果。
7. **每次结束都明确下一次条件**：在网页环境中不是设置系统闹钟，而是保存 `next_eligible_at`，供页面保持开启或下次打开时判断。

## 不应直接迁入的部分

- GitHub Pages 关闭后没有进程，不能照搬 `ScheduleWakeup` 或宣称离线期间持续运行。
- 不采用固定每 50 分钟调用一次大模型；这会增加费用，也会产生大量无意义状态。
- 第一阶段不允许 heartbeat 自主浏览网页、查邮箱、运行工具、修改记忆或玩游戏。
- 不采用“没有关闭开关”的无限循环。Leithhome 必须有 feature flag、静默时段和调用预算。
- 不把自由散想直接写入系统提示或长期记忆；念头仍是受来源约束的数据。

## 推荐的 Leithhome 版本

```text
页面打开 / 回到前台
→ 普通代码检查 last_user_message_at、last_updated_at、next_eligible_at
→ lazy catch-up（不调用模型）
→ 根据 drive + concrete open loop 选一个意图
→ 用户活跃 / 疲惫过高 / 不应期 / 分数不足：安静结束
→ 第一阶段只更新状态与桌面卡片
→ 未来启用自主碎语后，最多生成一条，并受每日预算限制
```

当前已经先吸收“具体未完成事项”这一点：事件结构新增 `user_goal` 与 `open_loop`，念头优先保存明确对象和动作，确定性意图会引用它们，不再只输出“继续弄清这件事”。完整自主 heartbeat 仍保持关闭。

