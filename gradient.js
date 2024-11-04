const fs = require('fs');
const path = require('path');
const randomUseragent = require('random-useragent');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline');

puppeteer.use(StealthPlugin());

// 用于存储所有已启动的浏览器实例
const browsers = [];
const logs = [];  // 用于存储日志信息

// 捕获 Ctrl+C 信号并关闭所有浏览器实例
process.on('SIGINT', async () => {
    console.log("\n正在关闭所有浏览器实例...");
    for (const browser of browsers) {
        await browser.browser.close();
    }
    console.log("所有浏览器实例已关闭，退出脚本。");
    process.exit();
});

// 日志记录函数，添加到内存日志中
function log(userIndex, message) {
    const timestamp = getCurrentTime();
    const logMessage = `[${timestamp}] [User ${userIndex + 1}] ${message}`;
    logs.push(logMessage);
    console.log(logMessage);
}

// 格式化当前时间的函数
function getCurrentTime() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').split('.')[0]; // 形如 "YYYY-MM-DD HH:MM:SS"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 从文件中读取代理信息并解析，包括 IP、端口、用户名和密码
function loadProxies(filePath) {
    const proxies = [];
    const data = fs.readFileSync(filePath, 'utf-8').split('\n');
    data.forEach(line => {
        const [ip, port, username, password] = line.trim().split(':');
        if (ip && port) {
            proxies.push({ ip, port, username, password });
        }
    });
    return proxies;
}

// 从文件中读取用户名和密码
function loadCredentials(filePath) {
    const credentials = [];
    const data = fs.readFileSync(filePath, 'utf-8').split('\n');
    data.forEach(line => {
        const [username, password] = line.trim().split(':');
        if (username && password) {
            credentials.push({ username, password });
        }
    });
    return credentials;
}

