/* AtomCV dashboard：经历库管理 + 投递看板 + 补录清单 */
const $ = id => document.getElementById(id);
const store = {
  get: keys => new Promise(r => chrome.storage.local.get(keys, r)),
  set: obj => new Promise(r => chrome.storage.local.set(obj, r))
};
function esc(s){const d=document.createElement("div");d.textContent=s||"";return d.innerHTML;}

/* Tabs */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
  t.classList.add("active"); $(t.dataset.t).classList.add("active");
});

/* ---------- 简历导入解析 v2（Boss 版式感知；下一版接 LLM） ---------- */
// 支持：2020.02-2022.07 / 2021年3月-至今 / 2011-2015 / 2020/02~2022/07 等
const DATE_RE = /((\d{4})\s*[年.\/-]\s*(\d{1,2})\s*月?|\d{4})\s*[-–—~～至到]+\s*(至今|现在|present|(\d{4})\s*[年.\/-]?\s*(\d{1,2})?\s*月?|\d{4})/i;
const SECTION_RE = /^(个人优势|自我评价|自我介绍|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|技能|专业技能|资格证书|荣誉奖项)[:：]?$/;

/* PDF → 按视觉行还原文本（同一 y 坐标的文本块拼成一行） */
async function pdfToText(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map(); // y(取整) -> [{x,str}]
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const y = Math.round(it.transform[5] / 3) * 3; // 3px 容差归行
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], str: it.str });
    });
    [...rows.keys()].sort((a, b) => b - a).forEach(y => {
      const line = rows.get(y).sort((a, b) => a.x - b.x).map(i => i.str).join(" ").trim();
      if (line) out.push(line);
    });
    out.push("");
  }
  return out.join("\n");
}
function extractSkillsFrom(text){
  const found = new Set();
  const V = AtomCVEngine.VOCAB;
  const t = text.toLowerCase();
  for (const canon in V) {
    if (V[canon].some(a=>t.includes(a.toLowerCase()))) found.add(canon);
  }
  // 英文技能词（SQL/Java/Figma/Photoshop…）
  (text.match(/[A-Za-z][A-Za-z0-9+#.]{1,18}/g)||[]).forEach(w=>{
    if (w.length>=2 && !/^(and|or|the|for|with|from|www|com|http|https)$/i.test(w)) found.add(w);
  });
  return [...found].slice(0,12);
}
function parseResume(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim());
  let section = "";          // 当前所处的简历分区
  let summary = [];          // 个人优势
  const blocks = []; let cur = null;
  for (const raw of lines){
    const l = raw.replace(/^[▎|]/,"").trim();
    if (!l) continue;
    const secM = l.match(SECTION_RE);
    if (secM) { if (cur) { blocks.push(cur); cur = null; } section = secM[1]; continue; }
    if (/^(个人优势|自我评价)/.test(section) || section === "自我介绍") { summary.push(l); continue; }
    if (DATE_RE.test(l)) { if (cur) blocks.push(cur); cur = { head:l, body:[], section }; }
    else if (cur) {
      // 过滤 Boss 版式的标签行
      if (/^(内容|业绩|描述)[:：]?$/.test(l)) continue;
      cur.body.push(l.replace(/^(内容|业绩|描述)[:：]\s*/,""));
    }
  }
  if (cur) blocks.push(cur);

  let atoms = blocks.map((b,i)=>{
    const m = b.head.match(DATE_RE);
    const time = m ? m[0].replace(/\s+/g,"") : "";
    const headRest = b.head.replace(DATE_RE,"").trim();
    const parts = headRest.split(/[\s·|、，,]{1,}/).filter(Boolean);
    const org = parts[0]||"", title = parts.slice(1).join(" ")||"";
    const bodyText = b.body.join("；");
    const isEdu = /教育/.test(b.section) || /大学|学院|本科|硕士|博士|专科/.test(b.head);
    const isProj = /项目/.test(b.section) || /项目/.test(headRest);
    return {
      id: "atom_" + Date.now() + "_" + i,
      type: isEdu ? "education" : (isProj ? "project" : "work"),
      org, title, time,
      raw: (bodyText || headRest).slice(0,600),
      bullet: (b.body[0]||headRest).replace(/^[·•\-\d.、]+/,"").slice(0,90),
      metrics: [],
      skills: extractSkillsFrom(b.head + " " + bodyText),
      ev: "导入简历自动解析"
    };
  });

  // 兜底：一个时间段都没识别出来 → 按段落拆，绝不空手而归
  let fallback = false;
  if (!atoms.length) {
    fallback = true;
    const paras = text.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p.length>=30);
    atoms = paras.slice(0,10).map((p,i)=>({
      id: "atom_" + Date.now() + "_p" + i,
      type: "work", org: "", title: "", time: "",
      raw: p.slice(0,600),
      bullet: p.split(/\n/)[0].replace(/^[·•\-\d.、]+/,"").slice(0,90),
      metrics: [], skills: extractSkillsFrom(p),
      ev: "导入简历自动解析（按段落）"
    }));
  }
  return { atoms, summary: summary.join(" ").slice(0,300), fallback };
}
let parsed = { atoms: [], summary: "", fallback: false };
$("impFile").onchange = async (e)=>{
  const f = e.target.files[0];
  if (!f) return;
  if (/\.pdf$/i.test(f.name)) {
    $("impFileMsg").textContent = "解析 PDF 中…";
    try {
      $("impText").value = await pdfToText(f);
      $("impFileMsg").textContent = "✅ PDF 文本已提取，点「解析简历」";
    } catch (err) { $("impFileMsg").textContent = "PDF 解析失败：" + err.message; }
  } else {
    $("impText").value = await f.text();
    $("impFileMsg").textContent = "✅ 已读取，点「解析简历」";
  }
};
$("impParse").onclick = ()=>{
  const text = $("impText").value.trim();
  if (!text) { $("impMsg").textContent = "⚠️ 先上传 PDF 或粘贴简历内容"; return; }
  parsed = parseResume(text);
  const { atoms: pa, summary, fallback } = parsed;
  $("impPreview").innerHTML = `
    <div class="card" style="border-color:${fallback?"#b7791f":"#0f9d78"}">
      ${fallback
        ? `没识别出时间段，已<b>按段落拆成 ${pa.length} 段</b>——先存入，再到「经历库」补公司/时间。`
        : `解析出 <b>${pa.length}</b> 段经历${summary?"，并识别出<b>个人优势</b>":""}（存入后可继续编辑）`}
      <div class="row" style="margin-bottom:0"><button class="btn" id="impSave">✅ 存入经历库（并清除示例数据）</button></div>
    </div>
    ${summary?`<div class="card"><div class="top"><span class="chip g">个人优势</span></div><div class="raw">${esc(summary)}</div></div>`:""}
    ${pa.map(a=>`
    <div class="card">
      <div class="top"><span class="chip">${{work:"工作",project:"项目",education:"教育"}[a.type]}</span>
        <span class="org">${esc(a.org)}</span><span class="role">${a.title?"· "+esc(a.title):""}</span>
        <span class="time">${esc(a.time)}</span></div>
      <div class="raw">${esc(a.raw.slice(0,140))}${a.raw.length>140?"…":""}</div>
      <div class="chips">${a.skills.length ? a.skills.map(s=>`<span class="chip">${esc(s)}</span>`).join("") : '<span class="chip" style="background:#fdf3e2;color:#b7791f">⚠️ 未识别出技能标签，请入库后补充</span>'}</div>
    </div>`).join("")}`;
  document.getElementById("impSave").onclick = async ()=>{
    const { atomcv_atoms: atoms = [], atomcv_profile: prof = {} } = await store.get(["atomcv_atoms","atomcv_profile"]);
    const kept = atoms.filter(a=>!a.demo);           // 自动清除示例数据
    await store.set({ atomcv_atoms: [...kept, ...parsed.atoms] });
    if (parsed.summary && !prof.summary) {
      await store.set({ atomcv_profile: { ...prof, summary: parsed.summary } });
      $("pSummary").value = parsed.summary;
    }
    $("impPreview").innerHTML = `<div class="card" style="border-color:#0f9d78">✅ 已存入 ${parsed.atoms.length} 段经历${parsed.summary?"（个人优势已存入个人信息）":""}，示例数据已清除。去「经历库」检查技能标签，越准打分越准。</div>`;
    renderLib();
  };
};

