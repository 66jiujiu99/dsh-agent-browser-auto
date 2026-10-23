#!/usr/bin/env bash
# agent-browser-auto 安装后的快速探测：路由是否存在、鉴权栅栏是否生效。
# 用法: bash test/probe.sh [port]
set -u
PORT="${1:-13291}"
BASE="http://127.0.0.1:${PORT}"
echo "== base: ${BASE}"
echo -n "/                       -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/"
echo -n "/agent-browser-auto/hello    -> "; curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "${BASE}/agent-browser-auto/hello"
echo -n "/agent-browser-auto/poll     -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/agent-browser-auto/poll?clientId=x&wait=1"
echo -n "/agent-browser-auto/nothing  -> "; curl -s -o /dev/null -w '%{http_code}\n' "${BASE}/agent-browser-auto/nothing"
echo "（预期：/ 与 /agent-browser-auto/* 都是 401，说明路由存在且鉴权生效；404 说明路由没注册上）"
