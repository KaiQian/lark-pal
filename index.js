const utils = require('./utils');
const messageStorage = require('./messageStorage');
const messagePointer = require('./messagePointer');
const openAIManager = require('./openAIManager');
const larkManager = require('./larkManager');

utils.init();
messageStorage.init();
messagePointer.init();
openAIManager.init();
larkManager.init();