/* ---------- 经历库 ---------- */
async function renderLib(){
  const { atomcv_atoms: atoms = [] } = await store.get(["atomcv_atoms"]);
  const skills = new Set(); atoms.forEach(a=>(a.skills||[]).forEach(s=>skills.add(s)));
  const hasDemo = atoms.some(a=>a.demo);
  $("libStat").innerHTML = `${hasDemo ? `<div style="flex-basis:100%;background:#fdf3e2;border:1px solid #ecd9b0;border-radius:9px;padding:10px 14px;margin-bottom:6px;color:#7a5512;font-size:13.5px">
    ⚠️ <b>当前是演示用的示例经历库</b>——用它生成的简历都是假内容！请去「⬆ 导入简历」导入你自己的经历（存入时会自动清除示例）。</div>` : ""}
    <div><b>${atoms.length}</b><span>经历原子</span></div>
    <div><b>${skills.size}</b><span>覆盖能力</span></div>`;
  if(!atoms.length){
    $("libList").innerHTML = `<div class="empty">经历库是空的。<br>点下方「载入示例库」先体验，或在「＋录入经历」里写入你的真实经历。</div>`;
    return;
  }
  $("libList").innerHTML = atoms.map(a=>`
    <div class="card">
      <div class="top">
        <span class="chip">${{work:"工作",project:"项目",skill:"技能",education:"教育"}[a.type]||a.type}</span>
        ${a.org?`<span class="org">${esc(a.org)}</span>`:""}
        ${a.title?`<span class="role">· ${esc(a.title)}</span>`:""}
        ${a.time?`<span class="time">${esc(a.time)}</span>`:""}
        <button class="del" data-id="${a.id}">删除</button>
      </div>
      <div class="raw">${esc(a.raw)}</div>
      <div class="chips">${(a.metrics||[]).map(m=>`<span class="chip g">📈 ${esc(m)}</span>`).join("")}
        ${(a.skills||[]).map(s=>`<span class="chip">${esc(s)}</span>`).join("")}</div>
    </div>`).join("");
  document.querySelectorAll(".del").forEach(b=>b.onclick=async()=>{
    const { atomcv_atoms: as = [] } = await store.get(["atomcv_atoms"]);
    await store.set({ atomcv_atoms: as.filter(x=>x.id!==b.dataset.id) });
    renderLib();
  });
}
/* 个人信息（用于简历图片抬头） */
(async ()=>{
  const { atomcv_profile: p = {}, atomcv_llm: l = {} } = await store.get(["atomcv_profile","atomcv_llm"]);
  $("pName").value = p.name || ""; $("pHead").value = p.headline || ""; $("pTpl").value = p.greetTpl || "";
  $("pInfo").value = p.info || ""; $("pSalary").value = p.salary || ""; $("pSummary").value = p.summary || "";
  $("pKey").value = l.key || ""; $("pBase").value = l.base || ""; $("pModel").value = l.model || "";
})();
$("pSave").onclick = async ()=>{
  const { atomcv_llm: cur = {} } = await store.get(["atomcv_llm"]);
  await store.set({ atomcv_profile: {
    name: $("pName").value.trim() || "求职者",
    headline: $("pHead").value.trim(),
    info: $("pInfo").value.trim(),
    salary: $("pSalary").value.trim(),
    summary: $("pSummary").value.trim(),
    greetTpl: $("pTpl").value.trim()
  }, atomcv_llm: {
    key: $("pKey").value.trim(),
    base: $("pBase").value.trim(),
    model: $("pModel").value.trim() || cur.model || "deepseek-chat"
  }, atomcv_llmcache: {} });
  $("pMsg").textContent = "✅";
  setTimeout(()=>$("pMsg").textContent="",1500);
};

