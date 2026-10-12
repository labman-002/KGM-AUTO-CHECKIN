# 酷狗概念版签到
【对齐上游 KuGouMusicApi v1.6.2】

自动领取 `酷狗概念VIP`，每天领取总计 `两天酷狗概念VIP`

支持两种部署方式：

- **Docker 部署（推荐）**：部署到自己的服务器 / NAS，内置定时调度 + **WebUI 控制台**（扫码登录 / 手机号登录 / 一键签到 / 账号管理），无需 GitHub Actions（见下方 [Docker 部署](#docker-部署)）
- **GitHub Actions 部署**：Fork 本仓库白嫖 Actions，每天定时签到（见下方折叠的部署教程）

登录后即可使用，目前提供二维码登录(推荐)和手机号登录(一个手机号绑定多个账号无法登录，见 [多账号登录问题](https://github.com/MakcRe/KuGouMusicApi/issues/51))

## 免责声明

> [!important]
>
> 1. 本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途!
> 2. 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24小时内清除使用本项目的过程中所产生的版权数据。
> 3. 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 音乐平台不易，请尊重版权，支持正版。
> 6. 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
> 7. 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。

## 使用说明

> [!warning]
> **注意事项**
> 
> 若登录后听歌领取失败，请到APP 活动中心->天天签到领VIP(这个活动新用户好像没有) 查看当日是否已经领取VIP。

> [!CAUTION]
> **常见错误**：
> 
> 执行签到报错未配置，为`PAT`秘钥权限设置问题，需正确设置`PAT Secret`权限并再次执行登录，**Repository secrets**处除了配置的**PAT Secret**外，成功写入**USERINFO**即可正常执行签到
> 
> **即 先确保权限无误`Only select Repository`仅选中所需仓库**
> 
> **权限①：`Metadata` 保持只读**
> 
> **权限②：`Secrets` 设置为读写**
> 
> **在仓库`Settings`设置`PAT Secret`，再执行登录 确保`Secrets and variables` - `Actions`中成功写入`USERINFO`再执行签到**

$${\color{red}避免将PAT秘钥复制于Windows记事本中，可能存在的字号字体问题会导致秘钥中所有下划线消失导致秘钥出错}$$

## Docker 部署

在任意一台服务器 / NAS（能访问外网即可）上用 Docker 常驻运行，容器内置定时调度，**每天北京时间 01:10 自动签到**，不依赖 GitHub Actions 与 GitHub Secret。

### 1. 获取代码

```bash
git clone <本仓库地址> kgcheckin
cd kgcheckin
```

### 2. 构建并启动

```bash
docker compose up -d --build
docker compose logs -f        # 查看日志，Ctrl+C 退出（容器继续运行）
```

容器启动后同时具备 **WebUI 控制台 + 定时自动签到**，无需任何其他配置。

### 3. WebUI 控制台（推荐）

浏览器打开 `http://<服务器IP>:3000`，即可使用终端风格的可视化控制台：

| 功能 | 说明 |
|------|------|
| **扫码登录** | 选择账号数量 → 生成二维码 → 酷狗音乐 APP 扫码确认，凭据自动保存；多账号并行轮询扫码状态 |
| **手机号登录** | 输入手机号发送验证码（60s 冷却）→ 输入验证码一键登录 |
| **一键签到** | 点击立即执行签到，实时彩色终端输出（与 Actions 运行日志一致），签到结束显示退出码 |
| **账号管理** | 查看/删除已登录账号（userid 脱敏显示），展示定时任务与下次执行时间 |

> - 公网暴露时，请在 `.env` 中设置 `WEBUI_PASSWORD`（参考 `.env.example`）开启访问密码
> - 通知渠道密钥同样建议写在 `.env`（自动注入容器，不会被提交到仓库）

### 4. 命令行登录（可选）

不想用 WebUI 时也可以纯命令行完成登录：

**方式一：二维码登录（推荐）**

```bash
# 第 1 步：生成登录二维码
docker compose run --rm kgcheckin node qrcodeLogin.js gen
# 第 2 步：用浏览器打开 data/qr/login.html，使用「酷狗音乐 APP」扫码并确认（二维码有效期约 2 分钟）
# 第 3 步：等待扫码结果并保存凭据
docker compose run --rm kgcheckin node qrcodeLogin.js wait
```

看到「登录成功」后，凭据已自动保存到 `data/userinfo.json`。

> 多账号追加：重新执行上面 3 步即可；`wait` 一步加参数 `-e APPEND_USER=是`，例如
> `docker compose run --rm -e APPEND_USER=是 kgcheckin node qrcodeLogin.js wait`（追加保留已有账号，仅更新/新增）

**方式二：手机号登录**

```bash
# 发送验证码
docker compose run --rm -e PHONE=138xxxxxxxx kgcheckin npm run sent
# 提交验证码完成登录
docker compose run --rm -e PHONE=138xxxxxxxx -e CODE=123456 kgcheckin npm run phoneLogin
```

### 4. 完成

登录完成后容器即按计划自动签到（默认每天北京时间 01:10），无需其他配置。也可以在 WebUI 点击「立即签到」手动验证：

```bash
docker compose run --rm kgcheckin node scheduler.js once   # 或命令行方式立即签到一次
```

### 4.1 已有 USERINFO？（从 Actions 迁移）

如果之前在 GitHub Actions 使用过，可直接把 Secret `USERINFO` 的内容贴到 `docker-compose.yml` 的 `USERINFO` 环境变量中，跳过第 3 步登录。

### 配置说明（docker-compose.yml `environment`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEBUI_PORT` | `3000` | WebUI 控制台监听端口 |
| `WEBUI_PASSWORD` | - | 可选访问密码；设置后所有 API 需携带密钥（公网暴露时建议设置，写在 `.env` 中） |
| `CRON_SCHEDULE` | `10 1 * * *` | 签到计划任务（cron 表达式），默认每天北京时间 01:10 |
| `CRON_TIMEZONE` | `Asia/Shanghai` | 调度器使用的时区 |
| `RUN_ON_STARTUP` | `false` | 设为 `true` 时容器启动后立即执行一次签到 |
| `USERINFO` | - | 登录凭据（JSON 数组），与 Actions 的 Secret 格式一致；与凭据文件二选一 |
| `USERINFO_FILE` | `/app/data/userinfo.json` | 凭据文件路径（位于挂载卷内，勿改）；入口脚本会自动读取并作为 `USERINFO` 注入 |
| 通知渠道变量 | - | `WECOM_BOT_KEY`、`DINGTALK_BOT_KEY`、`FEISHU_BOT_KEY`、`TG_BOT_TOKEN` 等，与下文 Actions 通知 Secret 同名，建议写在 `.env` 中 |
| `PAT` + `GITHUB_REPOSITORY` | - | 可选。仅当还想把每周刷新的 token 同步回 GitHub 仓库 Secret 时才需要 |

### 数据与安全

- 挂载卷 `./data/` 存放登录凭据（`userinfo.json`）和登录二维码，**请妥善保管，不要提交到仓库**（已加入 `.gitignore`）
- 通知密钥、WebUI 密码等私密配置写在 `.env` 文件（已被 `.gitignore` 忽略，模板见 `.env.example`），**不要直接写进 docker-compose.yml 提交**
- 每周日签到时候酷狗 token 会自动刷新并**写回 `data/userinfo.json`**，凭据长期有效，无需手动维护
- 日期/星期计算固定按北京时间处理，与容器 `TZ` 无关；调度时区由 `CRON_TIMEZONE` 控制
- 首次 `up` 后若报权限错误，执行 `sudo chown -R 1000:1000 ./data`（容器以 uid 1000 运行）后重启

### 常用命令速查

```bash
docker compose up -d --build                                # 构建/更新并启动
docker compose logs -f --tail 100                           # 跟踪日志
docker compose down                                         # 停止并删除容器
# WebUI 控制台: http://localhost:3000 （扫码登录 / 手机号登录 / 一键签到 / 账号管理）
docker compose run --rm kgcheckin node scheduler.js once    # 命令行方式手动立即签到
docker compose run --rm kgcheckin node scheduler.js next    # 预览接下来 3 次签到时间
docker compose run --rm kgcheckin node qrcodeLogin.js gen   # 命令行生成登录二维码
docker compose run --rm kgcheckin node qrcodeLogin.js wait  # 命令行等待扫码保存凭据
docker compose pull && docker compose up -d --build         # 拉取新代码后更新
```

<details>

<summary>⚠️Github Actions部署教程(点击展开)⚠️</summary>

1. Fork 本仓库

1. 创建添加令牌
   - **创建令牌**  
     复制下方官网链接，在浏览器中打开

     ```html copy
     https://github.com/settings/personal-access-tokens/new
     ```

   - **登录 GitHub 官网**  
     若登陆后未跳转至token生成页，请再次粘贴链接进行访问
   - **在设置页面配置权限**  
      **Token name 备注**：随意填写
      **Expiration (有效期)**：建议自定义有效期，长期无人维护时不要选择过长
      **Repository access (仓库范围)**：只选择当前 fork 的仓库
      **Repository permissions (仓库权限)**：`Metadata` 保持只读，`Secrets` 设置为读写
      ![精细化个人访问令牌权限](imgs/精细化个人访问令牌权限.png)
   - 滑动到底部，点击绿色的 Generate token 保存按钮
   - 复制生成的字符串，回到本仓库添加到[Secret](https://github.com/qfmc7040/KGM-AUTO-CHECKIN#secret-%E4%BD%8D%E7%BD%AE)，变量名 `PAT`，value 为复制的令牌

1. 登录（两种独立的登录方式，任选其一）

   3.1 二维码登录(推荐)

   运行 Actions `二维码登录`，点击 Run → 在运行摘要页面（Summary）查看二维码图片，使用酷狗音乐 APP 扫码并确认登录即可。

   3.2 手机号登录

   添加手机号到 Secret `PHONE`，运行 Actions `手机号登录`，操作步骤选择「发送验证码」获取验证码，把验证码添加到 Secret `CODE`；再次运行 Actions `手机号登录`，操作步骤选择「登录」即可。

   ⬆️ $${\color{red}与上文给仓库添加PAT秘钥同一位置}$$ ⬆️

1. 启用 Actions `签到`，每天北京时间 01:10 自动签到（可在 `签到.yml` 中设置 cron）。启用 Actions `仓库保活` 以保证签到可以长期执行。

1. （可选）配置运行结果通知

   在仓库 Settings → Secrets and variables → Actions 中添加对应渠道的 Secret，签到完成后将自动推送结果通知。支持以下渠道（全部可选，配置多个将同时发送）：

   | 通知渠道 | Secret 变量名 | 说明 |
   |---------|-------------|------|
   | 企业微信机器人 | `WECOM_BOT_KEY` | 企业微信群机器人 webhook 的 key |
   | 钉钉机器人 | `DINGTALK_BOT_KEY` | 钉钉机器人 access_token |
   | 钉钉加签 | `DINGTALK_SECRET` | 钉钉机器人加签密钥（可选） |
   | 飞书机器人 | `FEISHU_BOT_KEY` | 飞书自定义机器人 webhook 的 key |
   | 云湖机器人 | `YUNHU_BOT_KEY` | 云湖机器人 webhook 的 key |
   | Server酱 | `SERVERCHAN_SENDKEY` | Server酱 SendKey |
   | PushPlus | `PUSHPLUS_TOKEN` | PushPlus token |
   | PushPlus群组 | `PUSHPLUS_TOPIC` | PushPlus 群组编码（可选） |
   | Telegram | `TG_BOT_TOKEN` | Telegram Bot Token |
   | Telegram | `TG_CHAT_ID` | Telegram 接收消息的 Chat ID |
   | Bark (iOS) | `BARK_KEY` | Bark key 或完整 URL |
   | Bark分组 | `BARK_GROUP` | Bark 消息分组（可选） |
   | Discord | `DISCORD_WEBHOOK` | Discord Webhook 完整 URL |
   | 邮箱 SMTP | `MAIL_HOST` | SMTP 服务器地址（如 `smtp.qq.com`） |
   | 邮箱 SMTP | `MAIL_PORT` | SMTP 端口（默认 465） |
   | 邮箱 SMTP | `MAIL_USER` | 发件邮箱账号 |
   | 邮箱 SMTP | `MAIL_PASS` | 发件邮箱授权码（非登录密码） |
   | 邮箱 SMTP | `MAIL_TO` | 收件邮箱地址 |

   通知内容包含：运行日期、账号数量、成功/失败统计、各账号听歌领取状态、VIP 领取次数、VIP 到期时间、错误信息等。

API源代码来自 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) ~~图省事直接搬来~~

## 令牌（Token）机制说明

项目中包含两类令牌：

1. **GitHub Personal Access Token (PAT)**：用于自动将酷狗登录信息写入仓库 Secret `USERINFO`，以及每周日自动刷新酷狗登录 Token。

2. **酷狗登录 Token**：存储在 `USERINFO` Secret 中，用于酷狗 API 身份认证。通过登录获取，每周日自动刷新。

## Secret 位置

  ### 步骤一
   
   ![步骤一](./imgs/步骤一.jpg)
  ### 步骤二
   
   ![步骤二](./imgs/步骤二.jpg)
  ### 步骤三
   
   ![步骤三](./imgs/步骤三.jpg)
  ### 步骤四
   
   ![步骤四](./imgs/步骤四.jpg)

</details>

## 致谢

- 感谢 [@MakcRe](https://github.com/MakcRe) 提供 API 源代码
- 感谢 [@itfw](https://github.com/itfw) 提供二维码显示问题的解决方案
- 感谢 [@klaas8](https://github.com/klaas8) 提供自动写入secret的方法
- 感谢 [@develop202](https://github.com/develop202/kgcheckin) 原项目
