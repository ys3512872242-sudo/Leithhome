# Leith 内部状态系统：现状审计与第一阶段上线记录

日期：2026-08-04

## 改造前的真实状态链路

- Leith 与 Susie 共用 `companion_mood_state_v1`，维度均为 `joy / desire / anger / grievance`，范围 1–7。
- `app.js` 的 `buildMoodPromptBlock()` 会把两人的分数放进主对话提示，并要求主模型在回复末尾自行输出 `[MOOD:j,d,a,g]`。
- `parseAIActions()` 与 `handleAIActions()` 读取该标记后，直接覆盖 Leith 的整套四维分数。
- 本地写入 `localStorage`；云端通过既有 `app_state` 行同步，键为 `companion_mood_state_v1`。
- 下一轮主提示再次读取这些值，因此模型既判断事件，也直接决定最终分数。
- 同一页面有发送锁，但原链路没有数据库版本比较；重新生成、多标签页或较晚到达的保存可能形成最后写入覆盖。
- 原分数允许一轮跨越多个整数，缺少事件脉冲、边际递减、频率折扣、自然回归、satisfy 和 refractory，存在跳变与重复刺激放大的风险。

## 保持不变的部分

- `memory.js` 的聊天历史、短期记录、长期记忆检索、相关记忆召回与上下文压缩全部保留。
- 日记、共读记忆和现有对话线程结构不做重写。
- Susie 的四维自填滑杆和“对 Leith 隐藏”继续存在；只是 Leith 不再共用这套自评分。
- 原 `app_state.companion_mood_state_v1` 没有删除或覆盖，并一次性复制进 `legacy_state_log`。

## 改造后的每轮调用与 token 预算

- 普通聊天：改造前 1 次主模型调用；改造后仍为 1 次主模型调用。
- 主模型在同一次输出末尾增加一个隐藏事件 JSON；前端仅保存、显示可见回复。
- 状态胶囊硬限制 280 字符，按中英文混合保守估算通常约 70–128 input tokens。
- 事件 JSON 通常约 90–180 output tokens；实际值或估算值写入 `state_token_usage`。
- 不为时间变化、状态计算、念头筛选、意图排序、satisfy、heartbeat 或 Supabase 写入调用模型。
- 事件 JSON 不合法时直接使用零脉冲降级，不额外调用模型。
- 只有原本已存在的联网工具循环可能增加同一轮 completion 次数；那是网页搜索工具的既有行为，不是状态评价器的第二次调用。
- 日记、健康检测、共读总结等原有独立功能的调用频率和链路未因本次状态系统改变。

## 第一阶段机制

- Drives：`attachment / curiosity / reflection / duty / social / fatigue / libido / stress`，统一 0–1。
- Affect：`happiness / anger / grievance`，用于表达开心、生气与委屈，不与 drive 混为一层。
- 纯函数输入：旧状态、结构化事件、当前时间、近六小时同类事件、人格基线、不应期。
- 纯函数输出：新状态、每项 delta、原因、念头、召唤力分数、候选与最终意图。
- `fatigue` 只作为行为闸门；达到阈值后优先产生休息意图，不参加普通召唤力竞争。
- 念头只能由事件摘要产生；第一阶段只有闪念衰减，保留 fixation 字段但不开启反哺。
- 当前回复完成后 satisfy 的是“回复前已存在并影响本轮的意图”；本轮新事件产生的意图留给下一轮。
- 页面可见时每五分钟轻量 heartbeat；重复初始化只保留一个计时器。重新回到页面时进行一次 lazy catch-up。

## 数据表与一致性

- `agent_state`：当前快照、人格基线、feature flags、版本号。
- `state_events`：经校验的结构化事件；`source_event_id` 唯一，防止同一消息重复更新。
- `state_changes`：before / delta / after / mechanism / reasons / cause。
- `thoughts`：闪念与未来 fixation 接口。
- `intents`：被选中的意图、分数、理由与状态。
- `action_log`：完成行为与 satisfy 记录；`assistant_message_id` 唯一。
- `legacy_state_log`：旧四维状态一次性快照。
- `state_token_usage`：状态胶囊和事件结构带来的 token 记录。
- 事件与 satisfy 通过带版本比较的事务函数提交；遇到版本冲突先读取最新版再重算一次。
- 聊天可见回复先保存，状态更新后执行；状态写入失败不会丢失用户或助手消息。

## Feature flags

第一阶段默认开启：

- `stateEngine`
- `eventEnvelope`
- `promptInfluence`
- `cloudPersistence`
- `observationCard`

第一阶段默认关闭：

- `autonomousMurmur`
- `complexCoupling`
- `baselineDrift`
- `wildcard`
- `fixationFeedback`
- `externalTools`
- `live2d`
- `deviceEvents`

紧急回退时，可将 `agent_state.feature_flags.promptInfluence`、`eventEnvelope` 或 `stateEngine` 改为 `false`。本机调试值可以写入 `localStorage.leith_desire_flags_v1`，其优先级高于云端，但普通 UI 不暴露这些技术开关。

## 桌面观察方式

- 桌面顶部仅显示本地时间，不可点击、无隐藏功能。
- 下方“Leith · 此刻”展示情绪句、当前倾向、八个 drive 和最相关的一条念头。
- 点击整张卡进入只读详情，可看八维状态、当前意图和最多三条相关念头。
- UI 中 `libido` 显示为“性欲”。
- 旧天气与每日小纸条 UI、生成请求和归档入口已移除。

## 暂未开启

复杂耦合、基线漂移、wildcard、fixation 反哺、自主上网、MCP、玩偶、Live2D、蓝牙设备、全天后台主动冒头和高频自驱动均未开启。