$("loadSample").onclick = async ()=>{
  const res = await fetch(chrome.runtime.getURL("atoms.sample.json"));
  const data = await res.json();
  await store.set({ atomcv_atoms: data.atoms });
  renderLib();
};
$("clearLib").onclick = async ()=>{ await store.set({ atomcv_atoms: [] }); renderLib(); };

/* ---------- 录入 ---------- */
$("aSave").onclick = async ()=>{
  const raw = $("aRaw").value.trim();
  if(!raw){ $("aMsg").textContent = "⚠️ 写点内容再存（其他字段都可以不填）"; return; }
  // 自由文本：只要有描述就能存。技能没填就自动提取；公司/时间没填就尝试从文本里识别
  let skills = $("aSkills").value.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
  if (!skills.length) skills = extractSkillsFrom(raw);
  let org = $("aOrg").value.trim(), title = $("aTitle").value.trim(), time = $("aTime").value.trim();
  if (!time) { const m = raw.match(DATE_RE); if (m) time = m[0].replace(/\s+/g,""); }
  if (!org) {
    const m = raw.match(/([一-龥A-Za-z0-9]{2,20}(?:公司|集团|科技|网络|平台|工作室|大学|学院))/);
    if (m) org = m[1].replace(/^[在于就到去]/, "");
  }
  const atom = {
    id: "atom_" + Date.now(), type: $("aType").value,
    org, title, time,
    raw, bullet: $("aBullet").value.trim() || raw.split(/\n/)[0].slice(0,90), metrics: [], skills, ev: "用户录入"
  };
  const { atomcv_atoms: atoms = [] } = await store.get(["atomcv_atoms"]);
  atoms.push(atom);
  await store.set({ atomcv_atoms: atoms });
  ["aRaw","aOrg","aTitle","aTime","aSkills","aBullet"].forEach(i=>$(i).value="");
  $("aMsg").textContent = skills.length ? "✅ 已存入（技能：" + skills.slice(0,5).join("、") + "）" : "✅ 已存入（未识别出技能，建议去经历库补标签）";
  renderLib();
};

