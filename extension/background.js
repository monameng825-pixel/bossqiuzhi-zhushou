/* 求职助手 background：预置示例库 / 打开管理页 / DeepSeek API 代理（模型名自动适配） */
chrome.runtime.onInstalled.addListener(async () => {
  const v = await chrome.storage.local.get(["atomcv_atoms"]);
  if (!v.atomcv_atoms) {
    try {
      const res = await fetch(chrome.runtime.getURL("atoms.sample.json"));
      const data = await res.json();
      await chrome.storage.local.set({ atomcv_atoms: data.atoms || [] });
    } catch (e) {}
  }
});
chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "openDashboard") { chrome.runtime.openOptionsPage(); return; }
  if (msg && msg.type === "llmChat") {
    (async () => {
      try {
        const { atomcv_llm: cfg = {} } = await chrome.storage.local.get(["atomcv_llm"]);
        if (!cfg.key) { sendResponse({ error: "NO_KEY" }); return; }
        const base = (cfg.base || "https://api.deepseek.com").replace(/\/+$/, "");

        const call = async (model) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          try {
            const res = await fetch(base + "/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
              body: JSON.stringify({
                model,
                messages: msg.messages, temperature: 0.2,
                ...(msg.json ? { response_format: { type: "json_object" } } : {})
              }),
              signal: ctrl.signal
            });
            clearTimeout(timer);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return { err: (data.error && data.error.message) || ("HTTP " + res.status) };
            return { content: data.choices && data.choices[0] && data.choices[0].message.content };
          } catch (e) {
            clearTimeout(timer);
            return { err: e.name === "AbortError" ? "请求超时" : String(e.message || e) };
          }
        };

        // 从报错里解析对方支持的模型名，如 "The supported API model names are deepseek-v4-pro or deepseek-v4-flash"
        const extractModels = (errMsg) => {
          const m = String(errMsg || "").match(/model(?:\s+names?)?\s+(?:are|is|should be|must be)\s+([^.。;；]+)/i);
          if (!m) return [];
          return (m[1].match(/[A-Za-z][\w.\-]{2,}/g) || [])
            .filter(w => !/^(or|and|but|the|you|passed|one|of|following|is|are)$/i.test(w));
        };

        let model = cfg.model || "deepseek-chat";
        let r = await call(model);
        if (r.err) {
          const cands = extractModels(r.err);
          const next = cands.find(c => c.toLowerCase() !== model.toLowerCase());
          if (next) {
            const r2 = await call(next);
            if (r2.content) {
              await chrome.storage.local.set({ atomcv_llm: { ...cfg, model: next } }); // 记住可用模型，之后直接用
              sendResponse({ content: r2.content, modelSwitched: next });
              return;
            }
          }
          sendResponse({ error: r.err });
          return;
        }
        sendResponse({ content: r.content });
      } catch (e) {
        sendResponse({ error: String(e.message || e) });
      }
    })();
    return true;
  }
});
