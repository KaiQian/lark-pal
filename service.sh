#!/bin/bash

# 确保 PM2 已经安装
if ! command -v pm2 &> /dev/null
then
    echo "PM2 未安装，正在安装..."
    npm install -g pm2
fi

# 启动应用程序
echo "启动应用程序..."
pm2 start pm2.config.js

# 保存当前的进程列表
echo "保存当前进程列表..."
pm2 save

# 设置 PM2 开机自启
echo "设置 PM2 开机自启..."
pm2 startup ubuntu

# 提示完成
echo "应用已启动并配置为开机自启。"
