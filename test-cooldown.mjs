/** 冷却名单轮换的单测：node test-cooldown.mjs */
import { writeFileSync, unlinkSync } from 'node:fs'
import { activeWorkBuddySession } from './workbuddy-auth.js'

const COOL = '/tmp/.wb-cool-test.json'
process.env.WORKBUDDY_COOLDOWN_FILE = COOL
const store = {
  activeId: 'user-B',
  sessions: [{ id: 'user-A', label: 'A' }, { id: 'user-B', label: 'B' }, { id: 'user-C', label: 'C' }],
}
let pass = 0, fail = 0
const check = (name, got, want) => {
  if (got === want) { console.log(`  ✅ ${name}`); pass++ }
  else { console.log(`  ❌ ${name}: 得到 ${got}，期望 ${want}`); fail++ }
}
const write = (obj) => writeFileSync(COOL, JSON.stringify(obj))

console.log('冷却名单轮换测试')
write({})
check('无冷却 → 用 activeId', activeWorkBuddySession(store).label, 'B')
write({ 'user-B': Date.now() + 60000 })
check('当前冷却 → 下一个', activeWorkBuddySession(store).label, 'C')
write({ 'user-B': Date.now() + 60000, 'user-C': Date.now() + 60000 })
check('连号冷却 → 跳过到 A', activeWorkBuddySession(store).label, 'A')
write({ 'user-B': Date.now() - 1000 })
check('冷却已过期 → 忽略', activeWorkBuddySession(store).label, 'B')
write({ 'user-A': Date.now() + 60000, 'user-B': Date.now() + 60000, 'user-C': Date.now() + 60000 })
check('全部冷却 → 退回当前', activeWorkBuddySession(store).label, 'B')

try { unlinkSync(COOL) } catch {}
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
