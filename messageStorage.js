const fs = require('fs');
const path = require('path');
const config = require('config');
const utils = require('./utils');

const storagePath = path.join(__dirname, 'messages.json');
let messageQueue = [];

function storeMessage() {
    fs.writeFileSync(storagePath, JSON.stringify(messageQueue, null, 4));
}

function addMessage(message) {
    for (let i = 0; i < messageQueue.length; i++) {
        if (messageQueue[i].message_id === message.message_id) {
            utils.logDebug(`Message ${message.message_id} already exists, ignore`);
            return;
        }
    }
    messageQueue.push(message);
    storeMessage();
}

function getLastMessage() {
    return messageQueue[messageQueue.length - 1];
}

function getLatestMessageTime() {
    let latestTime = 0;
    for (let i = messageQueue.length - 1; i >= 0; i--) {
        if (messageQueue[i].time > latestTime) {
            latestTime = messageQueue[i].time;
        }
    }
    return latestTime;
}

function getRecentMessages() {
    let period = config.assistant.messageBatchPeriodDays * 24 * 3600 * 1000; // Convert to milliseconds
    const startTime = Date.now() - period;
    return messageQueue.filter(message => new Date(message.time).getTime() >= startTime);
}

function init() {
    if (fs.existsSync(storagePath)) {
        messageQueue = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } else {
        messageQueue = [];
    }
}

module.exports = { init, addMessage, getLastMessage, getLatestMessageTime, getRecentMessages };