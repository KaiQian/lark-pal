const lark = require('@larksuiteoapi/node-sdk'); // lark node-sdk使用说明：https://github.com/larksuite/node-sdk/blob/main/README.zh.md
const config = require('config');
const sharp = require('sharp');
const openAIManager = require('./openAIManager');
const utils = require('./utils');
const messageStorage = require('./messageStorage');

let client, wsClient;

const idleTime = config.get('assistant.idleTimeSeconds') * 1000; // Convert to milliseconds
const INSTANT_DELAY = 3000;
let instantReply = false;
let triggerId = null;

/**
 * Initializes the Lark client with the provided configuration and logs the initialization.
 * Schedule a job to fetch messages at specified intervals.
 */
async function init() {
    utils.logDebug('Initializing Lark client...');
    const baseConfig = {
        appId: config.lark.appId,
        appSecret: config.lark.appSecret,
        // disableTokenCache为true时，SDK不会主动拉取并缓存token，这时需要在发起请求时，调用lark.withTenantToken("token")手动传递
        // disableTokenCache为false时，SDK会自动管理租户token的获取与刷新，无需使用lark.withTenantToken("token")手动传递token
        disableTokenCache: false
    };
    client = new lark.Client(baseConfig);

    utils.logDebug('Fetching messages...');
    await fetchMessagesForDays(config.assistant.messageBatchPeriodDays);
    utils.logDebug('Messages fetched');

    utils.logDebug('Triggering OpenAI call if needed...');
    let lastMessage = messageStorage.getLastMessage();
    TryTriggerOpenAICall(lastMessage, true);

    utils.logDebug('Initializing WebSocket client...');
    wsClient = new lark.WSClient({...baseConfig, loggerLevel: lark.LoggerLevel.debug});
    wsClient.start({
        eventDispatcher: new lark.EventDispatcher({}).register({
            "im.message.receive_v1": handleDispatchedMessage,
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
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        await generateMessageSentToOpenAI(message);
    }
}

/**
 * Asynchronously triggers a call to OpenAI and handles the response.
 * This function retrieves recent messages from the message storage, sends them to OpenAI for processing,
 * and handles the response by either logging it internally or sending it as a message.
 */
async function triggerOpenAICall() {
    let messageQueue = messageStorage.getRecentMessages();
    if (messageQueue[messageQueue.length - 1].bot)
        return;

    instantReply = false;
    let reply = await openAIManager.sendToOpenAI(messageQueue);
    if (reply) {
        if (reply.startsWith('[x]')) {
            utils.logInfo(`[Internal] ${reply}`);
        } else {
            utils.logInfo(`Sending message: ${reply}`);
            reply = reply.replace(/\n/g, '\\n');
            let res = await sendMessage(reply);
            if (res.code == 0) {
                utils.logDebug('Message sent successfully');
            } else {
                utils.logDebug('Failed to send message: ' + res.code + ', ' + res.msg + ', ' + JSON.stringify(res.data));
            }
        }
    }
}

/**
 * Handles a dispatched message by logging it, checking if it mentions the bot, 
 * and preparing a response to be sent to OpenAI.
 * @param {Object} data - The data object containing the message information.
 * @param {Object} data.message - The message object.
 * @param {string} data.message.chat_id - The ID of the chat where the message was sent.
 * @param {Array} [data.message.mentions] - An array of mentions in the message.
 * @param {Object} data.message.mentions[].id - The ID object of the mention.
 * @param {string} data.message.mentions[].id.open_id - The open ID of the mentioned user.
 * @param {string} data.message.message_id - The ID of the message.
 */
async function handleDispatchedMessage(data) {
    if (data.message.chat_id != config.lark.chatId) return;
    let mentionSelf = false;
    if (data.message.mentions) {
        for (let i = 0; i < data.message.mentions.length; i++) {
            const mention = data.message.mentions[i];
            if (mention.id.open_id == config.lark.robotOpenId) { // Mentioned the robot
                mentionSelf = true;
                break;
            }
        }
    }

    let message = await fetchAMessage(data.message.message_id);
    if (message) {
        utils.logDebug("Receiving message: \n" + JSON.stringify(message, null, 4));
        let messageToOpenAI = await generateMessageSentToOpenAI(message);
        TryTriggerOpenAICall(messageToOpenAI, mentionSelf);
    }
}

/**
 * Triggers an OpenAI call after a specified delay if certain conditions are met.
 * @param {Object} messageToOpenAI - The message object to be sent to OpenAI.
 * @param {boolean} instant - Indicates if the reply should be instant.
 */
function TryTriggerOpenAICall(messageToOpenAI, instant) {
    if (messageToOpenAI && !messageToOpenAI.bot && !instantReply) {
        if (triggerId) {
            clearTimeout(triggerId);
            triggerId = null;
        }
        let delay = idleTime;
        if (instant) {
            delay = INSTANT_DELAY;
            instantReply = true;
        }
        triggerId = setTimeout(triggerOpenAICall, delay);
    }
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
 * Generates a message object to be sent to OpenAI based on the provided message.
 *
 * @param {Object} message - The message object to process.
 * @param {string} message.msg_type - The type of the message (e.g., 'system', 'text', 'interactive', 'image').
 * @param {boolean} message.deleted - Indicates if the message has been deleted.
 * @param {Object} message.sender - The sender of the message.
 * @param {string} message.sender.sender_type - The type of the sender (e.g., 'app').
 * @param {string} message.sender.id - The ID of the sender.
 * @param {number} message.create_time - The creation time of the message.
 * @param {Object} message.body - The body of the message.
 * @param {string} message.body.content - The content of the message in JSON string format.
 * @param {string} message.message_id - The ID of the message.
 */
async function generateMessageSentToOpenAI(message) {
    let messageToOpenAI = {};
    if (message.msg_type == 'system' || message.deleted) {
        return null;
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
    messageToOpenAI.message_id = message.message_id;
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

    if (messageToOpenAI) {
        messageStorage.addMessage(messageToOpenAI);
    }
    return messageToOpenAI;
}

/**
 * Fetches a message by its ID.
 * @param {string} messageId - The ID of the message to fetch.
 */
async function fetchAMessage(messageId) {
    let res = await client.im.message.get({
        path: {
            message_id: messageId,
        },
    });
    if (res.code == 0) { // 0表示成功
        if (res.data.items.length == 1) {
            return res.data.items[0];
        } else {
            utils.logError("Error! Message length not valid: message id: " + messageId + ", length: " + res.data.items.length);
            return null;
        }
    } else {
        utils.logError("Error! Code: " + res.code + ", Msg: " + res.msg);
        return null;
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