/* ---------- 看板 ---------- */
const STATUSES = ["想投","已招呼","已回复","面试","Offer","结束"];
async function renderBoard(){
  const { atomcv_board: board = [] } = await store.get(["atomcv_board"]);
  const today = new Date().toDateString();
  const todayN = board.filter(c=>new Date(c.at).toDateString()===today && c.status==="已招呼").length;
  const replied = board.filter(c=>["已回复","面试","Offer"].includes(c.status)).length;
  const greeted = board.filter(c=>c.status!=="想投").length;
  $("boardStat").innerHTML = `<div><b>${board.length}</b><span>岗位总数</span></div>
    <div><b>${todayN}/150</b><span>今日已招呼（Boss上限）</span></div>
    <div><b>${greeted?Math.round(replied/greeted*100):0}%</b><span>回复率</span></div>`;
  if(!board.length){ $("boardList").innerHTML = `<div class="empty">还没有记录。<br>去 Boss直聘 岗位页，用插件侧栏「暂存到看板」或「记录投递」。</div>`; return; }
  $("boardList").innerHTML = board.map(c=>`
    <div class="card">
      <div class="top">
        <span class="rate" style="color:${c.rate>=75?"#0f9d78":c.rate>=50?"#b7791f":"#8a94a0"}">${c.rate}%</span>
        <span class="org">${esc(c.title)}</span><span class="role">${esc(c.company)}</span>
        <select class="status" data-id="${c.id}" style="margin-left:auto">
          ${STATUSES.map(s=>`<option ${s===c.status?"selected":""}>${s}</option>`).join("")}
        </select>
        <button class="del" data-id="${c.id}">删</button>
      </div>
      <div class="chips">${(c.covered||[]).slice(0,6).map(s=>`<span class="chip g">${esc(s)}</span>`).join("")}
        ${(c.missing||[]).slice(0,4).map(s=>`<span class="chip m">缺·${esc(s)}</span>`).join("")}</div>
      ${c.url?`<div class="muted" style="margin-top:6px"><a href="${esc(c.url)}" target="_blank">打开岗位页</a> · ${new Date(c.at).toLocaleDateString()}</div>`:""}
    </div>`).join("");
  document.querySelectorAll(".status").forEach(sel=>sel.onchange=async()=>{
    const { atomcv_board: b = [] } = await store.get(["atomcv_board"]);
    const c = b.find(x=>x.id===sel.dataset.id); if(c) c.status = sel.value;
    await store.set({ atomcv_board: b }); renderBoard();
  });
  $("boardList").querySelectorAll(".del").forEach(btn=>btn.onclick=async()=>{
    const { atomcv_board: b = [] } = await store.get(["atomcv_board"]);
    await store.set({ atomcv_board: b.filter(x=>x.id!==btn.dataset.id) }); renderBoard();
  });
}

/* ---------- 补录清单 ---------- */
async function renderGaps(){
  const { atomcv_gaps: gaps = [] } = await store.get(["atomcv_gaps"]);
  if(!gaps.length){ $("gapList").innerHTML = `<div class="empty">暂无缺口记录。<br>在岗位页的诊断卡里点击红色缺口能力，会记到这里。</div>`; return; }
  $("gapList").innerHTML = gaps.map((g,i)=>`
    <div class="card">
      <div class="top"><span class="chip m">${esc(g.skill)}</span>
        <span class="muted">来自岗位：${esc(g.jobTitle||"—")} ${g.company?("· "+esc(g.company)):""}</span>
        <button class="del" data-i="${i}">移除</button></div>
      <div class="muted" style="margin-top:6px">你有过与「${esc(g.skill)}」相关的真实经历吗？有的话去「＋录入经历」补一条，下次同类岗位匹配分会自动提高。</div>
    </div>`).join("");
  $("gapList").querySelectorAll(".del").forEach(b=>b.onclick=async()=>{
    const { atomcv_gaps: gs = [] } = await store.get(["atomcv_gaps"]);
    gs.splice(Number(b.dataset.i),1);
    await store.set({ atomcv_gaps: gs }); renderGaps();
  });
}

renderLib(); renderBoard(); renderGaps();

