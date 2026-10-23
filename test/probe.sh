#!/usr/bin/env bash
# browser-hands 安装后的快速探测：路由是否存在、鉴权栅栏是否生效。
# 用法: bash test/probe.sh [port]
set -u
PORT="${1:-13291}"
BASE="http://127.0.0.1:${PORT}"
echo "== base: ${BASE}"
echo -n "/                       -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/"
echo -n "/browser-hands/hello    -> "; curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "${BASE}/browser-hands/hello"
echo -n "/browser-hands/poll     -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/browser-hands/poll?clientId=x&wait=1"
echo -n "/browser-hands/nothing  -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/browser-hands/nothing"
echo "（预期：/ 与 /browser-hands/* 都是 401，说明路由存在且鉴权生效；404 说明路由没注册上）"
