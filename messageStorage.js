const config = require('config');
const utils = require('./utils');

let messageQueue = [];

function addMessage(message) {
    messageQueue.push(message);
}

function getLastMessage() {
    return messageQueue[messageQueue.length - 1];
}

function getRecentMessages() {
    // The last n days
    let period = config.assistant.messageBatchPeriodDays * 24 * 3600 * 1000; // Convert to milliseconds
    utils.logDebug(`Time from ${config.assistant.messageBatchPeriodDays} days ago: ${period}`);

    // If time from last Sunday is less than the period, use that as the start time
    const now = new Date();
    const nowTimestamp = now.getTime();
    const lastSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 0, 0, 0, 0).getTime();
    const periodFromLastSunday = nowTimestamp - lastSunday;
    utils.logDebug(`Time from last Sunday: ${periodFromLastSunday}`);
    if (periodFromLastSunday < period) {
        period = periodFromLastSunday;
    }

    const startTime = Date.now() - period;
    return messageQueue.filter(message => new Date(message.time).getTime() >= startTime);
}

function init() {
    messageQueue = [];
}

module.exports = { init, addMessage, getLastMessage, getRecentMessages };