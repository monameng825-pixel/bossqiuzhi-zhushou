/* 求职助手 巡岗引擎 —— 完全隔离的独立模块（默认关闭；硬限速；熔断；只读浏览） */
(async function () {
  try {
    if (window.__atomcvPatrolInjected) return;
    window.__atomcvPatrolInjected = true;
    const LIMIT = { CLICK_MIN_MS: 4000, CLICK_JITTER_MS: 4000, PER_RUN: 15, PER_HOUR: 60, PER_DAY: 150, REST_EVERY: 10, REST_MS: 45000, REST_JITTER_MS: 30000, ERR_FUSE: 3 };
    const sget = keys => new Promise(r => chrome.storage.local.get(keys, r));
    const sset = obj => new Promise(r => chrome.storage.local.set(obj, r));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const today = () => new Date().toDateString();
    async function getCfg() { const { atomcv_patrol_cfg: c = {} } = await sget(["atomcv_patrol_cfg"]); return { enabled: false, minScore: 60, ...c }; }
    async function getQuota() {
      const { atomcv_patrol_quota: q = {} } = await sget(["atomcv_patrol_quota"]);
      const now = Date.now();
      let quota = { day: today(), dayCount: 0, hourStart: now, hourCount: 0, errDay: today(), errCount: 0, ...q };
      if (quota.day !== today()) { quota.day = today(); quota.dayCount = 0; }
      if (quota.errDay !== today()) { quota.errDay = today(); quota.errCount = 0; }
      if (now - quota.hourStart > 3600000) { quota.hourStart = now; quota.hourCount = 0; }
      return quota;
    }
    async function bumpQuota() { const q = await getQuota(); q.dayCount++; q.hourCount++; await sset({ atomcv_patrol_quota: q }); return q; }
    async function fuse(reason) { const cfg = await getCfg(); cfg.cooldownUntil = new Date().setHours(23, 59, 59, 999); cfg.cooldownReason = reason; await sset({ atomcv_patrol_cfg: cfg }); }
    async function bumpErr() { const q = await getQuota(); q.errCount++; await sset({ atomcv_patrol_quota: q }); if (q.errCount >= LIMIT.ERR_FUSE) await fuse("巡岗多次出错，已熔断保护（明天自动恢复）"); return q.errCount; }
    function findJobCards() { return [...document.querySelectorAll(".job-card-wrapper,.job-card-box,li[class*='job-card'],.cardx")].filter(e => e.offsetHeight > 30); }
    function isChatPage() { return /\/chat|\/im\b/.test(location.href); }
    function isSearchPage() { return !isChatPage() && findJobCards().length >= 2; }
    function riskDetected() { const t = (document.body.innerText || "").slice(0, 3000); return /安全验证|请完成验证|验证码|访问异常|操作频繁/.test(t); }
    function extractJDLite() {
      let title = "";
      for (const s of [".job-detail-box .name", ".job-banner .name", "h1", "[class*='job-name']"]) {
        const el = document.querySelector(s);
        const t = el && (el.innerText || "").trim().split("\n")[0];
        if (t && t.length >= 2 && !/^(.{1,4})(先生|女士)$/.test(t)) { title = t.slice(0, 40); break; }
      }
      let body = "";
      for (const s of [".job-sec-text", ".job-detail-body", ".job-detail-box", "[class*='job-detail']"]) {
        document.querySelectorAll(s).forEach(e => { const t = (e.innerText || "").trim(); if (t.length > body.length && t.length > 60) body = t; });
        if (body.length > 200) break;
      }
      let company = "";
      const ce = document.querySelector(".job-detail-box [class*='company'], [class*='company-name']");
      if (ce) company = ce.innerText.trim().split("\n")[0].slice(0, 30);
      let salary = "";
      const se = document.querySelector(".job-detail-box .salary, .salary, [class*='salary']");
      if (se && /K/i.test(se.innerText)) salary = se.innerText.trim().split("\n")[0].slice(0, 20);
      if (!salary) { const m = (body || "").match(/\d{1,3}\s*[-–~]\s*\d{1,3}\s*K/i); if (m) salary = m[0]; }
      return { title, body, company, salary };
    }
    function jdHash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return "h" + h.toString(36); }
    const llmChat = (messages) => new Promise(r => chrome.runtime.sendMessage({ type: "llmChat", messages, json: true }, r));
    async function aiScore(jd, atoms, profile) {
      const key = jdHash((jd.body || "").slice(0, 2000) + "|" + atoms.length);
      const { atomcv_llmcache: cache = {} } = await sget(["atomcv_llmcache"]);
      if (cache[key] && cache[key].data) return cache[key].data;
      const digest = atoms.map(a => ({ id: a.id, type: a.type, org: a.org || "", title: a.title || "", content: (a.bullet || a.raw || "").slice(0, 100), skills: (a.skills || []).slice(0, 10) }));
      const sys = `你是资深招聘顾问，评估候选人经历库与岗位JD的真实匹配度。客观严格，领域不相关就是低分。只输出JSON：{"score":0到100整数,"verdict":"值得投|可以投|谨慎投|不建议投","reason":"一句话核心判断","hard_check":[],"covered":[],"missing":["缺口能力"],"relevant_atom_ids":[],"greeting":""}。评分标准：领域完全不相关≤20；边缘沾边20-50；核心职责对上60-75；多段有力经历支撑>75。`;
      const user = JSON.stringify({ 岗位: { 标题: jd.title, 薪资: jd.salary || "未知", JD: (jd.body || "").slice(0, 2200) }, 候选人: { 概况: profile.headline || "", 期望薪资: profile.salary || "" }, 经历库: digest });
      const res = await llmChat([{ role: "system", content: sys }, { role: "user", content: user }]);
      if (res && res.content) { try { const obj = JSON.parse(res.content); if (typeof obj.score === "number") { cache[key] = { at: Date.now(), data: obj }; await sset({ atomcv_llmcache: cache }); return obj; } } catch (e) {} }
      return null;
    }
    const host = document.createElement("div");
    host.id = "atomcv-patrol-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
    <style>
      :host{all:initial}
      *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
      .pbtn{position:fixed;right:18px;bottom:110px;z-index:2147483000;background:#0f9d78;color:#fff;border:2px solid #fff;border-radius:99px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22);display:none}
      .pp{position:fixed;right:18px;bottom:160px;z-index:2147483001;width:320px;background:#fff;border-radius:13px;box-shadow:0 8px 34px rgba(0,0,0,.25);padding:14px 16px;display:none;color:#1c2430;font-size:13px;line-height:1.6}
      .pp.open{display:block}
      .pp h4{margin:0 0 6px;font-size:14px}
      .stat{display:flex;gap:14px;margin:8px 0}
      .stat b{font-size:18px}
      .stat span{display:block;font-size:11px;color:#8a94a0}
      .log{max-height:130px;overflow-y:auto;font-size:12px;color:#5a6572;margin:6px 0;border-top:1px solid #eef1f4;padding-top:6px}
      .log div{margin:2px 0}
      .row{display:flex;gap:8px;margin-top:9px}
      .b{flex:1;padding:8px 0;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600}
      .b.go{background:#0f9d78;color:#fff}
      .b.warn{background:#fff;color:#b7791f;border:1.5px solid #e5cba0}
      .b.stop{background:#fff;color:#b4453a;border:1.5px solid #e5b8b4}
      .tip{font-size:11px;color:#98a2ae;margin-top:7px;line-height:1.5}
      .fuse{background:#fbecec;color:#b4453a;border-radius:8px;padding:8px 10px;font-size:12px;margin-top:6px}
    </style>
    <button class="pbtn" id="pbtn">🔍 巡岗</button>
    <div class="pp" id="pp">
      <h4>🔍 巡岗 <span id="pstate" style="color:#8a94a0;font-weight:400;font-size:12px">未开始</span></h4>
      <div class="stat">
        <div><b id="sSeen">0</b><span>已看</span></div>
        <div><b id="sKept" style="color:#0f9d78">0</b><span>入选</span></div>
        <div><b id="sDrop" style="color:#98a2ae">0</b><span>丢弃</span></div>
        <div><b id="sQuota">-</b><span>今日额度</span></div>
      </div>
      <div class="log" id="plog"></div>
      <div class="row" id="pbtns"></div>
      <div class="tip">安全限速：每岗 4-8 秒 · 每轮≤15 · 每小时≤60 · 每天≤150 · 每 10 个休息 1 分钟 · 遇验证自动熔断。只浏览打分，不发送任何消息。</div>
    </div>`;
    const $ = id => root.getElementById(id);
    $("pbtn").onclick = () => $("pp").classList.toggle("open");
    let st = { running: false, paused: false, stop: false, seen: 0, kept: 0, dropped: 0 };
    function plog(msg) { const d = document.createElement("div"); d.textContent = msg; $("plog").prepend(d); while ($("plog").children.length > 8) $("plog").lastChild.remove(); }
    function renderStats(q) { $("sSeen").textContent = st.seen; $("sKept").textContent = st.kept; $("sDrop").textContent = st.dropped; if (q) $("sQuota").textContent = `${q.dayCount}/${LIMIT.PER_DAY}`; }
    function renderBtns() {
      if (!st.running) {
        $("pbtns").innerHTML = `<button class="b go" id="go">▶ 开始巡这一页</button>`;
        $("go").onclick = () => runPatrol().catch(async e => { plog("❌ " + e.message); await bumpErr(); st.running = false; renderBtns(); });
      } else {
        $("pbtns").innerHTML = `<button class="b warn" id="pa">${st.paused ? "▶ 继续" : "⏸ 暂停"}</button><button class="b stop" id="so">⏹ 停止</button>`;
        $("pa").onclick = () => { st.paused = !st.paused; $("pstate").textContent = st.paused ? "已暂停" : "巡岗中…"; renderBtns(); };
        $("so").onclick = () => { st.stop = true; st.paused = false; };
      }
    }
    async function runPatrol() {
      const cfg = await getCfg();
      if (cfg.cooldownUntil && Date.now() < cfg.cooldownUntil) { $("pp").insertAdjacentHTML("beforeend", `<div class="fuse">⛔ ${cfg.cooldownReason || "今日已熔断"}，明天自动恢复</div>`); return; }
      let q = await getQuota();
      if (q.dayCount >= LIMIT.PER_DAY) { plog("⛔ 今日 150 个额度已用完"); return; }
      if (q.hourCount >= LIMIT.PER_HOUR) { plog("⏳ 本小时额度已满，请一小时后再来"); return; }
      const { atomcv_atoms: atoms = [], atomcv_profile: profile = {}, atomcv_llm: llm = {} } = await sget(["atomcv_atoms", "atomcv_profile", "atomcv_llm"]);
      if (!atoms.length || atoms.some(a => a.demo)) { plog("⚠️ 请先导入你的真实经历库"); return; }
      const wantSalary = (profile.salary || "").match(/(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*K/i);
      const bl = (cfg.blacklist || "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
      const E = window.AtomCVEngine;
      st = { running: true, paused: false, stop: false, seen: 0, kept: 0, dropped: 0 };
      $("pstate").textContent = "巡岗中…"; renderBtns();
      const cards = findJobCards().slice(0, LIMIT.PER_RUN);
      plog(`本轮将巡 ${cards.length} 个岗位`);
      const { atomcv_pool: pool = [], atomcv_board: board = [] } = await sget(["atomcv_pool", "atomcv_board"]);
      for (let i = 0; i < cards.length; i++) {
        if (st.stop) break;
        while (st.paused) await sleep(600);
        q = await getQuota();
        if (q.dayCount >= LIMIT.PER_DAY || q.hourCount >= LIMIT.PER_HOUR) { plog("⏳ 限速额度已满，自动停止"); break; }
        if (st.seen > 0 && st.seen % LIMIT.REST_EVERY === 0) {
          const rest = LIMIT.REST_MS + Math.random() * LIMIT.REST_JITTER_MS;
          $("pstate").textContent = `休息 ${Math.round(rest / 1000)} 秒（防风控）…`;
          await sleep(rest);
          $("pstate").textContent = "巡岗中…";
        }
        try {
          cards[i].scrollIntoView({ block: "center" });
          await sleep(300 + Math.random() * 500);
          cards[i].click();
          await sleep(LIMIT.CLICK_MIN_MS + Math.random() * LIMIT.CLICK_JITTER_MS);
          if (riskDetected()) { plog("🛑 检测到安全验证，熔断停止"); await fuse("页面出现安全验证，巡岗当日停用"); st.stop = true; break; }
          const jd = extractJDLite();
          const link = cards[i].querySelector("a[href*='job_detail'],a[href*='geek/job']");
          const url = link ? link.href : location.href;
          st.seen++; await bumpQuota();
          if (!jd.body) { st.dropped++; plog(`丢弃：${jd.title || "?"}（无JD）`); renderStats(q); continue; }
          let drop = null;
          const sal = (jd.salary || "").match(/(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*K/i);
          if (bl.some(b => (jd.company || "").includes(b) || (jd.title || "").includes(b))) drop = "黑名单";
          else if (wantSalary && sal && +sal[2] < +wantSalary[1]) drop = `薪资${jd.salary}低于期望`;
          else if (E && E.diagnose(jd.body, atoms).covered.size === 0) drop = "与经历完全无交集";
          if (!drop && (pool.some(p => p.title === jd.title && p.company === jd.company) || board.some(p => p.title === jd.title && p.company === jd.company))) drop = "已看过/已投过";
          if (drop) { st.dropped++; plog(`丢弃：${(jd.title || "?").slice(0, 12)}（${drop}）`); renderStats(q); continue; }
          let score, reason = "", missing = [];
          if (llm.key) {
            $("pstate").textContent = "AI 打分中…";
            const ai = await aiScore(jd, atoms, profile);
            $("pstate").textContent = "巡岗中…";
            if (ai) { score = ai.score; reason = ai.reason || ""; missing = ai.missing || []; }
          }
          if (score === undefined) score = E ? E.diagnose(jd.body, atoms).rate : 0;
          if (score >= (cfg.minScore || 60)) {
            st.kept++;
            pool.unshift({ id: "pj_" + Date.now() + "_" + i, title: jd.title, company: jd.company, salary: jd.salary, url, jdBody: (jd.body || "").slice(0, 4000), score, reason, missing, at: Date.now(), status: "new" });
            await sset({ atomcv_pool: pool });
            plog(`✅ 入选：${(jd.title || "").slice(0, 12)}（${score}%）`);
          } else { st.dropped++; plog(`丢弃：${(jd.title || "?").slice(0, 12)}（AI ${score}%）`); }
          renderStats(q);
        } catch (e) {
          plog("⚠️ 本岗出错跳过：" + String(e.message || e).slice(0, 40));
          const n = await bumpErr();
          if (n >= LIMIT.ERR_FUSE) { st.stop = true; break; }
        }
      }
      st.running = false;
      $("pstate").textContent = `本轮结束：入选 ${st.kept} 个`;
      plog(`🏁 本轮结束。入选岗位在管理页「今日匹配」里等你勾选投递。`);
      renderBtns();
    }
    async function tick() {
      try {
        const cfg = await getCfg();
        const show = cfg.enabled && isSearchPage();
        $("pbtn").style.display = show ? "block" : "none";
        if (!show) $("pp").classList.remove("open");
      } catch (e) {}
    }
    renderBtns();
    setInterval(tick, 2000);
    tick();
  } catch (e) { console.warn("[求职助手 patrol] disabled due to error:", e); }
})();
