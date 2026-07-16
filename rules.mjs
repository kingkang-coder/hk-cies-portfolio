// CIES 合规规则(确定性代码, 不经过任何 LLM)
// 双重角色: ①求解器的内置校验 ②评测体系的独立裁判
// 规则依据: 新资本投资者入境计划(2024)获许投资资产要求

export const TOTAL_REQUIRED = 3000;   // 万港元, 计入总额下限
export const IP_MANDATORY = 300;      // 资本投资者入境计划投资组合, 强制
export const CAPS = {
  cd: 300,        // 存款证上限
  pe: 1000,       // 私募 OFC/LPF 上限
  re_total: 1500, // 房地产合计计入上限
  re_res: 1000,   // 其中住宅房地产计入上限
};

// 资产类别全集(求解器与需求理解共用的词表)
export const CLASSES = ['ip', 'stock', 'eq_etf', 'bond_etf', 'gov_bond', 'corp_bond', 'cd', 'pe', 're_nonres', 're_res', 'gold', 'reit'];

// 类别中文名(解释输出用)
export const CLASS_NAMES = {
  ip: '港投公司组合(强制)', stock: '港股', eq_etf: '股票型ETF', bond_etf: '债券/货币ETF',
  gov_bond: '政府债券/iBond', corp_bond: '公司债/次级债', cd: '存款证',
  pe: '私募基金OFC/LPF', re_nonres: '非住宅房地产', re_res: '住宅房地产', gold: '黄金ETF', reit: 'REITs',
};

// 聚合类别 → 具体类别(用户说"债券"时指哪些)
export const GROUPS = {
  bond: ['bond_etf', 'gov_bond', 'corp_bond'],
  re: ['re_nonres', 're_res'],
  eq: ['stock', 'eq_etf'],
};

/**
 * 独立合规校验: 输入配置方案 {class: 金额万}, 返回 {pass, violations[]}
 * 注意: 此函数是评测的"裁判", 求解器不得 import 自己的校验逻辑替代它
 */
export function checkCompliance(alloc) {
  const v = [];
  const get = c => +alloc[c] || 0;
  const sum = CLASSES.reduce((s, c) => s + get(c), 0);

  for (const c of Object.keys(alloc)) {
    if (!CLASSES.includes(c)) v.push(`未知资产类别: ${c}`);
    if (get(c) < 0) v.push(`${c} 金额为负`);
  }
  if (get('ip') !== IP_MANDATORY) v.push(`港投组合必须恰好 ${IP_MANDATORY} 万, 当前 ${get('ip')}`);
  if (get('cd') > CAPS.cd) v.push(`存款证 ${get('cd')} 万超上限 ${CAPS.cd} 万`);
  if (get('pe') > CAPS.pe) v.push(`私募 ${get('pe')} 万超上限 ${CAPS.pe} 万`);
  if (get('re_res') > CAPS.re_res) v.push(`住宅房地产 ${get('re_res')} 万超计入上限 ${CAPS.re_res} 万`);
  if (get('re_nonres') + get('re_res') > CAPS.re_total) v.push(`房地产合计 ${get('re_nonres') + get('re_res')} 万超上限 ${CAPS.re_total} 万`);
  if (Math.round(sum) < TOTAL_REQUIRED) v.push(`计入总额 ${Math.round(sum)} 万 < ${TOTAL_REQUIRED} 万`);

  return { pass: v.length === 0, violations: v, total: Math.round(sum) };
}
