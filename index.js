const utils = require('./utils');
const messageStorage = require('./messageStorage');
const openAIManager = require('./openAIManager');
const larkManager = require('./larkManager');

utils.init();
messageStorage.init();
openAIManager.init();
larkManager.init();
