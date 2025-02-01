const OpenAI = require('openai');
const tiktoken = require("@dqbd/tiktoken");
const config = require('config');
const utils = require('./utils');

let _llms = {}; // llm name -> llm instance
let _llmForModel = {}; // model name -> llm name
let _encoder = null;

/**
 * Retrieves the LLM instance for a given model.
 * @param {string} model - The model name.
 * @returns {Object|null} The LLM instance if available, otherwise null.
 */
function getLLM(model) {
    return _llms[_llmForModel[model]];
}

/**
 * Retrieves information about a specific model.
 * @param {string} model - The model name.
 * @returns {Object|null} The model information if available, otherwise null.
 */
function getModelInfo(model) {
    for (let llm of config.openAI.llms) {
        if (llm.models[model]) {
            return llm.models[model];
        }
    }
    return null;
}

/**
 * Retrieves the currency symbol for a specific model.
 * @param {string} model - The model name.
 * @returns {string|null} The currency symbol if available, otherwise null.
 */
function getCurrencySymbol(model) {
    for (let llm of config.openAI.llms) {
        if (llm.models[model]) {
            return llm.currencySymbol;
        }
    }
    return null;
}
 
/**
 * Retrieves the token count for a 512x512 image for a specific model.
 * @param {string} model - The model name.
 * @returns {number|null} The token count if available, otherwise null.
 */
function getTokenCountForImage512(model) {
    for (let llm of config.openAI.llms) {
        if (llm.models[model]) {
            return llm.tokenCountForImage512;
        }
    }
    return null;
}

/**
 * Checks if a specific model is available.
 * @param {string} model - The model name.
 * @returns {boolean} True if the model is available, otherwise false.
 */
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
    let composedMessages = composeMessages(messages, prompt, model);
    utils.logDebug(`Sending message to ${_llmForModel[model]}: Model ${model}`);
    try {
        const response = await getLLM(model).chat.completions.create({
            model: model,
            messages: composedMessages,
            max_tokens: config.openAI.maxCompletionTokens
        });

        const usage = response.usage;
        let modelInfo = getModelInfo(model);
        if (modelInfo) {
            let inputPrice = modelInfo.inputPrice;
            let outputPrice = modelInfo.outputPrice;
            let cost = (usage.prompt_tokens * inputPrice + usage.completion_tokens * outputPrice) / 1000000;
            let currencySymbol = getCurrencySymbol(model);
            utils.logInfo(`Usage: ${JSON.stringify(usage, null, 4)} Input Price: ${inputPrice}, Output Price: ${outputPrice}, Total Cost: ${currencySymbol}${cost.toFixed(4)}`);
            if (response.choices && response.choices.length > 0) {
                let reply = response.choices[0].message.content;
                return { reply, model, cost, currencySymbol };
            }
        }
    } catch (error) {
        const errorMessage = `Error sending message to OpenAI: ${error.message}`;
        utils.logError(errorMessage);
        throw new Error(errorMessage);
    }
}

/**
 * Composes a list of messages into a format suitable for OpenAI API consumption.
 * @param {Array} messages - An array of message objects to be composed.
 * @param {string} prompt - System prompt.
 * @param {string} model - The model to use for the request.
 * @returns {Array} An array of message objects formatted for OpenAI API.
 */
function composeMessages(messages, prompt, model) {
    const result = [{
        role: 'system',
        content: prompt
    }];
    utils.logDebug(JSON.stringify(result[0]));

    let promptTokens = countTokens(result[0]);
    const maxPromptTokens = config.get('openAI.maxPromptTokens');

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const aiMsg = { role: (message.bot ? 'assistant' : 'user') };
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
            aiMsg.content = [{ type: 'text', text: message.bot ? message.text : prefix + message.text }];
        } else {
            continue;
        }

        let tokens = countTokens(aiMsg, model);
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
 * @param {Object} message - The message object.
 * @param {string} model - The model name.
 * @returns {number} The number of tokens in the message.
 */
function countTokens(message, model) {
    if (!message.content)
        return 0;
    if (typeof (message.content) === 'string')
        return _encoder.encode(message.content).length;
    let count = 0;
    for (let i = 0; i < message.content.length; i++) {
        const content = message.content[i];
        if (content.type === 'text') {
            count += _encoder.encode(content.text).length;
        } else if (content.type === 'image_url') {
            count += getTokenCountForImage512(model);
        }
    }
    return count;
}

/**
 * Initializes the OpenAI manager, setting up LLM instances and encoders.
 */
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
