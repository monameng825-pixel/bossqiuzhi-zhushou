/* AtomCV 简历图片渲染 v0.6：完全对齐 Boss 标准简历模版
 * 版式参照 Boss 导出简历：
 *   姓名（大字）
 *   性别 | 生日 | 城市 | 电话 | 邮箱          （profile.info）
 *   X年工作经验 | 求职意向：xxx | 期望薪资：xxx （profile.headline / jobTitle / profile.salary）
 *   ▎个人优势   —— profile.summary
 *   ▎工作经历   —— 公司名  职位          时间(右对齐)
 *                内容： · bullet…
 *   ▎项目经历 / ▎教育经历 同构 */
(function (global) {
  const W = 900, PAD = 56, LINE = 24;
  const TEAL = "#00a6a7", INK = "#222b35", GRAY = "#8a94a0", SOFT = "#5a6572";
  const FONT = "'PingFang SC','Microsoft YaHei',sans-serif";

  function wrap(ctx, text, maxW) {
    const out = []; let line = "";
    for (const ch of (text || "")) {
      if (ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
      else line += ch;
    }
    if (line) out.push(line);
    return out;
  }

  function groupSections(sections) {
    return sections.map(sec => {
      if (sec.type !== "work" && sec.type !== "project" && sec.type !== "education") {
        return { ...sec, groups: [{ head: null, items: sec.items }] };
      }
      const map = new Map();
      sec.items.forEach(x => {
        const a = x.atom;
        const key = `${a.org || ""}|${a.title || ""}|${a.time || ""}`;
        if (!map.has(key)) map.set(key, { head: { org: a.org, title: a.title, time: a.time }, items: [] });
        map.get(key).items.push(x);
      });
      return { ...sec, groups: [...map.values()] };
    });
  }

  const SEC_LABEL = { work: "工作经历", project: "项目经历", skill: "专业技能", education: "教育经历", award: "荣誉奖项", other: "其他" };

  function renderResume(sections, profile, jobTitle) {
    const meas = document.createElement("canvas").getContext("2d");
    const maxW = W - PAD * 2;
    const grouped = groupSections(sections);
    const blocks = [];

    function planText(text, font, color, indent, gapAfter, lh) {
      meas.font = font;
      wrap(meas, text, maxW - indent).forEach((ln, i, arr) => {
        blocks.push({ t: "line", text: ln, font, color, indent, lh: lh || LINE, gap: (i === arr.length - 1 ? (gapAfter || 0) : 0) });
      });
    }

    // ===== 头部（Boss 版式）=====
    planText(profile.name || "求职者", `700 34px ${FONT}`, INK, 0, 10, 44);
    if (profile.info) planText(profile.info, `13.5px ${FONT}`, SOFT, 0, 4);
    const line3 = [profile.headline, jobTitle ? `求职意向：${jobTitle}` : "", profile.salary ? `期望薪资：${profile.salary}` : ""]
      .filter(Boolean).join(" | ");
    if (line3) planText(line3, `13.5px ${FONT}`, SOFT, 0, 6);
    blocks.push({ t: "hr", gap: 16 });

    // ===== 个人优势 =====
    if (profile.summary) {
      blocks.push({ t: "sec", text: "个人优势", gap: 8 });
      planText(profile.summary, `14.5px ${FONT}`, "#333c48", 4, 6);
      blocks.push({ t: "gap", gap: 10 });
    }

    // ===== 分区（工作经历 → 项目经历 → 专业技能 → 教育经历）=====
    grouped.forEach(sec => {
      blocks.push({ t: "sec", text: SEC_LABEL[sec.type] || sec.label, gap: 8 });
      sec.groups.forEach(g => {
        if (g.head && (g.head.org || g.head.title)) {
          blocks.push({ t: "ghead", org: g.head.org || "", title: g.head.title || "", time: g.head.time || "", gap: 4 });
        }
        if (sec.type === "work" || sec.type === "project") {
          blocks.push({ t: "label", text: "内容：", gap: 2 });
        }
        g.items.forEach((x, bi) => {
          const a = x.atom;
          const txt = (a.bullet || a.raw);
          if (sec.type === "education") {
            // 内容与分组头重复（学校/学历已在头部）→ 不再重复输出
            if (g.head && g.head.org && txt.includes(g.head.org)) return;
            planText(txt, `14.5px ${FONT}`, "#333c48", 4, 4);
          } else {
            planText(`${bi + 1}、${txt}`, `14.5px ${FONT}`, "#333c48", 14, 4);
          }
        });
        blocks.push({ t: "gap", gap: 12 });
      });
    });
    blocks.push({ t: "foot", gap: 0 });

    // ===== 计算总高 =====
    let H = PAD;
    blocks.forEach(b => {
      if (b.t === "line") H += (b.lh || LINE) + b.gap;
      else if (b.t === "sec") H += 40 + b.gap;
      else if (b.t === "ghead") H += 28 + b.gap;
      else if (b.t === "label") H += 22 + b.gap;
      else if (b.t === "hr") H += 2 + b.gap;
      else if (b.t === "gap") H += b.gap;
      else if (b.t === "foot") H += 26;
    });
    H += PAD - 12;

    // ===== 绘制（2x）=====
    const cv = document.createElement("canvas");
    cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext("2d");
    ctx.scale(2, 2);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "top";

    let y = PAD;
    blocks.forEach(b => {
      if (b.t === "line") {
        ctx.font = b.font; ctx.fillStyle = b.color;
        ctx.fillText(b.text, PAD + b.indent, y);
        y += (b.lh || LINE) + b.gap;
      } else if (b.t === "sec") {
        y += 12;
        ctx.fillStyle = TEAL; ctx.fillRect(PAD, y + 2, 4, 17);
        ctx.font = `700 18px ${FONT}`; ctx.fillStyle = INK;
        ctx.fillText(b.text, PAD + 13, y);
        y += 28 + b.gap;
      } else if (b.t === "ghead") {
        ctx.font = `700 15.5px ${FONT}`; ctx.fillStyle = INK;
        ctx.fillText(b.org, PAD + 4, y);
        if (b.title) {
          const ow = ctx.measureText(b.org).width;
          ctx.font = `14px ${FONT}`; ctx.fillStyle = SOFT;
          ctx.fillText(b.title, PAD + 4 + ow + 18, y + 1);
        }
        if (b.time) {
          ctx.font = `13px ${FONT}`; ctx.fillStyle = GRAY;
          const tw = ctx.measureText(b.time).width;
          ctx.fillText(b.time, W - PAD - tw, y + 2);
        }
        y += 28 + b.gap;
      } else if (b.t === "label") {
        ctx.font = `700 13.5px ${FONT}`; ctx.fillStyle = "#333c48";
        ctx.fillText(b.text, PAD + 4, y);
        y += 22 + b.gap;
      } else if (b.t === "hr") {
        ctx.fillStyle = "#e8ecef"; ctx.fillRect(PAD, y, maxW, 2);
        y += 2 + b.gap;
      } else if (b.t === "gap") {
        y += b.gap;
      } else if (b.t === "foot") {
        ctx.font = `11px ${FONT}`; ctx.fillStyle = "#c6ccd3";
        ctx.fillText("本简历内容来自本人真实经历 · 每条均可提供证据与详述", PAD, y + 4);
        y += 26;
      }
    });
    return cv;
  }

  global.AtomCVImage = { renderResume };
})(typeof window !== "undefined" ? window : globalThis);
