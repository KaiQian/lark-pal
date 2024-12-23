const OpenAI = require('openai');
const tiktoken = require("@dqbd/tiktoken");
const config = require('config');
const utils = require('./utils');

let _llms = {};
let _llmForModel = {};
let _encoder = null;

function getLLM(model) {
    return _llms[_llmForModel[model]];
}

function getModel(model) {
    for (let llm of config.openAI.llms) {
        if (llm.models[model]) {
            return llm.models[model];
        }
    }
    return null;
}

function getCurrencySymbol(model) {
    for (let llm of config.openAI.llms) {
        if (llm.models[model]) {
            return llm.currencySymbol;
        }
    }
    return null;
}

function isModelAvailable(model) {
    return !!_llmForModel[model];
}

/**
 * Sends a set of messages to the OpenAI API and returns the response.
 * @param {Array} messages - An array of message objects to be sent to OpenAI.
 * @param {string} prompt - System prompt.
 * @param {string} model - The model to use for the request.
 */
async function sendToOpenAI(messages, prompt, model) {
    if (!isModelAvailable(model)) {
        model = config.openAI.model;
    }
    let composedMessages = composeMessages(messages, prompt);
    utils.logDebug(`Sending message to ${_llmForModel[model]}: Model ${model}`);
    const response = await getLLM(model).chat.completions.create({
        model: model,
        messages: composedMessages,
        max_tokens: config.openAI.maxCompletionTokens
    });

    const usage = response.usage;
    let modelInfo = getModel(model);
    if (modelInfo) {
        let inputPrice = modelInfo.inputPrice;
        let outputPrice = modelInfo.outputPrice;
        let price = usage.prompt_tokens * inputPrice / 1000000 + usage.completion_tokens * outputPrice / 1000000;
        let currencySymbol = getCurrencySymbol(model);
        utils.logDebug(`Usage: ${JSON.stringify(usage, null, 4)} Input Price: ${inputPrice}, Output Price: ${outputPrice}, Total Cost: ${currencySymbol}${price.toFixed(4)}`);
    }

    if (response.choices && response.choices.length > 0) {
        let reply = response.choices[0].message.content;
        return reply + "\n\n模型: " + model;
    }
}

/**
 * Composes a list of messages into a format suitable for OpenAI API consumption.
 *
 * @param {Array} messages - An array of message objects to be composed.
 * @param {string} prompt - System prompt.
 * @returns {Array} An array of message objects formatted for OpenAI API.
 *
 * @typedef {Object} Message
 * @property {boolean} bot - Indicates if the message is from the bot.
 * @property {string} sender - The sender of the message.
 * @property {string} text - The text content of the message.
 * @property {string} image - The base64 encoded image content of the message.
 * @property {number} time - The timestamp of the message.
 *
 * @typedef {Object} FormattedMessage
 * @property {string} role - The role of the message sender ('system', 'assistant', or 'user').
 * @property {Array<Object>} content - The content of the message, which can include text and image objects.
 */
function composeMessages(messages, prompt) {
    const result = [{
        role: 'system',
        content: prompt
    }];
    utils.logDebug(JSON.stringify(result[0]));

    let promptTokens = countTokens(result[0]);
    const maxPromptTokens = config.get('openAI.maxPromptTokens');

    for (let i = messages.length-1; i >= 0; i--) {
        const message = messages[i];
        const aiMsg = {role: (message.bot ? 'assistant' : 'user')};
        const timeStr = new Date(message.time).toLocaleString('zh-CN', {
            weekday: 'short', // long, short, narrow
            day: 'numeric', // numeric, 2-digit
            year: 'numeric', // numeric, 2-digit
            month: 'short', // numeric, 2-digit, long, short, narrow
            hour: 'numeric', // numeric, 2-digit
            minute: 'numeric',
            timeZone: 'Asia/Shanghai'
        });
        const prefix = `${timeStr} ${message.sender}: `;

        if (message.image) {
            aiMsg.content = [
                { type: 'text', text: prefix + message.text },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${message.image}` } }
            ];
        } else if (message.text) {
            if (message.bot) {
                aiMsg.content = [{type: 'text', text: message.text}];
            } else {
                aiMsg.content = [{type: 'text', text: prefix + message.text}];
            }
        }

        let tokens = countTokens(aiMsg);
        if (tokens + promptTokens > maxPromptTokens) {
            utils.logDebug(`Prompt token limit reached: ${promptTokens} + ${tokens} > ${maxPromptTokens}, stop at message ${timeStr}`);
            break;
        }
        promptTokens += tokens;
        // insert at index 1, just after the system prompt
        result.splice(1, 0, aiMsg);
    }
    return result;
}

/**
 * Counts the number of tokens in a message.
 * @param {Object} message - The message object containing the content to be tokenized.
 * @param {string|Array} message.content - The content of the message, either a string or an array of objects.
 * @param {string} [message.content[].type] - The type of content, either 'text' or 'image_url'.
 * @param {string} [message.content[].text] - The text content, if the type is 'text'.
 * @returns {number} The number of tokens in the message content.
 */
function countTokens(message) {
    if (typeof (message.content) === 'string') {
        return _encoder.encode(message.content).length;
    }
    let count = 0;
    for (let i= 0; i < message.content.length; i++) {
        const content = message.content[i];
        if (content.type === 'text') {
            count += _encoder.encode(content.text).length;
        } else if (content.type === 'image_url') {
            // assuming images are no larger than 512x512, need to adjust if otherwise
            count += 255;
        }
    }
    return count;
}

function init() {
    for (let llm of config.openAI.llms) {
        _llms[llm.name] = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
        for (let model in llm.models) {
            _llmForModel[model] = llm.name;
        }
    }
    _encoder = tiktoken.get_encoding("cl100k_base");
}

module.exports = { sendToOpenAI, init };