/* ---------- 🔍 今日匹配 ---------- */
(async ()=>{
  const { atomcv_patrol_cfg: pc = {} } = await store.get(["atomcv_patrol_cfg"]);
  $("mEnable").checked = !!pc.enabled;
  $("mBlacklist").value = pc.blacklist || "";
  $("mMinScore").value = String(pc.minScore || 60);
})();
$("mEnable").onchange = async ()=>{
  const { atomcv_patrol_cfg: pc = {} } = await store.get(["atomcv_patrol_cfg"]);
  await store.set({ atomcv_patrol_cfg: { ...pc, enabled: $("mEnable").checked } });
};
$("mSavePrefs").onclick = async ()=>{
  const { atomcv_patrol_cfg: pc = {} } = await store.get(["atomcv_patrol_cfg"]);
  await store.set({ atomcv_patrol_cfg: { ...pc, enabled: $("mEnable").checked,
    blacklist: $("mBlacklist").value.trim(), minScore: +$("mMinScore").value } });
  $("mPrefMsg").textContent = "✅"; setTimeout(()=>$("mPrefMsg").textContent="",1500);
};
async function renderTerms(){
  const { atomcv_patrol_cfg: pc = {} } = await store.get(["atomcv_patrol_cfg"]);
  const terms = pc.terms || [];
  $("mTerms").innerHTML = terms.length
    ? terms.map((t,i)=>`<a class="chip" style="text-decoration:none;cursor:pointer" target="_blank"
        href="https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(t)}">${esc(t)} ↗</a>
        <span class="del" data-i="${i}" style="margin-left:-4px">×</span>`).join("")
    : `<span class="muted">还没有搜索词，点右上「生成」或手动去 Boss 搜索后巡岗</span>`;
  $("mTerms").querySelectorAll(".del").forEach(d=>d.onclick=async ()=>{
    const { atomcv_patrol_cfg: pc2 = {} } = await store.get(["atomcv_patrol_cfg"]);
    (pc2.terms||[]).splice(+d.dataset.i,1);
    await store.set({ atomcv_patrol_cfg: pc2 }); renderTerms();
  });
}
$("mGenTerms").onclick = async ()=>{
  $("mGenTerms").textContent = "生成中…";
  const { atomcv_atoms: atoms = [], atomcv_llm: llm = {} } = await store.get(["atomcv_atoms","atomcv_llm"]);
  if (!llm.key) { $("mGenTerms").textContent = "需先配置 API Key"; return; }
  const digest = atoms.map(a=>({title:a.title, skills:(a.skills||[]).slice(0,8)}));
  const res = await new Promise(r=>chrome.runtime.sendMessage({type:"llmChat",json:true,messages:[
    {role:"system",content:'根据候选人的经历，生成 6-10 个在招聘网站上搜索岗位用的关键词。核心要求：覆盖"同样的工作内容、不同的岗位叫法"。只输出JSON：{"terms":["词1","词2"]}'},
    {role:"user",content:JSON.stringify(digest)}]},r));
  try {
    const obj = JSON.parse(res.content);
    if (Array.isArray(obj.terms) && obj.terms.length) {
      const { atomcv_patrol_cfg: pc = {} } = await store.get(["atomcv_patrol_cfg"]);
      await store.set({ atomcv_patrol_cfg: { ...pc, terms: obj.terms.slice(0,10) } });
    }
  } catch(e){}
  $("mGenTerms").textContent = "🤖 从我的经历库生成";
  renderTerms();
};
async function renderPool(){
  const { atomcv_pool: pool = [], atomcv_patrol_quota: q = {} } = await store.get(["atomcv_pool","atomcv_patrol_quota"]);
  const sorted = [...pool].sort((a,b)=>b.score-a.score);
  $("mStat").innerHTML = `<div><b>${pool.length}</b><span>岗位池</span></div>
    <div><b>${pool.filter(p=>p.score>=75).length}</b><span>75分以上</span></div>
    <div><b>${q.dayCount||0}/150</b><span>今日巡岗额度</span></div>`;
  if (!sorted.length) { $("mPool").innerHTML = `<div class="empty">岗位池是空的。<br>开启巡岗 → 去 Boss 搜索页 → 点右下「🔍 巡岗」。</div>`; return; }
  $("mPool").innerHTML = sorted.map(p=>`
    <div class="card">
      <div class="top">
        <input type="checkbox" class="mPick" data-id="${p.id}" style="width:16px;height:16px">
        <span class="rate" style="color:${p.score>=75?"#0f9d78":p.score>=60?"#b7791f":"#8a94a0"}">${p.score}%</span>
        <span class="org">${esc(p.title)}</span><span class="role">${esc(p.company||"")}</span>
        <span class="muted">${esc(p.salary||"")}</span>
        <button class="del" data-id="${p.id}">移除</button>
      </div>
      ${p.reason?`<div class="muted" style="margin-top:4px">🤖 ${esc(p.reason)}</div>`:""}
      ${(p.missing||[]).length?`<div class="chips">${p.missing.slice(0,4).map(s=>`<span class="chip m">缺·${esc(s)}</span>`).join("")}</div>`:""}
    </div>`).join("");
  $("mPool").querySelectorAll(".del").forEach(b=>b.onclick=async ()=>{
    const { atomcv_pool: pl = [] } = await store.get(["atomcv_pool"]);
    await store.set({ atomcv_pool: pl.filter(x=>x.id!==b.dataset.id) }); renderPool();
  });
}
$("mSelectAll").onclick = ()=>{
  $("mPool").querySelectorAll(".mPick").forEach(c=>{
    const card = c.closest(".card");
    const rate = parseInt(card.querySelector(".rate").textContent);
    c.checked = rate >= 75;
  });
};
$("mClearPool").onclick = async ()=>{ await store.set({ atomcv_pool: [] }); renderPool(); };
$("mStartQueue").onclick = async ()=>{
  const ids = [...$("mPool").querySelectorAll(".mPick:checked")].map(c=>c.dataset.id);
  if (!ids.length) { alert("先勾选要投递的岗位"); return; }
  const { atomcv_pool: pool = [] } = await store.get(["atomcv_pool"]);
  const items = ids.map(id=>pool.find(p=>p.id===id)).filter(Boolean)
    .map(p=>({id:p.id,url:p.url,title:p.title,company:p.company,jdBody:p.jdBody,salary:p.salary||""}));
  await store.set({ atomcv_queue: { items, idx: 0, active: true, startedAt: Date.now() } });
  window.open(items[0].url, "_blank");
};
renderTerms(); renderPool();

