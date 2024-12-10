const lark = require('@larksuiteoapi/node-sdk'); // lark node-sdk使用说明：https://github.com/larksuite/node-sdk/blob/main/README.zh.md
const config = require('config');
const sharp = require('sharp');
const openAIManager = require('./openAIManager');
const utils = require('./utils');
const messagePointer = require('./messagePointer');
const schedule = require('node-schedule');

let client;
let wsClient;

/**
 * Initializes the Lark client with the provided configuration and logs the initialization.
 * Schedule a job to fetch messages at specified intervals.
 */
function init() {
    const baseConfig = {
        appId: config.lark.appId,
        appSecret: config.lark.appSecret,
        // disableTokenCache为true时，SDK不会主动拉取并缓存token，这时需要在发起请求时，调用lark.withTenantToken("token")手动传递
        // disableTokenCache为false时，SDK会自动管理租户token的获取与刷新，无需使用lark.withTenantToken("token")手动传递token
        disableTokenCache: false
    };
    client = new lark.Client(baseConfig); // Initialize Lark client
    utils.logDebug('Lark client initialized');

    let rule = new schedule.RecurrenceRule();
    rule.second = 0;
    rule.minute = [0, 10, 20, 30, 40, 50];
    schedule.scheduleJob(rule, () => {
        fetchMessagesForDays(config.assistant.messageBatchPeriodDays);
    });
    utils.logDebug('Scheduled job to fetch messages every 10 minutes');

    // Initialize WebSocket client
    wsClient = new lark.WSClient({...baseConfig, loggerLevel: lark.LoggerLevel.debug});
    wsClient.start({
        eventDispatcher: new lark.EventDispatcher({}).register({
            "im.message.receive_v1": async (data) => {
                utils.logDebug("Receiving message: \n" + JSON.stringify(data.message, null, 4));
                if (data.message.chat_id == config.lark.chatId) {
                    if (data.message.mentions) {
                        for (let i = 0; i < data.message.mentions.length; i++) {
                            const mention = data.message.mentions[i];
                            if (mention.name == "李白") {
                                fetchMessagesForDays(config.assistant.messageBatchPeriodDays);
                                break;
                            }
                        }
                    }
                }
            },
        }),
    });
}

/**
 * Fetches messages for a specified number of days and processes them.
 * @param {number} day - The number of days to fetch messages for.
 */
async function fetchMessagesForDays(day) {
    let currentTime = Math.floor(Date.now() / 1000);
    let startTime = currentTime - 3600 * 24 * day;
    let messages = await fetchMessages(currentTime, startTime);

    utils.logDebug('Messages fetched: ' + messages.length);
    let messageQueue = [];
    let lastMessageId;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        let messageToOpenAI = {};
        if (message.msg_type == 'system' || message.deleted) {
            continue;
        } else {
            messageToOpenAI.bot = message.sender.sender_type == 'app';
            if (!messageToOpenAI.bot) {
                let res = await fetchSenderInfo(message.sender.id);
                messageToOpenAI.sender = res.data.user.name;
            } else {
                messageToOpenAI.sender = '李白';
            }
            messageToOpenAI.time = Number(message.create_time);
        }
        if (message.msg_type == 'text') {
            messageToOpenAI.text = JSON.parse(message.body.content).text;
        }
        if (message.msg_type == 'interactive') {
            messageToOpenAI.text = JSON.parse(message.body.content).elements[0][0].text;
        }
        utils.logDebug(messageToOpenAI);
        if (message.msg_type == 'image') {
            let imageKey = JSON.parse(message.body.content).image_key;
            let buffer = await fetchImage(message.message_id, imageKey);
            let dimension = config.get('assistant.imageDimension');
            const resizedBuffer = await sharp(buffer).resize({ width: dimension, height: dimension, fit: sharp.fit.inside, withoutEnlargement: true }).jpeg().toBuffer();
            const base64Data = resizedBuffer.toString('base64');
            messageToOpenAI.image = base64Data;
        }
        messageQueue.push(messageToOpenAI);
        if (!messageToOpenAI.bot)
            lastMessageId = message.message_id;
    }

    if (lastMessageId == messagePointer.getLastMessageId() || messageQueue[messageQueue.length - 1].bot)
        return;

    let reply = await openAIManager.sendToOpenAI(messageQueue);
    if (reply) {
        if (reply.startsWith('[x]')) {
            utils.logInfo(`[Internal] ${reply}`);
        } else {
            utils.logInfo(`Sending message: ${reply}`);
            reply = reply.replace(/\n/g, '\\n');
            // utils.logInfo(JSON.stringify(JSON.parse(`\{\"text\":\"${reply}\"\}`)));
            let res = await sendMessage(reply);
            if (res.code == 0) {
                utils.logDebug('Message sent successfully');
            } else {
                utils.logDebug('Failed to send message: ' + res.code + ', ' + res.msg + ', ' + JSON.stringify(res.data));
            }
        }
    }
    messagePointer.setLastMessageId(lastMessageId);
}

