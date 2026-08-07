/* AtomCV 匹配引擎 v0 —— 规范能力表 + 规则匹配。
 * 后续升级点：VOCAB 由服务端词典/LLM 替代；匹配由 embedding 语义相似度替代。
 * 本文件同时被 content script 和 dashboard 引用（挂在全局 AtomCVEngine 上）。 */
(function (global) {
  // 规范能力 -> 表面别名（JD 里出现任一别名即命中该能力）
  const VOCAB = {
    "用户生命周期管理": ["生命周期", "全生命周期", "lifecycle"],
    "用户分层运营": ["用户分层", "分层体系", "分层运营", "精细化运营"],
    "RFM模型": ["RFM"],
    "流失召回": ["流失", "召回"],
    "私域运营": ["私域", "CRM"],
    "用户触达": ["触达"],
    "SQL": ["SQL"],
    "数据分析": ["数据分析", "数据支持", "取数分析", "数据能力"],
    "Python": ["Python"],
    "神策": ["神策"],
    "GrowingIO": ["GrowingIO"],
    "埋点分析": ["埋点", "用户行为数据", "用户行为分析"],
    "指标体系": ["指标体系"],
    "留存分析": ["留存看板", "留存"],
    "数据看板": ["看板"],
    "用户增长": ["用户增长", "新用户增长", "增长实验"],
    "AB测试": ["AB测试", "A/B", "增长实验"],
    "转化率优化": ["转化漏斗", "转化率", "首单转化"],
    "漏斗分析": ["漏斗"],
    "优惠券/激励策略": ["激励策略", "优惠券"],
    "会员体系": ["会员权益", "会员体系", "会员规模"],
    "付费转化": ["付费转化", "付费会员", "订阅"],
    "定价策略": ["定价策略", "定价体系"],
    "跨部门协作": ["跨部门"],
    "项目管理": ["项目管理", "项目推进"],
    "团队管理": ["带团队", "团队管理", "团队搭建"],
    "活动运营": ["活动运营", "活动策划"],
    "裂变增长": ["裂变"],
    "社群运营": ["社群"],
    "内容运营": ["内容运营", "内容策划"],
    "公众号运营": ["公众号"],
    "拉新获客": ["拉新", "获客", "粉丝增长"],
    "短视频运营": ["短视频"],
    "商业化": ["商业化"],
    "Java": ["java"],
    "Go": ["golang", " go "],
    "MySQL": ["mysql"],
    "Redis": ["redis"],
    "Spring": ["spring"],
    "微服务": ["微服务", "microservice"],
    "分布式": ["分布式"],
    "高并发": ["高并发", "高性能", "低延迟"],
    "服务治理": ["服务治理", "容量规划"],
    "架构设计": ["架构设计", "系统设计"],
    "代码评审": ["codereview", "code review", "代码评审"],
    "K8s": ["k8s", "kubernetes"],
    "消息队列": ["kafka", "消息队列", "rocketmq"],
    "用户体系": ["用户体系", "账号管理", "账号安全", "KYC"],
    "电商运营": ["电商", "GMV"],
    "产品运营": ["产品运营"],
    "直播运营": ["直播"],
    "投放": ["投放", "信息流", "广告优化"]
  };

  /* 领域无关匹配：用户经历库里的技能标签本身就是词表（Java/MySQL/用户增长…直接在JD里找），
   * 内置 VOCAB 只补充"同义别名"（如 生命周期≈lifecycle）。这样任何行业的库都能打分。 */
  function jdSkills(text, atoms) {
    const t = (text || "").toLowerCase();
    const hit = new Set();
    // 1) 库技能直查：JD 里出现某个原子技能标签 → 该技能是本 JD 的要求项
    const libSkills = new Set();
    (atoms || []).forEach(a => (a.skills || []).forEach(s => { if (s && s.trim().length >= 2) libSkills.add(s.trim()); }));
    libSkills.forEach(s => { if (t.includes(s.toLowerCase())) hit.add(s); });
    // 2) 别名词表补充：命中别名 → 记规范名
    for (const canon in VOCAB) {
      if (VOCAB[canon].some(a => t.includes(a.toLowerCase()))) hit.add(canon);
    }
    return hit;
  }

  // 对单个 JD：给出总分、覆盖/缺口、每个原子的相关度
  function diagnose(jdText, atoms) {
    const req = jdSkills(jdText, atoms);
    const scored = atoms.map(a => {
      const m = (a.skills || []).filter(s => req.has(s));
      let score = m.length + ((a.metrics && a.metrics.length) ? 0.4 : 0) + (a.type === "project" ? 0.2 : 0);
      return { atom: a, matched: m, score };
    });
    const relevant = scored.filter(x => x.matched.length >= 1).sort((x, y) => y.score - x.score);
    const covered = new Map(); // 能力 -> 支撑它的原子id列表
    relevant.forEach(x => x.matched.forEach(s => {
      if (!covered.has(s)) covered.set(s, []);
      covered.get(s).push(x.atom.id);
    }));
    const missing = [...req].filter(s => !covered.has(s));
    /* 评分 v2：证据不足就压分，防止"1/1=100%"式的虚高
     * - 分母至少按 5 项要求算：JD 只识别出 1-2 项时，说明信号太弱，不允许高分
     * - 命中的经历原子 < 2 段时，分数封顶 50：一段经历撑不起"高度匹配" */
    const matchedAtomN = new Set(relevant.map(x => x.atom.id)).size;
    let rate = req.size ? Math.round(covered.size / Math.max(req.size, 5) * 100) : 0;
    if (matchedAtomN < 2) rate = Math.min(rate, 50);
    const lowSignal = req.size > 0 && req.size < 4; // JD 识别出的要求太少，分数参考意义有限
    return { req, covered, missing, rate, relevant, lowSignal, matchedAtomN };
  }

  /* 薪资解析与比对："10-12K·13薪" / "30-60K" → {min,max}；返回 null 表示解析不了 */
  function parseSalary(str) {
    const s = str || "";
    let m = s.match(/(\d{1,3}(?:\.\d)?)\s*[-–~]\s*(\d{1,3}(?:\.\d)?)\s*K/i);
    if (m) return { min: +m[1], max: +m[2] };
    m = s.match(/(\d{1,3}(?:\.\d)?)\s*K/i);              // 单值如 "30K" / "30K以上"
    if (m) return { min: +m[1], max: +m[1] };
    return null;
  }
  function salaryCheck(jdSalaryStr, wantStr) {
    const jd = parseSalary(jdSalaryStr), want = parseSalary(wantStr);
    if (!jd || !want) return null;
    if (jd.max < want.min) return { ok: false, text: `⚠️ 薪资 ${jd.min}-${jd.max}K 低于你的期望（${want.min}-${want.max}K）——不建议投` };
    if (jd.min > want.max) return { ok: true, text: `💰 薪资 ${jd.min}-${jd.max}K 高于你的期望区间` };
    return { ok: true, text: `✅ 薪资 ${jd.min}-${jd.max}K 在你的期望范围内` };
  }

  // 组装精简简历（文本结构，渲染交给界面层）
  function assemble(diag, atoms) {
    const order = { work: 0, project: 1, skill: 2, education: 3, award: 4, other: 5 };
    const eduAtoms = atoms.filter(a => a.type === "education");
    const chosen = diag.relevant.map(x => x);
    const sections = {};
    chosen.forEach(x => {
      (sections[x.atom.type] = sections[x.atom.type] || []).push(x);
    });
    // 教育信息始终保留
    if (!sections.education && eduAtoms.length) {
      sections.education = eduAtoms.map(a => ({ atom: a, matched: [], score: 0 }));
    }
    return Object.keys(sections).sort((p, q) => order[p] - order[q]).map(t => ({
      type: t,
      label: { work: "工作经历", project: "项目经历", skill: "技能", education: "教育", award: "荣誉", other: "其他" }[t] || t,
      items: sections[t]
    }));
  }

  // v0 招呼语：模板 + 取最强的两个匹配原子。后续升级为 LLM 生成。
  function greeting(jdTitle, diag) {
    const tops = diag.relevant.slice(0, 2).map(x => x.atom.bullet || x.atom.raw).filter(Boolean);
    const skills = [...diag.covered.keys()].slice(0, 4).join("、");
    let g = `您好！看到贵司「${jdTitle || "该岗位"}」的招聘，和我的经验非常契合（${skills}）。`;
    if (tops.length) g += `我曾经：${tops.map(t => t.replace(/（[^）]*）$/, "")).join("；")}。`;
    g += "已按岗位要求整理了一份针对性简历，期待与您进一步沟通！";
    return g;
  }

  function verdict(rate) {
    if (rate >= 75) return { level: "high", text: "值得投：核心能力高度吻合", color: "#0f9d78" };
    if (rate >= 50) return { level: "mid", text: "可以投：有一定契合，注意补齐缺口", color: "#b7791f" };
    return { level: "low", text: "谨慎投：契合度低，建议把额度留给更匹配的岗位", color: "#8a94a0" };
  }

  global.AtomCVEngine = { VOCAB, jdSkills, diagnose, assemble, greeting, verdict, parseSalary, salaryCheck };
})(typeof window !== "undefined" ? window : globalThis);
