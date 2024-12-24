## LarkPal
本项目Fork自Bill的Wechat-pal项目。
以下是项目的简易说明。

### 简介
这是一个简单的整合OpenAI和飞书的Node.js服务，可将飞书群中收到的消息以一定时间间隔的批次提交给OpenAI作为输入，然后将其输出发送至同一个飞书群。
通过设定System Prompt，可以实现群聊的AI助手功能。即在Prompt中设定好AI的身份以及详细说明其在群中需要做的事情，它可以响应群聊内容并按照设定的身份作出回应。

### 安装运行说明
将项目Clone至本地，然后在项目路径下执行：
```bash
npm install
cp config/default.sample.json config/default.json
```

然后修改`config/default.json`中的配置项：
- `openAI.APIKey` OpenAI Key
- `openAI.maxCompletionTokens` 单次OpenAI请求生成的token数限制
- `openAI.maxPromptTokens` 单次OpenAI请求发送的token数限制，此限制数会与`assistant.messageBatchPeriodDays`一起影响发送给AI的消息数量。需要注意的是，因为实现的原因，token数量的限制并不是精确的。
- `assistant.idleTimeSeconds` AI助手的等待时间（秒），即多久没有收到消息后会触发AI助手的回复。此设定是为了减少OpenAI的调用频率，尤其当群里消息比较密集时。但如果有人@AI助手，它会立即回复。
- `assistant.messageBatchPeriodDays` 每次向OpenAI发送的消息数量（天），即每次会发送这么多天内的消息给AI。此数值越大，AI能获取的信息量也越大，但也会增加成本。另外，当消息对应的token数量超过`openAI.maxPromptTokens`时，会自动去掉最早的消息。
- `assistant.systemPrompt` AI助手的System Prompt，此prompt每次都会发送给AI，可以在此对AI的身份和功能进行设定。
- `assistant.groupTopic` 群名。只有该群的消息才会被发送给AI。
- `lark.appId` 飞书的App ID
- `lark.appSecret` 飞书的App Secret
- `lark.chatId` 要追踪的飞书群聊Chat ID
- `lark.robotOpenId` 飞书机器人的Open ID

然后在项目路径下执行以下命令即可启动服务：
```bash
npm run start
```
### 其他说明
- 目前程序中设定当AI返回内容以`[x]`开头时，此内容不会被发到群里。如果需要该设定生效，请在systemPrompt中说明此条规则。
- 飞书群描述：
    - 若为JSON格式，其model字段会覆盖config中的model字段，其prompt字段会自动添加到AI的System Prompt中。
    - 若非JSON格式，则会被视为普通文本，添加到AI的System Prompt中。
- 飞书群描述的JSON格式示例：
    ```json
    {
        "model": "gpt-4o-mini",
        "prompt": "群成员及本月每周需完成的次数档位：白利彬为4次，其他人3次"
    }
    ```