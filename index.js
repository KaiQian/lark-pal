const utils = require('./utils');
const messagePointer = require('./messagePointer');
const openAIManager = require('./openAIManager');
const larkManager = require('./larkManager');

utils.init();
messagePointer.init();
openAIManager.init();
larkManager.init();
