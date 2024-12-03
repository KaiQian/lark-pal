const utils = require('./utils');
const messageStorage = require('./messageStorage');
// const wechatyManager = require('./wechatyManager');
const openAIManager = require('./openAIManager');
const larkManager = require('./larkManager');

utils.init();
messageStorage.init();
// wechatyManager.init();
openAIManager.init();
larkManager.init();
