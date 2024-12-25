const lark = require('@larksuiteoapi/node-sdk');
const config = require('config');
const sharp = require('sharp');
const openAIManager = require('./openAIManager');
const utils = require('./utils');
const messageStorage = require('./messageStorage');
const messagePointer = require('./messagePointer');

let client, wsClient;
let chatDesc;

const idleTime = config.get('assistant.idleTimeSeconds') * 1000; // Convert to milliseconds
const INSTANT_DELAY = 3000;
let isCountingDownInstantReplay = false;
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
        disableTokenCache: false
    };
    client = new lark.Client(baseConfig);
    utils.logDebug('Lark client initialized');
    
    chatDesc = await fetchChatDescription();
    utils.logDebug('Fetch chat description: ' + JSON.stringify(chatDesc, null, 4));
    
    utils.logDebug('Fetching messages...');
    let currentTime = Math.floor(Date.now() / 1000);
    let startTime = currentTime - 3600 * 24 * config.assistant.messageBatchPeriodDays;
    let lastestMessageTime = Math.floor(messageStorage.getLatestMessageTime() / 1000);
    if (lastestMessageTime > startTime) startTime = lastestMessageTime;
    let messages = await fetchMessages(currentTime, startTime);
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        await generateMessageSentToOpenAI(message);
    }
    utils.logDebug('Messages fetched: ' + messages.length);
    
    let success = TryTriggerOpenAICall(true);
    utils.logDebug('Instant reply triggered: ' + success);
    
    utils.logDebug('Initializing WebSocket client...');
    wsClient = new lark.WSClient({...baseConfig, loggerLevel: lark.LoggerLevel.debug});
    wsClient.start({
        eventDispatcher: new lark.EventDispatcher({}).register({
            "im.message.receive_v1": handleDispatchedMessage,
            "im.chat.updated_v1": handleDispatchedChatUpdate
        }),
    });
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
        });

        let messages = [];
        if (res.code == 0) {  // 0 indicates success
            for (let i = 0; i < res.data.items.length; i++) {
                messages.push(res.data.items[i]);
            }
            if (res.data.has_more) {
                return messages.concat(await fetchMessages(currentTime, startTime, res.data.page_token));
            } else {
                return messages;
            }
        } else {
            utils.logDebug("Error! Code: " + res.code + ", Msg: " + res.msg);
            return [];
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
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
    try {
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
        let imageData = null;
        switch (message.msg_type) {
            case 'text':
                messageToOpenAI.text = JSON.parse(message.body.content).text;
                break;
            case 'interactive':
                messageToOpenAI.text = JSON.parse(message.body.content).elements[0][0].text;
                break;
            case 'post':
                let post = JSON.parse(message.body.content);
                messageToOpenAI.text = post.title;
                if (post.content) {
                    for (let i = 0; i < post.content.length; i++) {
                        for (let j = 0; j < post.content[i].length; j++) {
                            if (post.content[i][j].tag == 'text') {
                                messageToOpenAI.text += '\n' + post.content[i][j].text;
                            } else if (post.content[i][j].tag == 'a') {
                                messageToOpenAI.text += '\n' + post.content[i][j].text + ': ' + post.content[i][j].href;
                            } else if (post.content[i][j].tag == 'at') {
                                messageToOpenAI.text += '\n' + post.content[i][j].text;
                            } else if (post.content[i][j].tag == 'img') {
                                imageData = await fetchImage(message.message_id, post.content[i][j].image_key);
                                messageToOpenAI.image = "has image"; // temporary
                            }
                        }
                    }
                }
                break;
            case 'image':
                imageData = await fetchImage(message.message_id, JSON.parse(message.body.content).image_key);
                messageToOpenAI.image = "has image"; // temporary
                break;
        }
        utils.logDebug(messageToOpenAI); // print the message object before processing image
        if (imageData) {
            messageToOpenAI.image = imageData; // fulfill the image field, replacing the temporary value
        }
        messageStorage.addMessage(messageToOpenAI);
        return messageToOpenAI;
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

/**
* Triggers an OpenAI call after a specified delay if certain conditions are met.
* @param {boolean} instantReply - Indicates if the reply should be instant.
*/
function TryTriggerOpenAICall(instantReply) {
    let lastMessage = messageStorage.getLastMessage();
    if (!lastMessage) // No messages
        return false;
    if (lastMessage.bot) // Last message was sent by the bot
        return false;
    if (lastMessage.message_id == messagePointer.getLastMessageId()) // Last message has been processed
        return false;
    if (isCountingDownInstantReplay) // Instant reply is already counting down
        return false;

    if (triggerId) {
        clearTimeout(triggerId);
        triggerId = null;
    }
    let delay = idleTime;
    if (instantReply) {
        delay = INSTANT_DELAY;
        isCountingDownInstantReplay = true;
    }
    triggerId = setTimeout(triggerOpenAICall, delay);
    return true;
}

/**
* Asynchronously triggers a call to OpenAI and handles the response.
* This function retrieves recent messages from the message storage, sends them to OpenAI for processing,
* and handles the response by either logging it internally or sending it as a message.
*/
async function triggerOpenAICall() {
    try {
        isCountingDownInstantReplay = false;
        let prompt = config.assistant.systemPrompt;
        let inputModel = config.openAI.model;
        if (config.lark.useChatDesc) {
            if (chatDesc.prompt) {
                prompt += '\n' + chatDesc.prompt;
            }
            if (chatDesc.model) {
                inputModel = chatDesc.model;
            }
        }
        let {reply, model, cost, currencySymbol} = await openAIManager.sendToOpenAI(messageStorage.getRecentMessages(), prompt, inputModel);
        if (reply) {
            if (reply.startsWith('[x]')) {
                utils.logInfo(`[Internal] ${reply}`);
            } else {
                utils.logInfo(`Sending message: ${reply}`);
                reply = reply.replace(/\n/g, '\\n');
                // reply += `\\n\\n模型: ${model}, 费用: ${currencySymbol}${cost.toFixed(4)}`;
                let res = await sendMessage(reply);
                if (res.code == 0) {
                    utils.logDebug('Message sent successfully');
                } else {
                    utils.logDebug('Failed to send message: ' + res.code + ', ' + res.msg + ', ' + JSON.stringify(res.data));
                }
            }
            messagePointer.setLastMessageId(messageStorage.getLastMessage().message_id);
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

/**
* Processes the chat description to extract the prompt and model.
* @param {string} chatDesc - The chat description in JSON string format.
* @returns {Object} An object containing the prompt and model.
*/
function processChatDesc(chatDesc) {
    let description;
    try {
        description = JSON.parse(chatDesc);
    } catch (e) {
        description = {"prompt": chatDesc};
    }
    return description;
}

/**
 * Handles the dispatched chat update event.
 * @param {Object} data - The data object containing chat update information.
 * @param {string} data.chat_id - The ID of the chat.
 * @param {Object} [data.after_change] - The object containing changes after the update.
 * @param {string} [data.after_change.description] - The new description of the chat.
 */
async function handleDispatchedChatUpdate(data) {
    try {
        utils.logDebug("Handling dispatched chat update: " + JSON.stringify(data, null, 4));
        if (data.chat_id != config.lark.chatId) return;
        if (data.after_change && data.after_change.description) {
            chatDesc = processChatDesc(data.after_change.description);
            utils.logInfo("Chat description updated: " + data.after_change.description);
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
    }
}

/**
 * Fetches the description of a chat from the Lark API.
 * @returns {Promise<string|null>} The description of the chat if successful, otherwise null.
 */
async function fetchChatDescription() {
    try {
        let res = await client.im.chat.get({
                path: {
                    chat_id: config.lark.chatId
                }
            }
        );
        if (res.code == 0) {
            return processChatDesc(res.data.description);
        } else {
            utils.logError("Error! Code: " + res.code + ", Msg: " + res.msg);
            return null;
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
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
    try {
        utils.logDebug("Handling dispatched message: " + JSON.stringify(data, null, 4));
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
        
        let messages = await fetchAMessage(data.message.message_id);
        if (messages) {
            for (let i = 0; i < messages.length; i++) {
                let message = messages[i];
                utils.logInfo("Full message information: \n" + JSON.stringify(message, null, 4));
                await generateMessageSentToOpenAI(message);
            }
            TryTriggerOpenAICall(mentionSelf);
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
    }
}

/**
* Fetches a message by its ID.
* @param {string} messageId - The ID of the message to fetch.
*/
async function fetchAMessage(messageId) {
    try {
        let res = await client.im.message.get({
            path: {
                message_id: messageId,
            },
        });
        if (res.code == 0) { // 0表示成功
            return res.data.items;
        } else {
            utils.logError("Error! Code: " + res.code + ", Msg: " + res.msg);
            return null;
        }
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

/**
* Fetches the sender information for a given user ID.
* @param {string} userId - The ID of the user to fetch information for.
*/
async function fetchSenderInfo(userId) {
    try {
        let res = await client.contact.user.get({
            path: {
                user_id: userId
            },
            params: {
                user_id_type: 'open_id',
                department_id_type: 'open_department_id'
            }
        });
        return res;
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

/**
* Fetches an image from a message resource.
* @param {string} messageId - The ID of the message containing the image.
* @param {string} imageKey - The key of the image file.
*/
async function fetchImage(messageId, imageKey) {
    try {
        return await new Promise(async (resolve) => {
            let res = await client.im.messageResource.get({
                path: {
                    message_id: messageId,
                    file_key: imageKey,
                },
                params: {
                    type: "image",
                },
            });
            let stream = res.getReadableStream();
            let chunks = [];
            stream.on('data', (chunk) => {
                chunks.push(chunk);
            });
            stream.on('end', async () => {
                const binaryContent = Buffer.concat(chunks);
                let dimension = 512;
                const resizedBuffer = await sharp(binaryContent).resize({ width: dimension, height: dimension, fit: sharp.fit.inside, withoutEnlargement: true }).jpeg().toBuffer();
                const base64Data = resizedBuffer.toString('base64');
                resolve(base64Data);
            });
        });
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

/**
* Sends a message to a specified chat in Lark.
* @param {string} message - The message to be sent.
*/
async function sendMessage(message) {
    try {
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
    } catch (e) {
        utils.logDebug("Error! " + JSON.stringify(e, null, 4) + "\n" + e.stack);
        return null;
    }
}

module.exports = { init };
