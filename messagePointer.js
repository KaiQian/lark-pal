const fs = require('fs');
const path = require('path');

const storagePath = path.join(__dirname, 'messagesPointer.txt');
let lastMessageId;

function store() {
    if (lastMessageId) {
        fs.writeFileSync(storagePath, lastMessageId);
    }
}

function setLastMessageId(messageId) {
    lastMessageId = messageId;
    store();
}

function getLastMessageId() {
    return lastMessageId;
}

function init() {
    if (fs.existsSync(storagePath)) {
        lastMessageId = fs.readFileSync(storagePath, 'utf8');
    }
}

module.exports = { init, setLastMessageId, getLastMessageId };