async function launch(userIndex, userDataDir, proxy, userCredentials, debuggingPort) {
    const extensionPath = path.resolve('extension');
    const pemPath = path.resolve('1.0.13_0.pem');
    const proxyUrl = `http://${proxy.ip}:${proxy.port}`;

    log(userIndex, `启动浏览器，用户数据目录: ${userDataDir}, 代理: ${proxyUrl}, 调试端口: ${debuggingPort}`);
    
    let browser;
    let retryCount = 0;
    const maxRetries = 3;  // 设置最大重试次数

    while (retryCount < maxRetries) {
        try {
            browser = await puppeteer.launch({
                headless: "new",  // 启用无头模式
                ignoreHTTPSErrors: true,
                userDataDir: userDataDir,
                args: [
                    `--no-sandbox`,
                    `--disable-extensions-except=${extensionPath}`,
                    `--load-extension=${extensionPath}`,
                    `--ignore-certificate-errors=${pemPath}`,
                    `--proxy-server=${proxyUrl}`,
                    `--remote-debugging-port=${debuggingPort}`, // 为每个实例分配唯一的调试端口
                ],
            });
            browsers.push({ userIndex, browser });  // 将浏览器实例添加到全局数组中
            log(userIndex, `浏览器启动成功，用户数据目录: ${userDataDir}`);
            break;  // 如果启动成功，跳出循环
        } catch (e) {
            retryCount++;
            log(userIndex, `代理连接失败，重试 ${retryCount} / ${maxRetries}: ${e.message}`);
            if (retryCount >= maxRetries) {
                log(userIndex, `代理 ${proxy.ip}:${proxy.port} 无法连接，跳过此代理。`);
                return false;  // 返回 false 表示代理不可用
            }
            await sleep(2000);  // 等待 2 秒再重试
        }
    }

    try {
        await sleep(5000);

        const page = await browser.newPage();
        log(userIndex, `新页面创建成功，用户数据目录: ${userDataDir}`);

        if (proxy.username && proxy.password) {
            await page.authenticate({
                username: proxy.username,
                password: proxy.password,
            });
            log(userIndex, `设置代理身份验证，用户名: ${proxy.username}`);
        }

        const randomUserAgent = randomUseragent.getRandom();
        await page.setUserAgent(randomUserAgent);
        log(userIndex, `使用用户代理: ${randomUserAgent}`);

        // 访问目标网页
        const url = 'https://app.gradient.network/';
        log(userIndex, `正在导航到 ${url}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        log(userIndex, `页面加载成功，用户数据目录: ${userDataDir}`);

        // 输入邮箱和密码并提交表单
        const emailSelector = 'input[placeholder="Enter Email"]';
        const passwordSelector = 'input[placeholder="Enter Password"]';

        const emailInput = await page.waitForSelector(emailSelector, { timeout: 5000 });
        if (emailInput) {
            await emailInput.type(userCredentials.username);
            log(userIndex, `在邮箱输入框中输入: ${userCredentials.username}`);
        } else {
            log(userIndex, "找不到邮箱输入框。");
        }

        const passwordInput = await page.waitForSelector(passwordSelector, { timeout: 5000 });
        if (passwordInput) {
            await passwordInput.type(userCredentials.password);
            log(userIndex, `在密码输入框中输入: ${userCredentials.password}`);
            await passwordInput.press('Enter');
            log(userIndex, "提交登录表单。");
        } else {
            log(userIndex, "找不到密码输入框。");
        }

        return true;  // 返回 true 表示代理成功使用并完成登录
    } catch (e) {
        log(userIndex, `运行中遇到错误: ${e.message}`);
        return false;  // 返回 false 表示代理不可用
    }
}

async function run(userIndex, proxyRange, proxies, credentials) {
    const baseUserDataDir = path.resolve('USERDATA');
    const userCredentials = credentials[userIndex];
    log(userIndex, `凭据: ${userCredentials.username}:${userCredentials.password}`);

    // 解析代理范围
    const [start, end] = proxyRange.split('-').map(Number);
    if (isNaN(start) || isNaN(end) || start < 1 || end > proxies.length || start > end) {
        console.log(`无效的代理范围：${proxyRange}。请确保输入的范围在有效范围内，并且格式正确，例如 "5-10"。`);
        mainMenu();
        return;
    }

    const selectedProxies = proxies.slice(start - 1, end); // 选择范围内的代理
    log(userIndex, `选择的代理范围：第 ${start} 到第 ${end} 个代理`);

    let usedProxyCount = 0;

    for (const [index, proxy] of selectedProxies.entries()) {
        const userDataDir = path.join(baseUserDataDir, `user_${userIndex}`, `proxy_${start + index}`);
        fs.mkdirSync(userDataDir, { recursive: true });

        const debuggingPort = 11500 + start + index;  // 为每个代理实例分配唯一的调试端口
        log(userIndex, `尝试使用代理: ${proxy.ip}:${proxy.port}`);

        const isSuccessful = await launch(userIndex, userDataDir, proxy, userCredentials, debuggingPort);
        if (isSuccessful) {
            usedProxyCount++;
        } else {
            log(userIndex, `代理 ${proxy.ip}:${proxy.port} 不可用，跳过`);
        }
    }

    if (usedProxyCount < selectedProxies.length) {
        log(userIndex, `警告: 仅找到 ${usedProxyCount} 个有效代理，未达到指定数量 ${selectedProxies.length}`);
    }

    console.log("所有实例启动完毕。");
    mainMenu();  // 在所有实例启动完成后返回菜单
}

// 读取用户输入
function mainMenu() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("\n菜单选项：");
    console.log("1. 启动用户实例");
    console.log("2. 查看日志");
    console.log("3. 检查所有浏览器状态");
    console.log("4. 结束特定用户的实例");
    console.log("0. 退出");

    rl.question("请选择一个选项: ", (option) => {
        switch (option) {
            case '1':
                rl.question('请输入要运行的用户编号（例如：1 或 2）：', (userInput) => {
                    rl.question('请输入要使用的代理范围（例如：5-10）：', (proxyRange) => {
                        const userIndex = parseInt(userInput) - 1;

                        if (isNaN(userIndex) || !/^\d+-\d+$/.test(proxyRange)) {
                            console.log("请输入有效的用户编号和代理范围，范围格式如 \"5-10\"");
                            rl.close();
                            mainMenu();
                        } else {
                            const proxies = loadProxies('proxies.txt');
                            const credentials = loadCredentials('credentials.txt');
                            if (proxies.length === 0 || credentials.length === 0 || userIndex >= credentials.length) {
                                console.log("代理或凭据不足，请检查文件内容。");
                                rl.close();
                                mainMenu();
                            } else {
                                run(userIndex, proxyRange, proxies, credentials);
                            }
                        }
                    });
                });
                break;
            case '2':
                console.log("\n---- 日志 ----");
                logs.forEach(log => console.log(log));
                rl.close();
                mainMenu();
                break;
            case '3':
                console.log("\n检查所有浏览器状态：");
                browsers.forEach(({ userIndex, browser }) => {
                    const status = browser.isConnected() ? "运行中" : "已断开";
                    console.log(`[User ${userIndex + 1}] 浏览器状态: ${status}`);
                });
                rl.close();
                mainMenu();
                break;
            case '4':
                rl.question('请输入要结束的用户编号（例如：1 或 2）：', (userInput) => {
                    const userIndex = parseInt(userInput) - 1;

                    const browserInstance = browsers.find(b => b.userIndex === userIndex);
                    if (browserInstance && browserInstance.browser.isConnected()) {
                        browserInstance.browser.close().then(() => {
                            console.log(`[User ${userIndex + 1}] 浏览器实例已关闭。`);
                        });
                    } else {
                        console.log(`[User ${userIndex + 1}] 没有正在运行的浏览器实例或已关闭。`);
                    }

                    rl.close();
                    mainMenu();
                });
                break;
            case '0':
                console.log("退出程序...");
                rl.close();
                process.exit();
                break;
            default:
                console.log("无效选项，请重新选择。");
                rl.close();
                mainMenu();
                break;
        }
    });
}

// 启动主菜单
mainMenu();
