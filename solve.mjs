// 确定性配比求解器: 结构化约束 → 具体配比方案(或明确判定无解+原因)
// 设计原则: 不碰 LLM。同样输入永远同样输出, 每一步可解释。
import { TOTAL_REQUIRED, IP_MANDATORY, CAPS, CLASSES, CLASS_NAMES, GROUPS } from './rules.mjs';

// 三档风险模板(扣除强制 ip 300 后的 2700 万基准分布)
const TEMPLATES = {
  稳健: { eq_etf: 500, bond_etf: 900, gov_bond: 400, corp_bond: 200, cd: 300, gold: 200, reit: 200 },
  平衡: { stock: 200, eq_etf: 900, bond_etf: 700, gov_bond: 200, cd: 200, gold: 300, reit: 200 },
  进取: { stock: 800, eq_etf: 1000, bond_etf: 300, pe: 300, gold: 200, reit: 100 },
};

const capOf = c => c === 'cd' ? CAPS.cd : c === 'pe' ? CAPS.pe
  : c === 're_res' ? CAPS.re_res : c === 're_nonres' ? CAPS.re_total : Infinity;
const expand = cls => GROUPS[cls] || [cls];
const groupsOf = c => Object.keys(GROUPS).filter(g => GROUPS[g].includes(c));

