#!/usr/bin/env bash
# 验证 WorkBuddy fork 补丁是否完整生效
# 用法: bash /vol2/1000/AI Workzone/dsh-llm-workbuddy-fork/verify.sh

D="$HOME/.dsh/profiles/web/node_modules/@leomon1993/dsh-llm-workbuddy"
ok=0
fail=0

check() {
  local label="$1" found="$2"
  if [ "$found" -ge 1 ] 2>/dev/null; then
    printf "  ✅ %-28s\n" "$label"
    ok=$((ok + 1))
  else
    printf "  ❌ %-28s\n" "$label"
    fail=$((fail + 1))
  fi
}

echo "=== 1. 插件目录 ==="
if [ -d "$D" ]; then
  echo "  ✅ 目录存在: $D"
  echo "  package name: $(node -e 'console.log(require(process.argv[1]).name+"@"+require(process.argv[1]).version)' "$D/package.json" 2>/dev/null)"
else
  echo "  ❌ 目录不存在 — 需要 pnpm install --force"
  exit 1
fi

echo
echo "=== 2. 三项补丁 ==="
check "倍率后缀 (raw.credits)"     "$(grep -c 'raw\.credits' "$D/index.js" 2>/dev/null)"
check "MODELS_URL 端点"            "$(grep -c 'enterprises/personal/models' "$D/index.js" 2>/dev/null)"
check "createLoginSession 弹窗登录" "$(grep -c 'createLoginSession' "$D/workbuddy-auth.js" 2>/dev/null)"
check "login-start 路由"           "$(grep -c 'login-start' "$D/workbuddy-web.js" 2>/dev/null)"
check "隧道来源放行"               "$(grep -c 'allow all origins' "$D/workbuddy-web.js" 2>/dev/null)"

echo
echo "=== 3. 语法 ==="
for f in index.js client.js workbuddy-auth.js workbuddy-web.js workbuddy-credits.js cli.js; do
  if node --check "$D/$f" 2>/dev/null; then
    printf "  ✅ %s\n" "$f"
    ok=$((ok + 1))
  else
    printf "  ❌ %s\n" "$f"
    fail=$((fail + 1))
  fi
done

echo
echo "=== 4. 自引用指向 fork（不能是上游）==="
if grep -rq "@axiaohungry" "$D/index.js" "$D/client.js" "$D/cli.js" "$D/cordis.patch.yml" 2>/dev/null; then
  echo "  ❌ 仍存在 @axiaohungry 自引用"
  fail=$((fail + 1))
else
  echo "  ✅ 无上游自引用"
  ok=$((ok + 1))
fi

echo
echo "=== 5. 旧残留检查 ==="
[ -d "$HOME/.dsh/profiles/web/node_modules/@axiaohungry/dsh-llm-workbuddy" ] \
  && { echo "  ⚠️  上游包目录仍存在"; } \
  || { echo "  ✅ 上游包已移除"; ok=$((ok + 1)); }
[ -d "$HOME/.dsh/profiles/web/node_modules/@local" ] \
  && { echo "  ⚠️  @local link 包仍存在"; } \
  || { echo "  ✅ @local 已清理"; ok=$((ok + 1)); }
crontab -l 2>/dev/null | grep -q "workbuddy-patch-guard" \
  && { echo "  ⚠️  cron 守护仍在"; } \
  || { echo "  ✅ cron 守护已移除"; ok=$((ok + 1)); }

echo
echo "=== 6. 倍率输出模拟 ==="
node --input-type=module -e '
const fs = await import("fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/name: text\(raw\.name[\s\S]*?\}\)\(\),/);
if (!m) { console.log("  ❌ 未找到倍率逻辑"); process.exit(0); }
const text = (...v) => v.find(x => typeof x === "string" && x.length > 0);
const fn = new Function("raw","fallback","id","text","return " + m[0].replace(/name:\s*/,"").replace(/,$/,""));
for (const c of [{name:"DeepSeek V4 Flash",credits:0.06},{name:"GLM-5.2",credits:"x0.05 credits"},{name:"Hy3"}])
  console.log("  " + String(c.name).padEnd(20) + "=> " + fn(c, c, "id", text));
' "$D/index.js" 2>&1

echo
echo "通过 $ok 项，失败 $fail 项"
exit $((fail > 0))
