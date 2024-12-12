const config = require('config');

let messageQueue = [];

function addMessage(message) {
    messageQueue.push(message);
}

function getLastMessage() {
    return messageQueue[messageQueue.length - 1];
}

function getRecentMessages() {
    const period = config.get('assistant.messageBatchPeriodDays') * 24 * 3600 * 1000; // Convert to milliseconds
    const startTime = Date.now() - period;
    return messageQueue.filter(message => new Date(message.time).getTime() >= startTime);
}

function init() {
    messageQueue = [];
}

module.exports = { init, addMessage, getLastMessage, getRecentMessages };