export function solve(req) {
  const risk = TEMPLATES[req.riskLevel] ? req.riskLevel : '平衡';
  const explain = [`风险档: ${risk}${TEMPLATES[req.riskLevel] ? '' : '(未指定, 取默认平衡)'}`];
  const reasons = [];
  const cons = (req.constraints || []).filter(c => c && c.kind);

  // 1) 类别级 [下限lo, 上限hi] + 组级 [groupLo, groupHi]
  const lo = {}, hi = {};
  for (const c of CLASSES) { lo[c] = 0; hi[c] = capOf(c); }
  lo.ip = hi.ip = IP_MANDATORY;
  const groupLo = {}, groupHi = { re: CAPS.re_total }; // 房地产合计法定上限

  const fills = []; // fill: 把该类别配满到"当时允许的最大值"(法定上限/用户上限/剩余额度取最小), 上限数值只存在于代码里
  for (const con of cons) {
    const cls = con.class, isGroup = !!GROUPS[cls];
    if (con.kind === 'fill') {
      fills.push(cls);
      explain.push(`配满: ${cls}(至允许上限)`);
    } else if (con.kind === 'exclude') {
      for (const c of expand(cls)) hi[c] = 0;
      explain.push(`剔除: ${cls}`);
    } else if (con.kind === 'min') {
      if (isGroup) groupLo[cls] = Math.max(groupLo[cls] || 0, +con.value || 0);
      else if (CLASSES.includes(cls)) lo[cls] = Math.max(lo[cls], +con.value || 0);
      explain.push(`下限: ${cls} ≥ ${con.value} 万`);
    } else if (con.kind === 'max') {
      if (isGroup) groupHi[cls] = Math.min(groupHi[cls] ?? Infinity, +con.value ?? Infinity);
      else if (CLASSES.includes(cls)) hi[cls] = Math.min(hi[cls], +con.value ?? Infinity);
      explain.push(`上限: ${cls} ≤ ${con.value} 万`);
    }
  }

  // 2) 可行性预判(给出人话原因)
  for (const c of CLASSES) {
    if (lo[c] > hi[c] + 1e-9) {
      const capNote = capOf(c) < Infinity && hi[c] === capOf(c) ? `法定上限 ${capOf(c)} 万` : '与剔除/上限约束冲突';
      reasons.push(`「${CLASS_NAMES[c] || c}」要求 ≥${lo[c]} 万, 但最多只能配 ${hi[c]} 万(${capNote})`);
    }
  }
  for (const [g, cap] of Object.entries(groupHi)) {
    const memberLo = expand(g).reduce((s, c) => s + lo[c], 0);
    const need = Math.max(memberLo, groupLo[g] || 0);
    const memberHiSum = expand(g).reduce((s, c) => s + hi[c], 0);
    const eff = Math.min(cap, memberHiSum);
    if (need > eff + 1e-9) reasons.push(`「${g}」需要 ≥${need} 万, 但该组最多只能配 ${eff} 万${g === 're' ? `(房地产合计计入上限 ${CAPS.re_total} 万, 其中住宅 ≤${CAPS.re_res} 万)` : ''}`);
  }
  for (const [g, v] of Object.entries(groupLo)) {
    if (g in groupHi) continue; // 上面已查
    const memberHiSum = expand(g).reduce((s, c) => s + hi[c], 0);
    if (v > memberHiSum + 1e-9) reasons.push(`「${g}」合计要求 ≥${v} 万, 但该组可配上限只有 ${memberHiSum} 万`);
  }
  // 下限总和(组下限只计超出成员类别下限的部分)
  const sumLo = CLASSES.reduce((s, c) => s + lo[c], 0)
    + Object.entries(groupLo).reduce((s, [g, v]) => s + Math.max(0, v - expand(g).reduce((x, c) => x + lo[c], 0)), 0);
  if (sumLo > TOTAL_REQUIRED + 1e-9) reasons.push(`各项要求的下限合计 ${Math.round(sumLo)} 万, 超过总额 ${TOTAL_REQUIRED} 万, 无法同时满足`);
  // 总容量(每个组的贡献不超过组上限)
  const inGroup = new Set(Object.values(GROUPS).flat());
  let capacity = CLASSES.filter(c => !inGroup.has(c)).reduce((s, c) => s + hi[c], 0);
  for (const g of Object.keys(GROUPS)) {
    const memberHiSum = expand(g).reduce((s, c) => s + hi[c], 0);
    capacity += Math.min(memberHiSum, groupHi[g] ?? Infinity);
  }
  if (capacity < TOTAL_REQUIRED - 1e-9) reasons.push(`剔除/限额之后, 所有可配资产的上限合计只有 ${Math.round(capacity)} 万, 凑不够 ${TOTAL_REQUIRED} 万`);
  if (reasons.length) return { feasible: false, reasons, explain };

  // 3) 分配: 先满足类别下限 → 组下限(房地产内非住宅优先) → 剩余按模板权重注水(受类别/组上限截断)
  const alloc = {}; CLASSES.forEach(c => alloc[c] = lo[c]);
  for (const [g, v] of Object.entries(groupLo)) {
    let need = v - expand(g).reduce((s, c) => s + alloc[c], 0);
    const order = g === 're' ? ['re_nonres', 're_res'] : expand(g);
    for (const c of order) {
      if (need <= 0) break;
      const gRoom = Math.min(...groupsOf(c).map(gg => (groupHi[gg] ?? Infinity) - expand(gg).reduce((s, x) => s + alloc[x], 0)), Infinity);
      const add = Math.min(hi[c] - alloc[c], gRoom, need);
      if (add > 0) { alloc[c] += add; need -= add; }
    }
  }
  const roomOf = c => {
    const gRoom = Math.min(...groupsOf(c).map(g => (groupHi[g] ?? Infinity) - expand(g).reduce((s, x) => s + alloc[x], 0)), Infinity);
    return Math.min(hi[c] - alloc[c], gRoom);
  };
  // fill 类别: 在下限之后、注水之前, 优先灌满(组fill时房地产内非住宅优先)
  for (const f of fills) {
    const order = f === 're' ? ['re_nonres', 're_res'] : expand(f);
    for (const c of order) {
      const budget = TOTAL_REQUIRED - CLASSES.reduce((s, x) => s + alloc[x], 0);
      if (budget <= 0) break;
      const add = Math.min(roomOf(c), budget);
      if (add > 0) alloc[c] += add;
    }
  }
  const tpl = TEMPLATES[risk];
  let remaining = TOTAL_REQUIRED - CLASSES.reduce((s, c) => s + alloc[c], 0);
  let guard = 0;
  while (remaining > 0.01 && guard++ < 60) {
    const free = CLASSES.filter(c => c !== 'ip' && roomOf(c) > 1e-9 && ((tpl[c] || 0) > 0 || alloc[c] > 0));
    const pool = free.length ? free : CLASSES.filter(c => c !== 'ip' && roomOf(c) > 1e-9);
    if (!pool.length) break;
    const wSum = pool.reduce((s, c) => s + (tpl[c] || alloc[c] || 1), 0);
    let distributed = 0;
    for (const c of pool) {
      const add = Math.min(remaining * ((tpl[c] || alloc[c] || 1) / wSum), roomOf(c));
      alloc[c] += add; distributed += add;
    }
    remaining -= distributed;
    if (distributed < 0.01) break;
  }
  if (remaining > 0.01) return { feasible: false, reasons: [`分配后仍有 ${Math.round(remaining)} 万无处可放(可配类别均已到顶)`], explain };

  // 4) 取整到万, 误差塞进仍有余量的最大类别
  for (const c of CLASSES) alloc[c] = Math.round(alloc[c]);
  let diff = TOTAL_REQUIRED - CLASSES.reduce((s, c) => s + alloc[c], 0);
  if (diff !== 0) {
    const fillSet = new Set(fills.flatMap(expand));
    const candidates = CLASSES.filter(c => c !== 'ip' && alloc[c] + diff >= lo[c] && alloc[c] + diff <= hi[c] && (diff < 0 || roomOf(c) >= diff)).sort((a, b) => alloc[b] - alloc[a]);
    const adj = candidates.find(c => !fillSet.has(c)) || candidates[0]; // 凑整误差优先不动"配满"的类别
    if (adj) alloc[adj] += diff;
  }
  Object.keys(alloc).forEach(c => { if (!alloc[c]) delete alloc[c]; });
  explain.push('先满足硬性下限, 剩余按风险模板权重分配, 全程受法定与用户上限截断');
  return { feasible: true, allocation: alloc, explain, reasons: [] };
}
