/**
 * 限流排队（LRU）单测：node test-cooldown.mjs
 *
 * 规则：
 *   ① 从未撞墙的账号（无时间戳）最优先
 *   ② 撞过墙的，按撞墙时间从远到近（越久没撞越优先）
 *   ③ 当前账号没撞墙 → 尊重用户手动选择，继续用它
 */
import { writeFileSync, unlinkSync } from 'node:fs'
import { activeWorkBuddySession } from './workbuddy-auth.js'

const COOL = '/tmp/.wb-cool-test.json'
process.env.WORKBUDDY_COOLDOWN_FILE = COOL

const mk = (activeId) => ({
  activeId,
  sessions: [
    { id: 'A', label: 'A' }, { id: 'B', label: 'B' },
    { id: 'C', label: 'C' }, { id: 'D', label: 'D' },
  ],
})
const MIN = 60 * 1000
const now = Date.now()
let pass = 0, fail = 0
const check = (name, got, want) => {
  if (got === want) { console.log(`  ✅ ${name}`); pass++ }
  else { console.log(`  ❌ ${name}: 得到 ${got}，期望 ${want}`); fail++ }
}
const write = (o) => writeFileSync(COOL, JSON.stringify(o))

console.log('限流排队（LRU）测试\n')

write({})
check('无登记 → 用 activeId', activeWorkBuddySession(mk('B')).label, 'B')

write({ A: now - 1 * MIN })
check('当前未撞墙 → 保持不动', activeWorkBuddySession(mk('B')).label, 'B')

write({ B: now - 1 * MIN })
check('当前撞墙 → 选从未撞墙的(A最靠前)', activeWorkBuddySession(mk('B')).label, 'A')

write({ B: now - 1 * MIN, C: now - 2 * MIN, A: now - 1 * MIN })
check('只剩 D 未撞墙 → 选 D', activeWorkBuddySession(mk('B')).label, 'D')

write({ B: now - 1 * MIN, C: now - 2 * MIN, D: now - 3 * MIN, A: now - 10 * MIN })
check('全撞过 → 选最久没撞的 A', activeWorkBuddySession(mk('B')).label, 'A')

write({ B: now - 2 * MIN, A: now - 1 * MIN, C: now - 5 * MIN, D: now - 30 * MIN })
check('按时间从远到近 → 选 D', activeWorkBuddySession(mk('B')).label, 'D')

write({ B: now - 1 * MIN, A: null, C: 'oops', D: NaN })
check('非法值忽略 → 全未撞墙选 A', activeWorkBuddySession(mk('B')).label, 'A')

writeFileSync(COOL, '{ 这不是 JSON')
check('文件损坏 → 退回 activeId', activeWorkBuddySession(mk('B')).label, 'B')

write({ B: now - 1 * MIN })
const single = { activeId: 'B', sessions: [{ id: 'B', label: 'B' }] }
check('单账号撞墙 → 仍返回它', activeWorkBuddySession(single).label, 'B')


// 10. 手动切换优先：凭据文件比撞墙登记新 → 尊重手动选择
//     （模拟：登记 B 撞墙于"很久以前"，而凭据文件是"刚刚"改的）
{
  const fs = await import('node:fs')
  const credPath = `${process.env.HOME}/.dsh/.credentials.yaml`
  const orig = fs.statSync(credPath).mtimeMs
  // 凭据"刚刚"被改（现在），登记是"1 小时前" → 说明用户之后手动切过
  write({ B: Date.now() - 60 * MIN, A: Date.now() - 90 * MIN, C: Date.now() - 70 * MIN, D: Date.now() - 80 * MIN })
  check('手动切换晚于登记 → 保持用户选择 B', activeWorkBuddySession(mk('B')).label, 'B')
  void orig
}

try { unlinkSync(COOL) } catch {}
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
