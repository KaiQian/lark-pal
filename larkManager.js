// node-sdk使用说明：https://github.com/larksuite/node-sdk/blob/main/README.zh.md
const lark = require('@larksuiteoapi/node-sdk');
const config = require('config');
const schedule = require('node-schedule');

var client;
var messages;

function init() {
    client = new lark.Client({
        appId: config.lark.appId,
        appSecret: config.lark.appSecret,
        // disableTokenCache为true时，SDK不会主动拉取并缓存token，这时需要在发起请求时，调用lark.withTenantToken("token")手动传递
        // disableTokenCache为false时，SDK会自动管理租户token的获取与刷新，无需使用lark.withTenantToken("token")手动传递token
        disableTokenCache: false
    });
    console.log('Lark manager initialized');

    // let rule = new schedule.RecurrenceRule();
    // rule.second = 0;
    // rule.minute = [0, 10, 20, 30, 40, 50];
    // schedule.scheduleJob(rule, () => {
    //     console.log(new Date());
    //     this.fetchMessages();
    // });

    fetchAllMessages((messages) => {
        console.log('Messages fetched: ' + messages.length);
        for (let i = 0; i < messages.length; i++) {
            processMessage(messages[i]);
        }
    });
}

function fetchAllMessages(handleMessage) {
    messages = [];
    let currentTime = Math.floor(Date.now() / 1000);
    let startTime = currentTime - 3600 * 24 * 30; // 8 days ago
    fetchMessages(handleMessage, currentTime, startTime);
}

function fetchMessages(handleMessage, currentTime, startTime, pageToken) {
    console.log('Fetching messages from Lark...');
    client.im.message.list({
            params: {
                container_id_type: 'chat',
                container_id: config.lark.chatId,
                start_time: startTime.toString(),
                end_time: currentTime.toString(),
                sort_type: 'ByCreateTimeAsc',
                page_size: 10,
                page_token: pageToken,
            },
        }
    ).then(res => {
        if (res.code == 0) { // 0表示成功
            for (let i = 0; i < res.data.items.length; i++) {
                messages.push(res.data.items[i]);
            }
            if (res.data.has_more) {
                fetchMessages(handleMessage, currentTime, startTime, res.data.page_token);
            } else {
                if (handleMessage) {
                    handleMessage(messages);
                }
            }
        } else {
            console.log("Error! Code: " + res.code + ", Msg: " + res.msg);
        }
    }).catch(e => {
        console.error(JSON.stringify(e.response.data, null, 4));
    });
}

function processMessage(message) {
    console.log(message.message_id);
    // messageStorage.addMessage({ bot: message.self(), sender: from.name(), time: message.date(), text });
}

module.exports = { init, fetchAllMessages };