/**
 * Fetches messages from Lark within a specified time range.
 * @param {number} currentTime - The current time in seconds since the Unix epoch.
 * @param {number} startTime - The start time in seconds since the Unix epoch.
 * @param {string} pageToken - The token for the next page of results.
 */
async function fetchMessages(currentTime, startTime, pageToken) {
    utils.logDebug('Fetching messages from Lark...');
    try {
        let res = await client.im.message.list({
                params: {
                    container_id_type: 'chat',
                    container_id: config.lark.chatId,
                    start_time: startTime.toString(),
                    end_time: currentTime.toString(),
                    sort_type: 'ByCreateTimeAsc',
                    page_size: 10,
                    page_token: pageToken,
                },
            }
        );

        let messages = [];
        if (res.code == 0) { // 0表示成功
            for (let i = 0; i < res.data.items.length; i++) {
                messages.push(res.data.items[i]);
            }
            if (res.data.has_more) { // 是否还有更多数据
                return messages.concat(await fetchMessages(currentTime, startTime, res.data.page_token));
            } else {
                return messages;
            }
        } else {
            utils.logDebug("Error! Code: " + res.code + ", Msg: " + res.msg);
            return [];
        }
    } catch (e) {
        console.error(JSON.stringify(e.response.data, null, 4));
        return [];
    }
}

/**
 * Fetches the sender information for a given user ID.
 * @param {string} userId - The ID of the user to fetch information for.
 */
async function fetchSenderInfo(userId) {
    let res = await client.contact.user.get({
            path: {
                user_id: userId
            },
            params: {
                user_id_type: 'open_id',
                department_id_type: 'open_department_id'
            }
        }
    );
    return res;
}

/**
 * Fetches an image from a message resource.
 * @param {string} messageId - The ID of the message containing the image.
 * @param {string} imageKey - The key of the image file.
 */
async function fetchImage(messageId, imageKey) {
    try {
        return await new Promise((resolve) => {
            client.im.messageResource.get({
                path: {
                    message_id: messageId,
                    file_key: imageKey,
                },
                params: {
                    type: "image",
                },
            }).then((res) => {
                let stream = res.getReadableStream();
                let chunks = [];
                stream.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                stream.on('end', (chunk_1) => {
                    const binaryContent = Buffer.concat(chunks);
                    resolve(binaryContent);
                });
            });
        });
    } catch (e) {
        console.error(JSON.stringify(e.response.data, null, 4));
        return null;
    }
}

/**
 * Sends a message to a specified chat in Lark.
 * @param {string} message - The message to be sent.
 */
async function sendMessage(message) {
    let res = await client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: config.lark.chatId,
          msg_type: "text",
          content: JSON.stringify(JSON.parse(`{"text":"${message}"}`))
        }
    });
    return res;
}

module.exports = { init, fetchMessagesForDays };