/* ---------- 🗄 数据管理 + 🤖 AI复盘 + 💬 补录访谈 ---------- */
const llmAsk = (messages) => new Promise(r => chrome.runtime.sendMessage({ type: "llmChat", json: true, messages }, r));
$("expBtn").onclick = async () => {
  const all = await new Promise(r => chrome.storage.local.get(null, r));
  const data = {};
  Object.keys(all).filter(k => k.startsWith("atomcv_")).forEach(k => data[k] = all[k]);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "求职助手备份_" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  $("dmMsg").textContent = "✅ 已导出";
  setTimeout(() => $("dmMsg").textContent = "", 2000);
};
$("impBakFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const keys = Object.keys(data).filter(k => k.startsWith("atomcv_"));
    if (!keys.length) { $("dmMsg").textContent = "⚠️ 不是有效的求职助手备份文件"; return; }
    const pick = {};
    keys.forEach(k => pick[k] = data[k]);
    await new Promise(r => chrome.storage.local.set(pick, r));
    $("dmMsg").textContent = "✅ 已导入 " + keys.length + " 项数据，刷新中…";
    setTimeout(() => location.reload(), 900);
  } catch (err) { $("dmMsg").textContent = "导入失败：" + err.message; }
};
$("resetBtn").onclick = async () => {
  if (!confirm("确定清空本机的全部求职助手数据吗？\n（建议先导出备份）")) return;
  const all = await new Promise(r => chrome.storage.local.get(null, r));
  const keys = Object.keys(all).filter(k => k.startsWith("atomcv_"));
  await new Promise(r => chrome.storage.local.remove(keys, r));
  $("dmMsg").textContent = "✅ 已重置，刷新中…";
  setTimeout(() => location.reload(), 900);
};
$("insightBtn").onclick = async () => {
  const { atomcv_board: board = [], atomcv_patrol_cfg: pc = {}, atomcv_llm: llm = {} } = await store.get(["atomcv_board", "atomcv_patrol_cfg", "atomcv_llm"]);
  if (board.length < 3) { $("insightBox").innerHTML = `<p class="muted">投递记录太少（${board.length} 条），先投一些再来复盘。</p>`; return; }
  if (!llm.key) { $("insightBox").innerHTML = `<p class="muted">需要先在「⚙️ 设置」配置 DeepSeek API Key。</p>`; return; }
  $("insightBtn").textContent = "分析中…";
  const replied = c => ["已回复", "面试", "Offer"].includes(c.status);
  const hi = board.filter(c => c.rate >= 75), lo = board.filter(c => c.rate < 75);
  const stats = {
    总投递: board.length,
    已回复或约面: board.filter(replied).length,
    高分段75以上: { 投递: hi.length, 回复: hi.filter(replied).length },
    低分段75以下: { 投递: lo.length, 回复: lo.filter(replied).length }
  };
  const detail = board.slice(0, 40).map(c => ({ 岗位: c.title, 分数: c.rate, 状态: c.status }));
  const res = await llmAsk([
    { role: "system", content: '你是求职策略分析师。根据候选人的投递看板数据，给出直白的复盘洞察和可执行的调整建议。只输出JSON：{"insights":["洞察1","洞察2","洞察3"],"suggest_min_score":建议的巡岗入选线数字或null,"add_terms":["建议新增的搜索词，没有则空数组"],"focus":"一句话说明下一步主攻方向"}' },
    { role: "user", content: JSON.stringify({ 统计: stats, 明细: detail, 当前入选线: pc.minScore || 60, 当前搜索词: pc.terms || [] }) }
  ]);
  $("insightBtn").textContent = "分析我的投递数据";
  try {
    const obj = JSON.parse(res.content);
    const rate = arr => arr.投递 ? Math.round(arr.回复 / arr.投递 * 100) + "%" : "-";
    $("insightBox").innerHTML = `
      <div class="row" style="margin:10px 0 6px">
        <span class="chip g">总投递 ${stats.总投递}</span>
        <span class="chip g">回复/约面 ${stats.已回复或约面}</span>
        <span class="chip">75分+ 回复率 ${rate(stats.高分段75以上)}</span>
        <span class="chip">75分- 回复率 ${rate(stats.低分段75以下)}</span>
      </div>
      ${(obj.insights || []).map(i => `<p style="margin:6px 0">💡 ${esc(i)}</p>`).join("")}
      ${obj.focus ? `<p style="margin:8px 0;font-weight:600">🎯 ${esc(obj.focus)}</p>` : ""}
      <div class="row" style="margin-bottom:0">
        ${obj.suggest_min_score ? `<button class="btn ghost" id="apScore">采纳入选线 ${obj.suggest_min_score} 分</button>` : ""}
        ${(obj.add_terms || []).length ? `<button class="btn ghost" id="apTerms">添加搜索词：${obj.add_terms.map(esc).join("、")}</button>` : ""}
      </div>`;
    const apS = document.getElementById("apScore");
    if (apS) apS.onclick = async () => {
      const { atomcv_patrol_cfg: p2 = {} } = await store.get(["atomcv_patrol_cfg"]);
      await store.set({ atomcv_patrol_cfg: { ...p2, minScore: obj.suggest_min_score } });
      apS.textContent = "✅ 已采纳"; $("mMinScore").value = String(obj.suggest_min_score);
    };
    const apT = document.getElementById("apTerms");
    if (apT) apT.onclick = async () => {
      const { atomcv_patrol_cfg: p2 = {} } = await store.get(["atomcv_patrol_cfg"]);
      p2.terms = [...new Set([...(p2.terms || []), ...obj.add_terms])].slice(0, 12);
      await store.set({ atomcv_patrol_cfg: p2 });
      apT.textContent = "✅ 已添加"; renderTerms();
    };
  } catch (e) {
    $("insightBox").innerHTML = `<p class="muted">复盘失败（${esc((res && res.error) || "解析错误")}），请重试。</p>`;
  }
};
async function renderGaps() {
  const { atomcv_gaps: gaps = [], atomcv_llm: llm = {} } = await store.get(["atomcv_gaps", "atomcv_llm"]);
  if (!gaps.length) {
    $("gapList").innerHTML = `<div class="empty">暂无缺口记录。<br>在岗位页的诊断卡里点击红色缺口能力，会记到这里——<br>每一条都是一次把库补厚的机会。</div>`;
    return;
  }
  $("gapList").innerHTML = gaps.map((g, i) => `
    <div class="card" id="gap_${i}">
      <div class="top"><span class="chip m">${esc(g.skill)}</span>
        <span class="muted">来自岗位：${esc(g.jobTitle || "—")} ${g.company ? "· " + esc(g.company) : ""}</span>
        <button class="del" data-i="${i}">移除</button></div>
      <div class="gapChat" id="gapChat_${i}" style="margin-top:8px"></div>
      <div class="row" style="margin-bottom:0">
        <button class="btn ghost gapStart" data-i="${i}">💬 聊一聊，补上这段经历</button>
      </div>
    </div>`).join("");
  $("gapList").querySelectorAll(".del").forEach(b => b.onclick = async () => {
    const { atomcv_gaps: gs = [] } = await store.get(["atomcv_gaps"]);
    gs.splice(+b.dataset.i, 1);
    await store.set({ atomcv_gaps: gs }); renderGaps();
  });
  $("gapList").querySelectorAll(".gapStart").forEach(b => b.onclick = () => startGapChat(+b.dataset.i, gaps[+b.dataset.i], !!llm.key));
}
async function startGapChat(i, gap, hasKey) {
  const box = document.getElementById("gapChat_" + i);
  const card = document.getElementById("gap_" + i);
  card.querySelector(".gapStart").style.display = "none";
  const history = [];
  let rounds = 0;
  const ask = (q) => {
    box.insertAdjacentHTML("beforeend", `<div style="background:var(--accent-soft);border-radius:10px;padding:9px 12px;margin:6px 0;font-size:13.5px">🤖 ${esc(q)}</div>
      <textarea class="gapAns" style="min-height:64px" placeholder="说说你的真实经历（没有就直说没有，不会编造）…"></textarea>
      <div class="row"><button class="btn gapSend">提交</button></div>`);
    const ta = [...box.querySelectorAll(".gapAns")].pop();
    const btn = [...box.querySelectorAll(".gapSend")].pop();
    btn.onclick = async () => {
      const ans = ta.value.trim();
      if (!ans) return;
      ta.disabled = true; btn.textContent = "处理中…"; btn.disabled = true;
      box.insertAdjacentHTML("beforeend", `<div style="background:#f0f2f5;border-radius:10px;padding:9px 12px;margin:6px 0;font-size:13.5px">${esc(ans)}</div>`);
      ta.style.display = "none"; btn.parentElement.style.display = "none";
      history.push({ role: "user", content: ans });
      await step(ans);
    };
  };
  const preview = (atom) => {
    box.insertAdjacentHTML("beforeend", `
      <div class="card" style="border-color:var(--green);margin:8px 0 0">
        <div class="top"><span class="chip g">整理好的新经历</span>
          ${atom.org ? `<span class="org">${esc(atom.org)}</span>` : ""}${atom.title ? `<span class="role">· ${esc(atom.title)}</span>` : ""}
          <span class="time">${esc(atom.time || "")}</span></div>
        <div class="raw">${esc(atom.raw)}</div>
        <div class="chips">${(atom.skills || []).map(s => `<span class="chip">${esc(s)}</span>`).join("")}</div>
        <div class="row" style="margin-bottom:0"><button class="btn gapSave">✅ 存入经历库</button></div>
      </div>`);
    [...box.querySelectorAll(".gapSave")].pop().onclick = async (e) => {
      const { atomcv_atoms: atoms = [], atomcv_gaps: gs = [] } = await store.get(["atomcv_atoms", "atomcv_gaps"]);
      atoms.push({ id: "atom_" + Date.now(), type: "work", org: atom.org || "", title: atom.title || "", time: atom.time || "",
        raw: atom.raw, bullet: atom.bullet || atom.raw.slice(0, 80), metrics: [], skills: atom.skills && atom.skills.length ? atom.skills : [gap.skill], ev: "补录访谈" });
      gs.splice(i, 1);
      await store.set({ atomcv_atoms: atoms, atomcv_gaps: gs });
      e.target.textContent = "✅ 已入库！同类岗位匹配分会自动提高";
      setTimeout(() => { renderGaps(); renderLib(); }, 1200);
    };
  };
  const SYS = `你在帮求职者把缺失的能力经历补录进个人经历库。目标能力：「${gap.skill}」（来自岗位「${gap.jobTitle || ""}」的要求）。
规则：绝不编造；引导对方回忆真实的、哪怕是间接相关的经历；对方明确说没有就接受。
输出JSON（三选一）：
提问 {"question":"具体、好回答的开放式问题"}
信息够了 {"atom":{"org":"公司或空","title":"岗位或空","time":"时间段或空","raw":"整理成第一人称的经历描述80-150字","bullet":"简历上的一句话表达","skills":["相关技能标签"]}}
确认没有 {"none":true}`;
  const step = async (userAns) => {
    rounds++;
    if (!hasKey) { if (userAns) preview({ raw: userAns.slice(0, 300), skills: [gap.skill] }); return; }
    const res = await llmAsk([{ role: "system", content: SYS + (rounds >= 2 ? "\n（已到最后一轮：必须输出 atom 或 none，不得再提问）" : "") },
      ...history.map(h => ({ role: h.role === "user" ? "user" : "assistant", content: h.content }))]);
    try {
      const obj = JSON.parse(res.content);
      if (obj.question && rounds < 2) { history.push({ role: "assistant", content: JSON.stringify(obj) }); ask(obj.question); }
      else if (obj.atom) preview(obj.atom);
      else if (obj.none) box.insertAdjacentHTML("beforeend", `<p class="muted">记下了：这段经历确实没有。这个缺口会保留在清单里，作为你的提升方向。</p>`);
      else if (obj.question) preview({ raw: history.filter(h => h.role === "user").map(h => h.content).join("；").slice(0, 300), skills: [gap.skill] });
    } catch (e) {
      box.insertAdjacentHTML("beforeend", `<p class="muted">AI 响应异常（${esc((res && res.error) || "解析失败")}），你可以直接把经历写在下面存入：</p>`);
      ask("请直接描述你与「" + gap.skill + "」相关的真实经历：");
    }
  };
  if (hasKey) {
    box.innerHTML = `<p class="muted">🤖 正在准备问题…</p>`;
    history.length = 0;
    const res = await llmAsk([{ role: "system", content: SYS }, { role: "user", content: "开始访谈，请提出第一个问题。" }]);
    box.innerHTML = "";
    try {
      const obj = JSON.parse(res.content);
      history.push({ role: "assistant", content: JSON.stringify(obj) });
      ask(obj.question || `你有没有做过和「${gap.skill}」相关的事？间接相关也算，说说看。`);
    } catch (e) { ask(`你有没有做过和「${gap.skill}」相关的事？间接相关也算，说说看。`); }
  } else {
    ask(`你有没有做过和「${gap.skill}」相关的事？间接相关的也算——用大白话写下来，会直接存成一条经历。`);
  }
}
