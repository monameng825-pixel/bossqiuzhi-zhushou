/* AtomCV content script v0.3 —— 直线流程：
 * 岗位页：匹配分 → 诊断 → 生成简历图片（可勾选调整）→ 提示点「立即沟通」
 * 聊天页：自动接续刚才生成的简历 → 一键发进聊天
 * 生成结果持久化（atomcv_last），跨页面不丢。 */
(async function () {
  if (window.__atomcvInjected) return;
  window.__atomcvInjected = true;

  const E = window.AtomCVEngine;

  // ---------- 存储 ----------
  const sget = keys => new Promise(r => chrome.storage.local.get(keys, r));
  const sset = obj => new Promise(r => chrome.storage.local.set(obj, r));
  async function loadAtoms() { return (await sget(["atomcv_atoms"])).atomcv_atoms || []; }
  async function getProfile() { return (await sget(["atomcv_profile"])).atomcv_profile || { name: "求职者", headline: "" }; }
  async function upsertBoardCard(card) {
    const { atomcv_board: board = [] } = await sget(["atomcv_board"]);
    const i = board.findIndex(c => (card.url && c.url === card.url) || (c.title === card.title && c.company === card.company));
    if (i >= 0) board[i] = { ...board[i], ...card, id: board[i].id, status: board[i].status };
    else board.unshift(card);
    await sset({ atomcv_board: board });
  }

  // ---------- 页面识别 ----------
  function isChatPage() {
    return /\/chat|\/im\b|geek\/im/.test(location.href) ||
      !!document.querySelector(".chat-conversation, [class*='chat-editor'], .conversation-message");
  }
  function extractJD() {
    const titleSel = [
      ".job-detail-box .name", ".job-detail-header .name", ".job-banner .name",
      ".job-primary .name", "[class*='job-detail'] h1", "h1", ".job-title", "[class*='job-name']"
    ];
    // 过滤误抓：HR 姓名（xx先生/女士）、纯人名等
    const isPersonName = t => /^(.{1,4})(先生|女士|小姐|老师)$/.test(t) || /^(HR|HRBP|招聘)/.test(t);
    // 列表区元素（左侧岗位卡片）不能当详情标题——否则搜索页点击切换岗位感知不到
    const inList = el => !!el.closest("[class*='job-card'],[class*='card-box'],[class*='job-list'],[class*='search-job-result'] ul,li");
    let title = "", titleEl = null;
    for (const p of [true, false]) {  // 第一轮跳过列表区；全落空才允许列表区兜底
      for (const s of titleSel) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          if (p && inList(el)) continue;
          const t = (el.innerText || "").trim().split("\n")[0];
          if (t && t.length >= 2 && !isPersonName(t)) { title = t.slice(0, 40); titleEl = el; break; }
        }
        if (title) break;
      }
      if (title) break;
    }
    // 兜底：从页面 <title> 提取（Boss 格式如「「xx招聘」-BOSS直聘」）
    if (!title || isPersonName(title)) {
      const m = document.title.match(/「(.+?)招聘」/) || document.title.match(/^([^\-_|【」]{2,30})/);
      if (m && !isPersonName(m[1].trim())) title = m[1].trim().slice(0, 40);
    }
    const bodySel = [
      ".job-sec-text", ".job-detail-section", ".job-detail-body", ".job-detail-box",
      ".desc", "[class*='job-sec']", "[class*='job-detail']", "[class*='detail-content']"
    ];
    let best = "";
    for (const s of bodySel) {
      document.querySelectorAll(s).forEach(e => {
        const t = (e.innerText || "").trim();
        if (t.length > best.length && t.length > 60) best = t;
      });
      if (best.length > 200) break;
    }
    if (!best) {
      const t = document.body.innerText || "";
      const idx = t.search(/职位描述|岗位职责|任职要求|工作职责|职位详情/);
      if (idx >= 0) best = t.slice(idx, idx + 3000);
      else if (t.length > 300 && !isChatPage()) best = t.slice(0, 4000);
    }
    let company = "";
    const compEl = document.querySelector(".job-detail-box [class*='company'], .company-info .name, [class*='company-name'], .company");
    if (compEl) company = compEl.innerText.trim().split("\n")[0].slice(0, 30);
    // ---------- 薪资：全页文本节点扫描（完全不依赖类名），按"与标题的 DOM 距离"锚定同一岗位 ----------
    let salary = "";
    const salRe = /\d{1,3}(?:\.\d)?\s*[-–~]\s*\d{1,3}(?:\.\d)?\s*K(?:\s*·\s*\d{1,2}薪)?/i;
    const inCard = el => !!(el && el.closest("[class*='job-card'],[class*='card-box'],li"));
    const salCands = [];
    {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let nd, cnt = 0;
      while ((nd = w.nextNode()) && cnt < 4000) {
        cnt++;
        const m = (nd.nodeValue || "").match(salRe);
        if (m && nd.parentElement) salCands.push({ el: nd.parentElement, val: m[0].replace(/\s+/g, "") });
      }
    }
    // 标题元素兜底定位：title 来自 <title> 标签时没有 titleEl，去正文里找同文案的元素（排除列表区）
    if (!titleEl && title) {
      const key = title.slice(0, 10);
      const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let nd2, c2 = 0;
      while ((nd2 = w2.nextNode()) && c2 < 4000) {
        c2++;
        const tv = (nd2.nodeValue || "").trim();
        if (tv && tv.startsWith(key) && nd2.parentElement && !inList(nd2.parentElement)) { titleEl = nd2.parentElement; break; }
      }
    }
    // 1) 距离锚定：从标题逐层向上（≤8层），取该层容器内、且不在岗位卡片里的薪资候选
    if (titleEl && salCands.length) {
      let n = titleEl;
      for (let i = 0; i < 8 && n && n !== document.body && !salary; i++, n = n.parentElement) {
        const hit = salCands.filter(c => n.contains(c.el) && !inCard(c.el));
        const vals = [...new Set(hit.map(h => h.val))];
        if (vals.length === 1) salary = vals[0];        // 该层恰好一个值 → 就是它
        else if (vals.length > 1) break;                 // 多个不同值 → 已跨到列表，停止上探
      }
    }
    // 2) 全页兜底：排除卡片后只剩一个唯一值就认
    if (!salary && salCands.length) {
      const vals = [...new Set(salCands.filter(c => !inCard(c.el)).map(c => c.val))];
      if (vals.length === 1) salary = vals[0];
    }
    // 3) 正文兜底
    if (!salary && best) { const m = best.match(salRe); if (m) salary = m[0].replace(/\s+/g, ""); }
    return { title, body: best, company, salary, url: location.href.split("?")[0] };
  }
  function findChatFileInput() {
    return [...document.querySelectorAll("input[type=file]")]
      .find(i => !i.accept || /image|\*/.test(i.accept)) || null;
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "atomcv-host";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host{all:initial}
    *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .badge{position:fixed;right:18px;top:38%;z-index:2147483000;width:58px;height:58px;border-radius:50%;
      display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;
      color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.22);border:2px solid #fff;user-select:none}
    .badge .num{font-size:17px;font-weight:800;line-height:1}
    .badge .lbl{font-size:9px;opacity:.92;margin-top:2px}
    .panel{position:fixed;right:0;top:0;height:100vh;width:400px;max-width:94vw;z-index:2147483001;
      background:#fff;box-shadow:-6px 0 28px rgba(0,0,0,.18);display:none;flex-direction:column;color:#1c2430}
    .panel.open{display:flex}
    .hd{padding:13px 16px;border-bottom:1px solid #e9edf2;display:flex;align-items:center;gap:8px}
    .hd b{font-size:15px}
    .hd .x{margin-left:auto;cursor:pointer;border:none;background:#f2f4f7;border-radius:8px;width:26px;height:26px;font-size:13px}
    .bd{flex:1;overflow-y:auto;padding:14px 16px}
    .score-row{display:flex;align-items:center;gap:12px;margin-bottom:4px}
    .big{font-size:34px;font-weight:800}
    .meter{height:8px;border-radius:99px;background:#eef1f4;overflow:hidden;flex:1;position:relative}
    .meter>i{display:block;height:100%;border-radius:99px}
    .verdict{font-size:13px;margin:4px 0 14px;font-weight:600}
    .sec{font-size:12.5px;color:#6b7683;margin:12px 0 6px}
    .chips{display:flex;flex-wrap:wrap;gap:5px}
    .chip{font-size:12px;padding:2px 9px;border-radius:99px;background:#e6f6f1;color:#0f9d78}
    .chip.miss{background:#fbecec;color:#b4453a;cursor:pointer}
    .chip.tog{background:#eef0ff;color:#4f46e5;cursor:pointer;user-select:none}
    .chip.tog.off{background:#f0f2f5;color:#a4adb7;text-decoration:line-through}
    .tip{font-size:11.5px;color:#98a2ae;margin-top:6px;line-height:1.6}
    .next{margin-top:10px;background:#e6f6f1;border-left:3px solid #0f9d78;border-radius:6px;padding:8px 11px;font-size:12.5px;color:#0b6b52;line-height:1.6}
    .btns{padding:12px 16px;border-top:1px solid #e9edf2;display:flex;gap:9px}
    .btn{flex:1;padding:10px 0;border-radius:9px;border:none;cursor:pointer;font-size:14px;font-weight:600}
    .btn.pri{background:#4f46e5;color:#fff}
    .btn.sec2{background:#fff;color:#4f46e5;border:1.5px solid #4f46e5}
    .imgwrap{border:1px solid #e6e9ee;border-radius:9px;overflow:auto;max-height:46vh;background:#fafbfc}
    .paste{width:100%;min-height:100px;border:1px solid #dfe4ea;border-radius:9px;padding:9px;font-size:13px;margin-top:8px;resize:vertical}
    .empty{padding:22px 12px;text-align:center;color:#6b7683;font-size:13.5px;line-height:1.8}
    .cont{background:#eef0ff;border-radius:9px;padding:11px 13px;margin-bottom:10px}
    .cont b{font-size:14px}
    select{width:100%;margin:8px 0;padding:8px;border:1px solid #dfe4ea;border-radius:8px;font-size:13px;font-family:inherit}
  </style>
  <div class="badge" id="badge" style="display:none;background:#8a94a0">
    <span class="num" id="bNum">--</span><span class="lbl" id="bLbl">匹配分</span>
  </div>
  <div class="panel" id="panel">
    <div class="hd"><b>求职助手</b><span id="hdTitle" style="font-size:12px;color:#6b7683"></span>
      <button class="x" id="close">✕</button></div>
    <div class="bd" id="body"></div>
    <div class="btns" id="btns"></div>
  </div>`;

  const $ = id => root.getElementById(id);
  $("close").onclick = () => $("panel").classList.remove("open");
  $("badge").onclick = () => { $("panel").classList.toggle("open"); };
  function esc(s){const d=document.createElement("div");d.textContent=s||"";return d.innerHTML;}

  // ---------- 状态 ----------
  let jd = null, diag = null, atoms = [], selected = null, lastBlob = null, profileG = { name: "求职者" };
  let queueInfo = null;
  let aiDiag = null, aiState = "idle";
  let aiErr = "", view = "";
  function rerenderDiagIfVisible() { if (view === "diag") renderDiagnosis(); }

  async function checkQueue() {
    const { atomcv_queue: q } = await sget(["atomcv_queue"]);
    if (!q || !q.active || !q.items || !q.items[q.idx]) { queueInfo = null; return null; }
    const cur = q.items[q.idx];
    const herePath = location.href.split("?")[0].split("#")[0];
    const itemPath = (cur.url || "").split("?")[0].split("#")[0];
    if (herePath === itemPath || (itemPath && herePath.includes(itemPath.split("/").pop() || "___"))) {
      queueInfo = q; return q;
    }
    queueInfo = null; return null;
  }
  async function advanceQueue() {
    const { atomcv_queue: q } = await sget(["atomcv_queue"]);
    if (!q || !q.active) return;
    q.idx++;
    if (q.idx >= q.items.length) { q.active = false; await sset({ atomcv_queue: q }); return { done: true, total: q.items.length }; }
    await sset({ atomcv_queue: q });
    return { done: false, next: q.items[q.idx], idx: q.idx, total: q.items.length };
  }

  const llmChat = (messages, json = true) => new Promise(r => chrome.runtime.sendMessage({ type: "llmChat", messages, json }, r));
  function jdHash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return "h" + h.toString(36); }

  // 软性素质不算"缺口"——缺口只保留硬性项（具体技能/工具/经验/证书）
  const SOFT_RE = /心态|热情|抗压|沟通|表达能力|学习能力|学习成长|快速学习|责任心|上进|三观|人品|团队|吃苦|情绪|执行力|细心|耐心|活力|激情|价值观|品质|素质|思辨|亲和|自驱|抗挫|韧性|野心|意愿|积极|主动性|适应/;
  async function aiScoreJd(jdObj, cacheOnly, force) {
    const { atomcv_llm: cfg = {} } = await sget(["atomcv_llm"]);
    if (!cfg.key) return { data: null, error: "NO_KEY" };
    const key = jdHash((jdObj.body || "").slice(0, 2000) + "|" + atoms.length);
    const { atomcv_llmcache: cache = {} } = await sget(["atomcv_llmcache"]);
    if (!force && cache[key] && cache[key].data) return { data: cache[key].data, error: null };
    if (cacheOnly) return { data: null, error: "CACHE_MISS" };
    const digest = atoms.map(a => ({
      id: a.id, type: a.type, org: a.org || "", title: a.title || "", time: a.time || "",
      content: (a.bullet || a.raw || "").slice(0, 100), skills: (a.skills || []).slice(0, 10)
    }));
    const sys = `你是资深招聘顾问，评估候选人经历库与岗位JD的真实匹配度。必须客观严格：领域不相关就是低分，不许客气。只输出JSON，结构：
{"score":0到100整数,"verdict":"值得投|可以投|谨慎投|不建议投","reason":"一句话核心判断，直白","hard_check":[{"item":"学历/经验年限/城市等硬性要求","result":"符合|不符|未知","note":"简短说明"}],"covered":[{"ability":"能力项","atom_ids":["支撑它的经历id"]}],"missing":["JD要求但经历库没有的能力"],"relevant_atom_ids":["按相关度排序的经历id"],"greeting":"以候选人口吻写给HR的招呼语，80字内，提到1-2个最匹配的真实经历亮点，不编造"}
评分标准：领域完全不相关≤20；只有边缘技能沾边20-50；核心职责能对上60-75；核心职责+多段有力经历支撑>75。
禁评薪资：不要评估、提及或核查薪资——hard_check 里禁止出现薪资项，reason 里也不要谈薪资。
缺口铁律：missing 只允许硬性缺口——具体技能、工具、经验类型、证书、学历（如"不会PS"、"无短视频剪辑经验"）；心态、热情、抗压、沟通、学习能力、责任心等软性素质一律禁止列入 missing（软性素质无法"补录"，只能在 reason 里提一句）。`;
    const user = JSON.stringify({
      岗位: { 标题: jdObj.title, JD: (jdObj.body || "").slice(0, 2200) },
      候选人: { 概况: profileG.headline || "", 个人优势: (profileG.summary || "").slice(0, 150) },
      经历库: digest
    });
    const res = await llmChat([{ role: "system", content: sys }, { role: "user", content: user }]);
    if (res && res.content) {
      try {
        const obj = JSON.parse(res.content);
        if (typeof obj.score === "number") {
          if (Array.isArray(obj.missing)) obj.missing = obj.missing.filter(s => !SOFT_RE.test(String(s)));  // 本地兜底：软性素质不进缺口
          if (Array.isArray(obj.hard_check)) obj.hard_check = obj.hard_check.filter(h => !/薪资|薪酬|工资|待遇/.test(typeof h === "string" ? h : ((h && h.item) || "") + ((h && h.note) || "")));  // 薪资核查已下线
          cache[key] = { at: Date.now(), data: obj };
          const keys = Object.keys(cache);
          if (keys.length > 60) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 60).forEach(k => delete cache[k]);
          await sset({ atomcv_llmcache: cache });
          return { data: obj, error: null };
        }
        return { data: null, error: "返回格式异常" };
      } catch (e) { return { data: null, error: "解析失败" }; }
    }
    return { data: null, error: (res && res.error) || "无响应" };
  }

  async function runAI(cacheOnly, force) {
    const { atomcv_llm: cfg = {} } = await sget(["atomcv_llm"]);
    if (!cfg.key) { aiState = "nokey"; rerenderDiagIfVisible(); return; }
    aiState = cacheOnly ? aiState : "loading"; aiDiag = null;
    const myJd = jd;
    if (!cacheOnly) rerenderDiagIfVisible();
    const r = await aiScoreJd(jd, cacheOnly, force);
    if (jd !== myJd) return;
    if (r.data) { aiDiag = r.data; aiState = "done"; }
    else if (r.error === "CACHE_MISS") { aiState = "need"; }
    else { aiState = r.error === "NO_KEY" ? "nokey" : "error"; aiErr = r.error || ""; }
    updateBadgeAI(); rerenderDiagIfVisible();
  }

  function aiColor(s) { return s >= 75 ? "#0f9d78" : s >= 50 ? "#b7791f" : "#8a94a0"; }
  function updateBadgeAI() {
    if (aiState !== "done" || !aiDiag) return;
    $("badge").style.background = aiColor(aiDiag.score);
    $("bNum").textContent = aiDiag.score + "%";
    $("bLbl").textContent = "AI匹配";
  }
  function getCandidates() {
    if (aiDiag && Array.isArray(aiDiag.relevant_atom_ids) && aiDiag.relevant_atom_ids.length) {
      const list = aiDiag.relevant_atom_ids.map(id => {
        const a = atoms.find(x => x.id === id);
        return a ? { atom: a, matched: [], score: 0 } : null;
      }).filter(Boolean);
      if (list.length) return list;
    }
    return diag.relevant;
  }

  function updateBadge() {
    const v = E.verdict(diag.rate);
    $("badge").style.display = "flex";
    $("badge").style.background = v.color;
    $("bNum").textContent = diag.rate + "%";
    $("bLbl").textContent = "匹配分";
  }

  // ---------- ① 诊断（唯一主按钮：生成简历图片）----------
  function renderDiagnosis() {
    view = "diag";
    const v = E.verdict(diag.rate);
    $("hdTitle").textContent = jd.title ? `· ${jd.title}` : "";
    if (diag.req.size === 0) {
      $("body").innerHTML = `<div class="empty">从这个 JD 里没识别出能和你经历库比对的能力项。<br>可以把 JD 粘到下面重新分析：</div>
        <textarea class="paste" id="paste2"></textarea>`;
      $("btns").innerHTML = `<button class="btn pri" id="an2">重新分析</button>`;
      $("an2").onclick = () => {
        const t = root.getElementById("paste2").value.trim();
        if (!t) return;
        jd.body = t; diag = E.diagnose(jd.body, atoms); selected = null; resumeDoc = null; resumeAI = false;
        aiDiag = null; aiState = "idle"; runAI().catch(() => {});
        updateBadge(); renderDiagnosis();
      };
      return;
    }
    const demoWarn = atoms.some(a => a.demo);
    const warnHtml = demoWarn ? `<div class="next" style="background:#fdf3e2;border-left-color:#b7791f;color:#7a5512;margin:0 0 10px">
        ⚠️ <b>你还在用演示示例库</b>——生成的简历会是假内容！<span style="text-decoration:underline;cursor:pointer" id="goLib">点此去导入你的真实简历</span></div>` : "";

    if (aiState === "done" && aiDiag) {
      const c = aiColor(aiDiag.score);
      $("body").innerHTML = `${warnHtml}
        <div class="score-row"><span class="big" style="color:${c}">${aiDiag.score}%</span>
          <div class="meter"><i style="width:${aiDiag.score}%;background:${c}"></i></div></div>
        <div class="verdict" style="color:${c}">🤖 ${esc(aiDiag.verdict || "")}：${esc(aiDiag.reason || "")}</div>
        ${(aiDiag.hard_check || []).length ? `<div class="sec">📋 硬性条件核查</div>
        <div>${aiDiag.hard_check.map(h => {
          if (typeof h === "string") return `<div class="verdict" style="font-weight:400;margin:2px 0;color:#57606a">${esc(h)}</div>`;
          return `<div class="verdict" style="font-weight:400;margin:2px 0;color:${h.result === "不符" ? "#b4453a" : h.result === "符合" ? "#0f9d78" : "#8a94a0"}">${h.result === "不符" ? "✗" : h.result === "符合" ? "✓" : "?"} ${esc(h.item)}：${esc(h.note || h.result)}</div>`;
        }).join("")}</div>` : ""}
        <div class="sec">✅ 能力匹配（${(aiDiag.covered || []).length} 项，均有真实经历支撑）</div>
        <div class="chips">${(aiDiag.covered || []).map(cv => `<span class="chip">${esc(cv.ability)}</span>`).join("") || "<span class='tip'>无</span>"}</div>
        <div class="sec">⚠️ 硬性缺口（点击记入补录清单）</div>
        <div class="chips">${(aiDiag.missing || []).map(s => `<span class="chip miss" data-s="${esc(s)}">${esc(s)} +补录</span>`).join("") || "<span class='chip'>无明显缺口 🎉</span>"}</div>
        ${(aiDiag.missing || []).length ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button class="btn" id="rescore" style="padding:6px 12px;font-size:12px">🔄 我已补录，重新打分</button>
          <span class="tip" id="rescoreTip" style="margin:0">补齐经历后点这里，用最新经历库重新分析</span></div>` : ""}
        <div class="tip">由 DeepSeek 分析（本地规则版：${diag.rate}%）· 结果已缓存，同岗位不重复计费</div>`;
    } else {
      const aiLine = aiState === "loading" ? `<div class="verdict" style="color:#4f46e5;font-weight:400">🤖 DeepSeek 深度分析中…（先看本地规则版结果）</div>`
        : aiState === "nokey" ? `<div class="verdict" style="color:#98a2ae;font-weight:400">💡 <span style="text-decoration:underline;cursor:pointer" id="goKey">接入 DeepSeek API 可大幅提升匹配精度 →</span></div>`
        : aiState === "error" ? `<div class="verdict" style="color:#b7791f;font-weight:400">⚠️ AI 分析失败（${esc(aiErr)}），以下为本地规则版结果</div>`
        : aiState === "need" ? `<button class="btn pri" id="aiGo" style="width:100%;margin:8px 0;background:#4f46e5">🤖 AI 精准分析这个岗位</button>
          <div class="tip" style="margin:-2px 0 6px">上面是免费粗算分 · 点按钮用 DeepSeek 深度分析（同岗位只计费一次）</div>` : "";
      const missN = diag.missing.length;
      let vText;
      if (diag.rate >= 75) vText = missN ? `值得投：已覆盖 ${diag.covered.size}/${diag.req.size} 项核心要求` : "值得投：识别出的要求全部覆盖";
      else if (diag.rate >= 50) vText = missN
        ? `可以投：已覆盖 ${diag.covered.size}/${diag.req.size} 项，补齐缺口更稳`
        : `可以投：识别出的 ${diag.req.size} 项要求已全部覆盖（可比对项较少，评分保守）`;
      else vText = missN ? `谨慎投：仅覆盖 ${diag.covered.size}/${diag.req.size} 项要求` : "谨慎投：可比对信息太少，建议人工阅读 JD 判断";
      $("body").innerHTML = `${warnHtml}
        <div class="score-row"><span class="big" style="color:${v.color}">${diag.rate}%</span>
          <div class="meter"><i style="width:${diag.rate}%;background:${v.color}"></i></div></div>
        <div class="verdict" style="color:${v.color}">${vText}<span style="color:#98a2ae;font-weight:400">（75% 为建议投递线）</span></div>
        ${aiLine}
        ${(() => {
          const sc = E.salaryCheck(jd.salary, profileG.salary);
          let rows = "";
          if (sc) rows += `<div class="verdict" style="color:${sc.ok ? "#0f9d78" : "#b4453a"};font-weight:${sc.ok ? "400" : "700"}">${sc.text}</div>`;
          return rows;
        })()}
        <div class="sec">✅ 已覆盖能力（${diag.covered.size}/${diag.req.size}${diag.matchedAtomN < 2 ? " · 仅1段经历支撑" : ""}）</div>
        <div class="chips">${[...diag.covered.keys()].map(s=>`<span class="chip">${esc(s)}</span>`).join("")}</div>
        <div class="sec">⚠️ 硬性缺口（点击记入补录清单）</div>
        <div class="chips">${diag.missing.map(s=>`<span class="chip miss" data-s="${esc(s)}">${esc(s)} +补录</span>`).join("")||"<span class='chip'>识别出的要求全部覆盖 🎉</span>"}</div>
        ${diag.missing.length ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button class="btn" id="rescore" style="padding:6px 12px;font-size:12px">🔄 我已补录，重新打分</button>
          <span class="tip" id="rescoreTip" style="margin:0">补齐经历后点这里，用最新经历库重新分析</span></div>` : ""}
        ${diag.lowSignal ? `<div class="tip">⚠️ 该 JD 只识别出 ${diag.req.size} 项可比对要求，评分偏保守，建议同时人工阅读 JD</div>` : ""}`;
      const gk = root.getElementById("goKey");
      if (gk) gk.onclick = () => chrome.runtime.sendMessage({ type: "openDashboard" });
      const ag = root.getElementById("aiGo");
      if (ag) ag.onclick = () => { aiState = "idle"; runAI().catch(() => {}); };
    }
    const gl0 = root.getElementById("goLib");
    if (gl0) gl0.onclick = () => chrome.runtime.sendMessage({ type: "openDashboard" });
    $("body").querySelectorAll(".chip.miss").forEach(ch => ch.onclick = async () => {
      const { atomcv_gaps: gaps = [] } = await sget(["atomcv_gaps"]);
      gaps.unshift({ skill: ch.dataset.s, jobTitle: jd.title, company: jd.company, at: Date.now() });
      await sset({ atomcv_gaps: gaps });
      ch.textContent = ch.dataset.s + " ✓已记入";
      ch.style.background = "#e6f6ef"; ch.style.color = "#0f9d78";
      const tp = root.getElementById("rescoreTip");
      if (tp) tp.textContent = "✓ 已记入补录清单 — 去插件主页「补录访谈」把经历补进库，再回来点重新打分";
    });
    const rs = root.getElementById("rescore");
    if (rs) rs.onclick = async () => {
      rs.disabled = true; rs.textContent = "⏳ 重新分析中…";
      atoms = await loadAtoms();
      diag = E.diagnose(jd.body, atoms);
      selected = null; resumeDoc = null; resumeAI = false;
      updateBadge();
      await runAI(false, true);
    };
    $("btns").innerHTML = `<button class="btn pri" id="gen">⚡ 生成定制简历图片</button>`;
    $("gen").onclick = () => renderImageState();
  }

  // ---------- ② 定制简历：AI 改写提炼 → 预览/编辑/指令修改 → 一键发送 ----------
  let resumeDoc = null, resumeAI = false;

  function docFromRule() {
    const cands = getCandidates();
    const order = { work: 0, project: 1, skill: 2, education: 3, award: 4, other: 5 };
    const map = new Map();
    const push = (a, bullet) => {
      const k = a.type + "|" + (a.org || "") + "|" + (a.title || "") + "|" + (a.time || "");
      if (!map.has(k)) map.set(k, { type: a.type, org: a.org || "", title: a.title || "", time: a.time || "", bullets: [] });
      map.get(k).bullets.push(bullet);
    };
    cands.forEach(x => push(x.atom, x.atom.bullet || x.atom.raw));
    atoms.filter(a => a.type === "education").forEach(a => {
      const k = "education|" + (a.org || "") + "|" + (a.title || "") + "|" + (a.time || "");
      if (!map.has(k)) push(a, a.bullet || a.raw);
    });
    return { summary: profileG.summary || "", changes: "", sections: [...map.values()].sort((p, q) => (order[p.type] ?? 9) - (order[q.type] ?? 9)) };
  }

  function docToRenderSections(doc) {
    const label = { work: "工作经历", project: "项目经历", skill: "专业技能", education: "教育经历", award: "荣誉奖项", other: "其他" };
    const order = { work: 0, project: 1, skill: 2, education: 3, award: 4, other: 5 };
    const byType = new Map();
    (doc.sections || []).forEach(s => {
      if (!byType.has(s.type)) byType.set(s.type, []);
      (s.bullets || []).forEach(b => byType.get(s.type).push({ atom: { type: s.type, org: s.org, title: s.title, time: s.time, bullet: b, raw: b } }));
    });
    return [...byType.entries()].sort((p, q) => (order[p[0]] ?? 9) - (order[q[0]] ?? 9))
      .map(([t, items]) => ({ type: t, label: label[t] || t, items }));
  }

  async function aiWriteResume(instruction) {
    const { atomcv_llm: cfg = {} } = await sget(["atomcv_llm"]);
    if (!cfg.key) return null;
    const cacheKey = "rw" + jdHash((jd.body || "").slice(0, 2000) + "|" + atoms.length);
    if (!instruction) {
      const { atomcv_llmcache: cache = {} } = await sget(["atomcv_llmcache"]);
      if (cache[cacheKey] && cache[cacheKey].data) return cache[cacheKey].data;
    }
    const digest = atoms.map(a => ({
      type: a.type, org: a.org || "", title: a.title || "", time: a.time || "",
      原文: (a.raw || a.bullet || "").slice(0, 200), 已有表述: (a.bullet || "").slice(0, 100)
    }));
    const sys = `你是资深简历撰写专家，根据岗位JD为候选人撰写定制简历。铁律：
1) 公司名、职位、时间、量化数字等事实必须原样保留，严禁编造新的事实、项目、数字；
2) 不允许删除任何一段工作/项目经历——与岗位不直接相关的经历，要换角度改写、提炼其中与岗位要求相关的可迁移软性能力（如团队搭建、从0到1、客户理解、跨部门协调、抗压执行），而不是删掉；时间线必须完整；
3) 每条bullet的内容必须能从经历库原文中找到事实依据，表述可围绕JD重写、合并、延伸；
4) "个人优势"可结合JD重写，突出最相关的真实亮点；教育经历保留。
只输出JSON：{"summary":"个人优势段","changes":"一句话说明做了哪些角度调整","sections":[{"type":"work|project|skill|education","org":"公司","title":"职位","time":"时间段","bullets":["条目1","条目2"]}]}`;
    const user = instruction
      ? JSON.stringify({ 岗位JD: (jd.body || "").slice(0, 1500), 当前简历: resumeDoc, 用户修改要求: instruction, 经历库事实依据: digest })
      : JSON.stringify({ 岗位: { 标题: jd.title, JD: (jd.body || "").slice(0, 2200) }, 候选人个人优势: profileG.summary || "", 经历库: digest });
    const res = await llmChat([{ role: "system", content: sys }, { role: "user", content: user }]);
    if (res && res.content) {
      try {
        const doc = JSON.parse(res.content);
        if (doc && Array.isArray(doc.sections) && doc.sections.length) {
          if (!instruction) {
            const { atomcv_llmcache: cache = {} } = await sget(["atomcv_llmcache"]);
            cache[cacheKey] = { at: Date.now(), data: doc };
            await sset({ atomcv_llmcache: cache });
          }
          return doc;
        }
      } catch (e) { /* fallthrough */ }
    }
    return null;
  }

  async function renderCanvasFromDoc() {
    const cv = window.AtomCVImage.renderResume(docToRenderSections(resumeDoc), { ...profileG, summary: resumeDoc.summary || "" }, jd.title);
    lastBlob = await new Promise(r => cv.toBlob(r, "image/png"));
    return cv;
  }

  async function persistOutputs(dataUrl) {
    await upsertBoardCard({
      id: "job_" + Date.now(), title: jd.title || "未识别岗位", company: jd.company || "",
      url: jd.url, rate: (aiDiag ? aiDiag.score : diag.rate), covered: aiDiag ? (aiDiag.covered || []).map(c => c.ability) : [...diag.covered.keys()],
      missing: aiDiag ? (aiDiag.missing || []) : diag.missing,
      jdBody: (jd.body || "").slice(0, 4000), status: "想投", at: Date.now()
    });
    await sset({ atomcv_last: { title: jd.title, company: jd.company, rate: (aiDiag ? aiDiag.score : diag.rate), jdBody: (jd.body || "").slice(0, 4000), dataUrl, at: Date.now() } });
  }

  async function renderImageState() {
    view = "img";
    const inChat = isChatPage() && findChatFileInput();
    if (!resumeDoc) {
      $("body").innerHTML = `<div class="empty">🤖 AI 正在按岗位要求撰写定制简历…<br><span class="tip">保留全部经历、提炼可迁移能力，事实不会被改动</span></div>`;
      $("btns").innerHTML = "";
      const doc = await aiWriteResume("");
      if (view !== "img") return;
      resumeAI = !!doc;
      resumeDoc = doc || docFromRule();
    }
    const cv = await renderCanvasFromDoc();
    const dataUrl = cv.toDataURL("image/png");
    await persistOutputs(dataUrl);

    const { atomcv_llm: cfg = {} } = await sget(["atomcv_llm"]);
    const greet = buildGreeting(profileG);
    const canOneClick = !inChat && !!findCommunicateBtn();
    const setupWarn = atoms.some(a => a.demo) || !profileG.name || profileG.name === "求职者";
    $("body").innerHTML = `
      ${setupWarn ? `<div class="next" style="background:#fdf3e2;border-left-color:#b7791f;color:#7a5512;margin:0 0 10px">
        ⚠️ ${atoms.some(a => a.demo) ? "这份简历用的是<b>演示示例数据</b>！" : ""}${(!profileG.name || profileG.name === "求职者") ? "姓名未设置。" : ""}
        <span style="text-decoration:underline;cursor:pointer" id="goLib2">去设置</span></div>` : ""}
      ${queueInfo ? `<div class="next" style="background:#eef0ff;border-left-color:#4f46e5;color:#3730a3;margin:0 0 10px">🚀 流水线 ${queueInfo.idx + 1}/${queueInfo.items.length}：确认后发送，或跳过换下一个</div>` : ""}
      <div class="imgwrap" id="imgWrap" title="点击放大预览" style="cursor:zoom-in"></div>
      ${resumeAI ? `<div class="tip">🤖 AI 已按岗位改写提炼（保留全部经历、事实未变）${resumeDoc.changes ? "：" + esc(resumeDoc.changes) : ""}</div>` : `<div class="tip">按规则组装（接入 AI 后可按岗位改写提炼）</div>`}
      ${cfg.key ? `
      <div class="sec">✍️ 哪里不满意？直接说，AI 帮你改</div>
      <textarea class="paste" id="rev" style="min-height:54px" placeholder="例：个人优势再突出客户资源；把第二段经历往项目管理方向写；语气更商务一些…"></textarea>
      <div class="row" style="margin:6px 0 0;display:flex;gap:8px">
        <button class="btn sec2" id="revBtn" style="flex:none;padding:7px 16px">按说明修改</button>
        <span class="tip" id="revMsg"></span>
      </div>` : ""}
      <div class="sec">💬 招呼语（可编辑）</div>
      <textarea class="paste" id="greet" style="min-height:70px">${esc(greet)}</textarea>
      ${inChat
        ? `<div class="next">确认无误后点「发进聊天」，你在页面上做最后确认。</div>`
        : canOneClick
          ? `<div class="next">🚀 确认无误后点「发送简历并打招呼」：自动进入聊天并发出招呼语和这份简历。</div>`
          : `<div class="next">📌 点页面上的「<b>立即沟通</b>」进入聊天后，点右侧「求职助手」角标，这份简历会在那里等你。</div>`}
      <div class="tip" id="imgMsg"><span id="dl" style="text-decoration:underline;cursor:pointer">下载PNG</span> · <span id="cp" style="text-decoration:underline;cursor:pointer">复制图片</span>（聊天框可直接粘贴）</div>`;
    cv.style.width = "100%";
    $("imgWrap").appendChild(cv);

    $("imgWrap").onclick = () => {
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;background:rgba(15,20,30,.82);z-index:2147483100;overflow:auto;padding:30px;cursor:zoom-out;text-align:center";
      const img = document.createElement("img");
      img.src = dataUrl;
      img.style.cssText = "width:min(880px,95%);background:#fff;border-radius:8px;box-shadow:0 10px 50px rgba(0,0,0,.5)";
      ov.appendChild(img);
      ov.onclick = () => ov.remove();
      document.documentElement.appendChild(ov);
    };
    const gl2 = root.getElementById("goLib2");
    if (gl2) gl2.onclick = () => chrome.runtime.sendMessage({ type: "openDashboard" });
    $("dl").onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(lastBlob); a.download = `简历_${jd.title || "定制版"}.png`; a.click();
    };
    $("cp").onclick = async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": lastBlob })]);
        $("imgMsg").innerHTML = "✅ 已复制，去聊天框粘贴发送";
      } catch (e) { $("imgMsg").innerHTML = "复制受限，请用下载"; }
    };
    const rb = root.getElementById("revBtn");
    if (rb) rb.onclick = async () => {
      const ins = root.getElementById("rev").value.trim();
      if (!ins) return;
      rb.textContent = "AI 修改中…"; rb.disabled = true;
      const doc = await aiWriteResume(ins);
      if (doc) { resumeDoc = doc; resumeAI = true; renderImageState(); }
      else { rb.textContent = "按说明修改"; rb.disabled = false; root.getElementById("revMsg").textContent = "修改失败，请重试"; }
    };

    $("btns").innerHTML = `${queueInfo ? `<button class="btn sec2" id="qskip">跳过→</button>` : `<button class="btn sec2" id="back">返回</button>`}
      <button class="btn sec2" id="edit">✏️ 编辑</button>
      ${inChat ? `<button class="btn pri" id="tochat">发进聊天</button>` : ""}
      ${canOneClick ? `<button class="btn pri" id="oneclick">发送简历<br>并打招呼</button>` : ""}
      ${(!inChat && !canOneClick) ? `<button class="btn pri" id="cp2">复制图片</button>` : ""}`;
    const backBtn = root.getElementById("back");
    if (backBtn) backBtn.onclick = renderDiagnosis;
    const qs = root.getElementById("qskip");
    if (qs) qs.onclick = async () => {
      const r = await advanceQueue();
      if (r && !r.done) location.href = r.next.url;
      else { $("body").innerHTML = `<div class="empty">🏁 流水线完成！本轮处理 ${r ? r.total : "全部"} 个岗位。</div>`; $("btns").innerHTML = ""; }
    };
    $("edit").onclick = renderEditState;
    const cp2 = root.getElementById("cp2");
    if (cp2) cp2.onclick = () => $("cp").onclick();
    const tc = root.getElementById("tochat");
    if (tc) tc.onclick = () => sendBlobToChat(lastBlob, $("imgMsg"));
    const oc = root.getElementById("oneclick");
    if (oc) oc.onclick = async () => {
      const g = root.getElementById("greet") ? root.getElementById("greet").value.trim() : greet;
      await sset({ atomcv_pending: { greet: g, dataUrl, title: jd.title, company: jd.company, at: Date.now() } });
      const { atomcv_board: b = [] } = await sget(["atomcv_board"]);
      const c = b.find(x => x.url === jd.url || (x.title === jd.title && x.company === jd.company));
      if (c) { c.status = "已招呼"; await sset({ atomcv_board: b }); }
      oc.textContent = "跳转聊天中…";
      const btn = findCommunicateBtn();
      if (btn) {
        btn.click();
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          const cont = [...document.querySelectorAll("a,button,span,div")]
            .find(el => el.childElementCount === 0 && /^继续沟通$/.test((el.innerText || "").trim()));
          if (cont) { clearInterval(timer); cont.click(); }
          if (tries > 16) clearInterval(timer);
        }, 300);
      }
    };
  }

  // ---------- ②b 手动编辑简历 ----------
  function renderEditState() {
    view = "edit";
    const doc = resumeDoc;
    $("body").innerHTML = `
      <div class="sec">✏️ 手动编辑（改完点「完成」重新生成图片）</div>
      <div class="sec">个人优势</div>
      <textarea class="paste" id="eSummary" style="min-height:60px">${esc(doc.summary || "")}</textarea>
      <div id="eSecs">${doc.sections.map((s, si) => `
        <div class="sec" style="margin-top:14px">${{ work: "工作经历", project: "项目经历", skill: "专业技能", education: "教育经历" }[s.type] || s.type} · ${esc(s.org || "")} ${esc(s.title || "")} <span style="color:#c3cad2">${esc(s.time || "")}</span></div>
        ${s.bullets.map((b, bi) => `
          <div style="display:flex;gap:6px;margin:5px 0;align-items:flex-start">
            <textarea class="paste" data-si="${si}" data-bi="${bi}" style="min-height:44px;margin-top:0;flex:1">${esc(b)}</textarea>
            <button class="x-del" data-si="${si}" data-bi="${bi}" style="border:none;background:#fbecec;color:#b4453a;border-radius:6px;cursor:pointer;padding:4px 8px;font-size:12px">删</button>
          </div>`).join("")}
        <div style="margin:2px 0 8px"><span class="tip" style="text-decoration:underline;cursor:pointer" data-add="${si}">＋ 给这段加一条</span></div>`).join("")}
      </div>`;
    $("btns").innerHTML = `<button class="btn sec2" id="eCancel">取消</button><button class="btn pri" id="eDone">✅ 完成，重新生成</button>`;
    const collect = () => {
      const newDoc = JSON.parse(JSON.stringify(doc));
      newDoc.summary = root.getElementById("eSummary").value.trim();
      $("body").querySelectorAll("textarea[data-si]").forEach(t => {
        const si = +t.dataset.si, bi = +t.dataset.bi;
        newDoc.sections[si].bullets[bi] = t.value.trim();
      });
      newDoc.sections.forEach(s => s.bullets = s.bullets.filter(b => b && b !== "__DEL__"));
      return newDoc;
    };
    $("body").querySelectorAll(".x-del").forEach(btn => btn.onclick = () => {
      doc.sections[+btn.dataset.si].bullets[+btn.dataset.bi] = "__DEL__";
      btn.closest("div").style.display = "none";
    });
    $("body").querySelectorAll("[data-add]").forEach(sp => sp.onclick = () => {
      resumeDoc = collect();
      resumeDoc.sections[+sp.dataset.add].bullets.push("（写点什么…）");
      renderEditState();
    });
    $("eCancel").onclick = () => renderImageState();
    $("eDone").onclick = () => { resumeDoc = collect(); renderImageState(); };
  }

  function buildGreeting(profile) {
    if (aiDiag && aiDiag.greeting) return aiDiag.greeting;
    const tpl = (profile && profile.greetTpl) ||
      "您好！看到贵司「{岗位}」的招聘，我的经验与要求高度契合（{能力}），已按岗位要求整理了一份针对性简历（见图片），期待与您进一步沟通！";
    const skills = [...diag.covered.keys()].slice(0, 4).join("、");
    return tpl.replace(/\{岗位\}/g, jd.title || "该岗位").replace(/\{公司\}/g, jd.company || "贵司").replace(/\{能力\}/g, skills || "详见简历");
  }

  function findCommunicateBtn() {
    return [...document.querySelectorAll("a,button,div[role='button'],span")]
      .find(el => el.childElementCount <= 1 && /^(立即沟通|继续沟通)$/.test((el.innerText || "").trim()) &&
        el.offsetWidth > 0) || null;
  }

  // 往聊天输入框写入文字并发送（增强版：Boss 常用 #chat-input / .chat-input contenteditable）
  function findChatEditor() {
    return document.querySelector("#chat-input") ||
      document.querySelector(".chat-input[contenteditable='true'], .chat-input") ||
      [...document.querySelectorAll("[contenteditable='true'], textarea, input[type='text']")]
        .find(el => el.offsetWidth > 100 && !el.closest("#atomcv-host")) || null;
  }
  async function sendTextToChat(text) {
    const editor = findChatEditor();
    if (!editor) return { found: false, cleared: false };
    editor.focus();
    if (editor.isContentEditable || (editor.getAttribute && editor.getAttribute("contenteditable") === "true")) {
      // execCommand 能触发大多数框架的受控更新
      document.execCommand("selectAll", false, null);
      const ok = document.execCommand("insertText", false, text);
      if (!ok) { editor.innerText = text; }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value");
      if (setter && setter.set) setter.set.call(editor, text); else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 300));
    // 发送：优先点「发送」按钮，否则完整回车事件序列
    const sendBtn = [...document.querySelectorAll("button,a,div[role='button'],span")]
      .find(el => el.childElementCount === 0 && /^发\s*送$/.test((el.innerText || "").trim()) && el.offsetWidth > 0);
    if (sendBtn) sendBtn.click();
    else {
      const kev = t => new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
      editor.dispatchEvent(kev("keydown")); editor.dispatchEvent(kev("keypress")); editor.dispatchEvent(kev("keyup"));
    }
    await new Promise(r => setTimeout(r, 500));
    const left = (editor.isContentEditable ? editor.innerText : editor.value) || "";
    return { found: true, cleared: left.trim().length === 0 };
  }

  function sendBlobToChat(blob, msgEl) {
    const fi = findChatFileInput();
    if (!fi) { if (msgEl) msgEl.textContent = "没找到聊天的图片入口，请用复制/下载方式发送"; return; }
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "resume.png", { type: "image/png" }));
    fi.files = dt.files;
    fi.dispatchEvent(new Event("change", { bubbles: true }));
    if (msgEl) msgEl.textContent = "✅ 已放入发送框，请在页面上确认发送";
  }

  // ---------- ③a 聊天页：执行"一键沟通并发送"的待发任务 ----------
  // 修复双发：任务领取即销毁（先清 pending 再执行），外加执行锁
  async function runPendingSend(pending) {
    if (window.__atomcvSending) return;
    window.__atomcvSending = true;
    await sset({ atomcv_pending: null }); // 领取即销毁，页面刷新/URL变化不会再触发第二次
    $("badge").style.display = "flex";
    $("bNum").textContent = "🚀";
    $("bLbl").textContent = "发送中";
    $("badge").style.background = "#4f46e5";
    $("panel").classList.add("open");
    $("hdTitle").textContent = `· ${pending.title || "投递"}`;
    $("body").innerHTML = `<div class="sec">🚀 正在自动发送</div>
      <div class="tip" id="st1">① 发送招呼语…</div>
      <div class="tip" id="st2">② 发送简历图片…</div>
      <div class="tip" style="color:#b7791f">提示：Boss 会先自动发出你在 Boss 设置的默认招呼语，随后才是这里的定制招呼语。想只发定制版，可在 Boss「消息设置-招呼语」里关闭默认招呼。</div>
      <div class="next" id="stMsg">请稍候，全部完成后你可以在聊天里核对。</div>`;
    $("btns").innerHTML = "";
    // 保底：先把招呼语放进剪贴板（限时，防止权限弹窗把流程卡死）
    await Promise.race([
      navigator.clipboard.writeText(pending.greet).catch(() => {}),
      new Promise(r => setTimeout(r, 800))
    ]);
    // 等聊天输入框就绪（最多 ~16 秒）
    let res = { found: false, cleared: false }, tries = 0;
    while (tries++ < 20 && !res.found) {
      await new Promise(r => setTimeout(r, 800));
      res = await sendTextToChat(pending.greet);
    }
    const ok1 = res.found && res.cleared;
    root.getElementById("st1").textContent = ok1
      ? "① 招呼语已发送 ✅"
      : res.found
        ? "① 招呼语已填入输入框，但未确认发出——请到聊天框按回车（文字已备好）"
        : "① 没找到聊天输入框——招呼语已复制到剪贴板，请粘贴发送";
    await new Promise(r => setTimeout(r, 800));
    const blob = await (await fetch(pending.dataUrl)).blob();
    const fi = findChatFileInput();
    let ok2 = false;
    if (fi) {
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "resume.png", { type: "image/png" }));
      fi.files = dt.files;
      fi.dispatchEvent(new Event("change", { bubbles: true }));
      ok2 = true;
    }
    root.getElementById("st2").textContent = ok2 ? "② 简历图片已放入发送通道 ✅（如弹出预览请点确认，只发这一次）" : "② 图片入口未找到，请点下方「复制图片」后粘贴发送";
    root.getElementById("stMsg").innerHTML = (ok1 && ok2)
      ? "✅ 完成！看板状态已更新为「已招呼」。"
      : "部分步骤需要你手动补一下（见上方说明）。";
    const { atomcv_queue: qNow } = await sget(["atomcv_queue"]);
    const inQueue = qNow && qNow.active;
    $("btns").innerHTML = `<button class="btn sec2" id="cpImg">复制图片</button>
      ${inQueue ? `<button class="btn pri" id="qnext">下一个岗位 →</button>` : `<button class="btn pri" id="fin">完成</button>`}`;
    const qn = root.getElementById("qnext");
    if (qn) qn.onclick = async () => {
      const r = await advanceQueue();
      if (r && !r.done) { qn.textContent = `跳转中… (${r.idx + 1}/${r.total})`; location.href = r.next.url; }
      else { $("body").innerHTML = `<div class="empty">🏁 流水线完成！本轮已全部处理。</div>`; $("btns").innerHTML = ""; }
    };
    root.getElementById("cpImg").onclick = async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); } catch (e) {}
    };
    const finBtn = root.getElementById("fin");
    if (finBtn) finBtn.onclick = () => $("panel").classList.remove("open");
    // 完成态角标：不再显示"发送中"
    $("bNum").textContent = "✅";
    $("bLbl").textContent = "已发送";
    $("badge").style.background = "#0f9d78";
    window.__atomcvSending = false;
  }

  // ---------- ③b 聊天页：接续刚才的岗位 ----------
  async function renderChatMode() {
    view = "chat";
    const { atomcv_pending: pending } = await sget(["atomcv_pending"]);
    if (pending && Date.now() - pending.at < 3 * 60 * 1000) { runPendingSend(pending); return; }
    $("badge").style.display = "flex";
    $("bNum").textContent = "📄";
    $("bLbl").textContent = "发简历";
    $("badge").style.background = "#4f46e5";
    $("hdTitle").textContent = "· 聊天页";
    const { atomcv_last: last } = await sget(["atomcv_last"]);
    const { atomcv_board: board = [] } = await sget(["atomcv_board"]);
    const withJd = board.filter(c => c.jdBody);
    const fresh = last && (Date.now() - last.at < 6 * 3600 * 1000);

    $("body").innerHTML = `
      ${fresh ? `
      <div class="cont">
        <div style="font-size:12px;color:#6b7683;margin-bottom:4px">刚才生成的简历（接上了，不用重来）：</div>
        <b>${esc(last.title || "定制简历")}</b> <span style="color:#6b7683;font-size:12.5px">${esc(last.company || "")}（匹配 ${last.rate}%）</span>
        <div class="tip" id="contMsg" style="margin-top:6px">点「发进聊天」放入发送框，你确认后发出；或复制后 Ctrl/Cmd+V。</div>
      </div>` : ""}
      <div class="sec">${fresh ? "或者，换一个岗位生成：" : "选择这个聊天对应的岗位（用它的 JD 定制）："}</div>
      ${withJd.length ? `<select id="pick">${withJd.map((c, i) =>
        `<option value="${i}">${esc(c.title)} · ${esc(c.company || "")}（${c.rate}%）</option>`).join("")}</select>` : ""}
      <textarea class="paste" id="chatPaste" placeholder="也可以直接把该岗位的 JD 粘到这里…"></textarea>`;
    $("btns").innerHTML = `
      ${fresh ? `<button class="btn sec2" id="contCp">复制图片</button><button class="btn pri" id="contSend">发进聊天</button>` : ""}
      <button class="btn ${fresh ? "sec2" : "pri"}" id="chatGen">生成简历图片</button>`;

    if (fresh) {
      const blobOf = async () => await (await fetch(last.dataUrl)).blob();
      $("contSend").onclick = async () => sendBlobToChat(await blobOf(), root.getElementById("contMsg"));
      $("contCp").onclick = async () => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": await blobOf() })]);
          root.getElementById("contMsg").textContent = "✅ 已复制，去聊天框粘贴发送";
        } catch (e) { root.getElementById("contMsg").textContent = "复制受限，请重新生成后下载"; }
      };
    }
    $("chatGen").onclick = () => {
      const pasted = root.getElementById("chatPaste").value.trim();
      let body = pasted, title = "", company = "";
      if (!pasted && withJd.length) {
        const c = withJd[Number(root.getElementById("pick").value)];
        body = c.jdBody; title = c.title; company = c.company;
      }
      if (!body) return;
      jd = { title, body, company, url: location.href.split("?")[0] };
      diag = E.diagnose(jd.body, atoms);
      selected = null; resumeDoc = null; resumeAI = false;
      renderImageState();
    };
  }

  // ---------- 其他状态 ----------
  function renderEmptyLib() {
    $("badge").style.display = "flex";
    $("bNum").textContent = "!";
    $("body").innerHTML = `<div class="empty">你的经历库还是空的。<br>先去建库，插件才能打分和生成简历。</div>`;
    $("btns").innerHTML = `<button class="btn pri" id="go">去建立经历库</button>`;
    $("go").onclick = () => chrome.runtime.sendMessage({ type: "openDashboard" });
  }
  let noJdSince = 0;
  function renderNoJD() {
    view = "nojd";
    if (!noJdSince) noJdSince = Date.now();
    if (Date.now() - noJdSince < 6000) {
      $("body").innerHTML = `<div class="empty">⏳ 正在识别页面岗位…<br><span style="font-size:12px;color:#98a2ae">页面加载完会自动开始分析</span></div>`;
      $("btns").innerHTML = "";
      setTimeout(() => { if (view === "nojd" && (!jd || !jd.body)) renderNoJD(); }, 6200);
      return;
    }
    $("body").innerHTML = `<div class="empty">没能从当前页面识别出 JD（仍在后台自动重试）。<br>也可以直接把岗位描述粘到下面：</div>
      <textarea class="paste" id="paste"></textarea>`;
    $("btns").innerHTML = `<button class="btn pri" id="an">分析匹配度</button>`;
    $("an").onclick = () => {
      const t = root.getElementById("paste").value.trim();
      if (!t) return;
      jd = { title: "", body: t, company: "", url: location.href.split("?")[0] };
      diag = E.diagnose(jd.body, atoms);
      selected = null; resumeDoc = null; resumeAI = false;
      aiDiag = null; aiState = "idle"; runAI().catch(() => {});
      updateBadge();
      renderDiagnosis();
    };
  }

  // ---------- 启动 ----------
  async function boot(retried) {
    if (window.__atomcvSending) return; // 自动发送执行中，不允许任何重绘打断
    atoms = await loadAtoms();
    profileG = await getProfile();
    if (!atoms.length) {
      if (!retried) { setTimeout(() => boot(true), 1500); return; }
      renderEmptyLib(); return;
    }
    if (isChatPage()) { renderChatMode(); return; }
    jd = extractJD();
    selected = null; aiDiag = null; aiState = "idle"; aiErr = ""; resumeDoc = null; resumeAI = false;
    if (!jd.body) {
      $("badge").style.display = "flex";
      $("bNum").textContent = "?";
      $("badge").style.background = "#8a94a0";
      renderNoJD();
      return;
    }
    noJdSince = 0;  // 已识别到岗位，复位"识别中"计时
    const q = await checkQueue();
    if (q) {
      const cur = q.items[q.idx];
      if (!jd.body && cur.jdBody) jd = { title: cur.title, body: cur.jdBody, company: cur.company || "", salary: cur.salary || "", url: location.href.split("?")[0] };
      diag = E.diagnose(jd.body, atoms);
      updateBadge();
      $("hdTitle").textContent = `· 流水线 ${q.idx + 1}/${q.items.length} · ${jd.title || ""}`.slice(0, 40);
      $("panel").classList.add("open");
      runAI().catch(() => {});
      renderImageState();
      return;
    }
    diag = E.diagnose(jd.body, atoms);
    updateBadge();
    runAI().catch(() => {});
    renderDiagnosis();
  }

  // 同 URL 下切换左侧岗位（全自动）：本地规则分即时刷新 + AI 自动分析（同岗位缓存不重复计费）
  function onJobSwitch(newJd) {
    jd = newJd; noJdSince = 0;
    selected = null; aiDiag = null; aiState = "idle"; aiErr = ""; resumeDoc = null; resumeAI = false;
    diag = E.diagnose(jd.body, atoms);
    updateBadge();
    $("hdTitle").textContent = jd.title ? `· ${jd.title}` : "";
    runAI().catch(() => {});
    renderDiagnosis();
  }
  // SPA 监听：URL 变化 → 完整重启动；URL 不变但详情内容变（搜索页点卡片）→ 全自动切换；
  // 识别自愈：页面异步加载导致 boot 时没抓到 JD 的，这里每秒重试，抓到即自动恢复
  const jdFp = o => (o.title || "") + "|" + (o.body || "").slice(0, 160);
  let lastUrl = location.href, lastFp = "";
  setInterval(() => {
    if (window.__atomcvSending) return;
    const urlChanged = location.href !== lastUrl;
    if (urlChanged) { lastUrl = location.href; lastFp = ""; boot(true); return; }
    if (isChatPage() || view === "img" || view === "edit") return;  // 生成/编辑中不打断
    const cur = extractJD();
    if (!cur.body) return;
    const fp = jdFp(cur);
    if (!jd || !jd.body) { lastFp = fp; boot(true); return; }  // 自愈：此前没识别到 JD，现在页面内容到位了
    if (!lastFp) { lastFp = fp; return; }
    if (fp !== lastFp) { lastFp = fp; onJobSwitch(cur); }
  }, 1000);

  boot();
})();
