module.exports = {
    apps: [{
        name: "lark-pal",
        script: "./index.js",
        cwd: "./",
        log_file: "./logs/pm2.log",
        restart_delay: 10000
    }, {
        name: "lark-pal-log-watcher",
        script: "./log-watcher.js",
        cwd: "./",
        log_file: "./logs/log-watcher.log",
        restart_delay: 1000,
        env: {}
    }]
}