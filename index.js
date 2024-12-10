const utils = require('./utils');
const messagePointer = require('./messagePointer');
const messageStorage = require('./messageStorage');
const openAIManager = require('./openAIManager');
const larkManager = require('./larkManager');

utils.init();
messagePointer.init();
messageStorage.init();
openAIManager.init();
larkManager.init();
