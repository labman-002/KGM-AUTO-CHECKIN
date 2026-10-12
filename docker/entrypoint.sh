#!/bin/sh
# kgcheckin 容器入口脚本：
# 1. 未直接提供 USERINFO 环境变量时，自动从挂载的凭据文件（USERINFO_FILE）读取；
# 2. exec 执行容器命令（默认：node scheduler.js 定时签到）。
set -e

if [ -z "$USERINFO" ] && [ -n "$USERINFO_FILE" ] && [ -f "$USERINFO_FILE" ]; then
  USERINFO="$(cat "$USERINFO_FILE")"
  export USERINFO
  echo "[entrypoint] 已从 $USERINFO_FILE 读取登录凭据 (USERINFO)"
fi

exec "$@"
