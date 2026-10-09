/* Espinal Family — website version for one family tablet.
   Everything is saved on this device. Coco Spark thinks with Claude using the parent's
   Claude API key, which is stored only on this device. */
(function () {
  window.COCO_SITE = true;
  const KEY_STORE = "fh-claude-key", DB_STORE = "fh-local-db";

  /* ---------- storage on this device (same shape the app already uses) ---------- */
  let data = {};
  try { data = JSON.parse(localStorage.getItem(DB_STORE) || "{}"); } catch (e) { data = {}; }
  let saveTimer = 0;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(DB_STORE, JSON.stringify(data)); } catch (e) { console.warn("Storage full", e); } }, 150); };
  const listeners = new Set();
  const notify = () => { persist(); Promise.resolve().then(() => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } })); };
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const snapDoc = (path) => ({ id: path.split("/").pop(), exists: data[path] !== undefined, data: () => copy(data[path]), metadata: { fromCache: false, hasPendingWrites: false } });
  const merge = (a, b) => { for (const k in b) { const v = b[k]; if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], v); else a[k] = copy(v); } return a; };
  const cmp = (x, op, v) => op === "==" ? x === v : op === "!=" ? x !== v : op === ">=" ? x >= v : op === ">" ? x > v : op === "<=" ? x <= v : op === "<" ? x < v
    : op === "in" ? (v || []).includes(x) : op === "array-contains" ? Array.isArray(x) && x.includes(v) : true;
  function query(col, filters, order, lim) {
    const run = () => {
      const depth = col.split("/").length + 1;
      let docs = Object.keys(data).filter(k => k.startsWith(col + "/") && k.split("/").length === depth).map(snapDoc)
        .filter(d => filters.every(([f, op, v]) => cmp(d.data()[f], op, v)));
      if (order) docs.sort((a, b) => { const x = a.data()[order[0]], y = b.data()[order[0]]; return (x > y ? 1 : x < y ? -1 : 0) * (order[1] === "desc" ? -1 : 1); });
      else docs.sort((a, b) => a.id < b.id ? -1 : 1);
      if (lim) docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
    };
    return {
      where: (f, op, v) => query(col, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir) => query(col, filters, [f, dir || "asc"], lim),
      limit: n => query(col, filters, order, n),
      get: async () => run(),
      onSnapshot: (next) => { const f = () => next(run()); listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f); },
    };
  }
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      get: async () => snapDoc(path),
      set: async d => { data[path] = copy(d); notify(); },
      update: async d => { data[path] = merge(data[path] ? data[path] : {}, d); notify(); },
      delete: async () => { delete data[path]; notify(); },
      onSnapshot: (next) => { const f = () => next(snapDoc(path)); listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f); },
      collection: p => colRef(path + "/" + p),
    };
  }
  function colRef(path) { return Object.assign(query(path, [], null, null), { path, doc: id => docRef(path + "/" + (id || newId())), add: async d => { const r = docRef(path + "/" + newId()); await r.set(d); return r; } }); }
  const db = { collection: n => colRef(n), doc: p => docRef(p) };

  /* ---------- Coco's brain: a free Google Gemini key (AIza…) or a Claude key (sk-ant-…), saved only on this device ---------- */
  const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
  const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
  const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } };
  const isGemini = k => /^AIza/.test(k);
  const net = e => { if (e && e.name === "AbortError") return { code: "cancelled", message: "cancelled" }; return { code: "upstream_error", message: "No internet connection" }; };
  async function callAnthropic(key, messages, tools, tier, signal) {
    const body = { model: MODELS[tier] || MODELS.default, max_tokens: 1500, messages };
    if (tools && tools.length) body.tools = tools;
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body) });
    } catch (e) { throw net(e); }
    if (r.status === 401 || r.status === 403) throw { code: "not_granted", message: "The key isn't valid" };
    if (r.status === 429) throw { code: "rate_limited", message: "Too many requests" };
    if (!r.ok) throw { code: "upstream_error", message: "Claude error " + r.status };
    return r.json();
  }
  /* Gemini speaks a different format; convert both ways so the app doesn't notice */
  const gSchema = s => { if (!s || typeof s !== "object") return s; const o = {};
    if (s.type) o.type = String(s.type).toUpperCase(); if (s.description) o.description = s.description; if (s.enum) o.enum = s.enum.map(String);
    if (s.properties) { o.properties = {}; for (const k in s.properties) o.properties[k] = gSchema(s.properties[k]); }
    if (s.items) o.items = gSchema(s.items); if (s.required && s.required.length) o.required = s.required; return o; };
  let gModel = 0;
  async function callGemini(key, messages, tools, signal) {
    const names = {}; const contents = messages.map(m => {
      const role = m.role === "assistant" ? "model" : "user";
      if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
      return { role, parts: m.content.map(b => {
        if (b.type === "text") return { text: b.text };
        if (b.type === "tool_use") { names[b.id] = b.name; return b.thought_signature ? { functionCall: { name: b.name, args: b.input || {} }, thoughtSignature: b.thought_signature } : { functionCall: { name: b.name, args: b.input || {} } }; }
        if (b.type === "tool_result") return { functionResponse: { name: names[b.tool_use_id] || "tool", response: { result: b.content } } };
        return { text: "" };
      }) };
    });
    const body = { contents, generationConfig: { maxOutputTokens: 1500 } };
    if (tools && tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: gSchema(t.input_schema) })) }];
    for (;;) {
      let r;
      try {
        r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODELS[gModel] + ":generateContent", { method: "POST", signal,
          headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
      } catch (e) { throw net(e); }
      if (r.status === 404 && gModel < GEMINI_MODELS.length - 1) { gModel++; continue; }
      if (r.status === 400 || r.status === 401 || r.status === 403) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} if (/api key/i.test(m) || r.status !== 400) throw { code: "not_granted", message: "The key isn't valid" }; throw { code: "upstream_error", message: "Gemini: " + m }; }
      if (r.status === 429) throw { code: "rate_limited", message: "Free limit reached for now, try again in a minute" };
      if (!r.ok) throw { code: "upstream_error", message: "Gemini error " + r.status };
      const j = await r.json(), c = (j.candidates || [])[0] || {}, parts = (c.content && c.content.parts) || [];
      const content = []; let n = 0;
      parts.forEach(p => {
        if (p.text && !p.thought) content.push({ type: "text", text: p.text });
        if (p.functionCall) content.push({ type: "tool_use", id: "g" + Date.now() + (n++), name: p.functionCall.name, input: p.functionCall.args || {}, thought_signature: p.thoughtSignature });
      });
      const stop = content.some(b => b.type === "tool_use") ? "tool_use" : c.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
      return { content, stop_reason: stop };
    }
  }
  async function callClaude(messages, tools, tier, signal) {
    const key = getKey();
    if (!key) throw { code: "not_granted", message: "No brain key on this device" };
    return isGemini(key) ? callGemini(key, messages, tools, signal) : callAnthropic(key, messages, tools, tier, signal);
  }
  const toMessages = input => {
    const list = typeof input === "string" ? [{ role: "user", content: input }] : input.map(m => ({ role: m.role, content: String(m.content) }));
    const out = []; list.forEach(m => { const last = out[out.length - 1]; if (last && last.role === m.role && typeof last.content === "string") last.content += "\n\n" + m.content; else out.push({ ...m }); });
    return out;
  };
  async function sample(input, opts) {
    opts = opts || {};
    const msgs = toMessages(input), defs = (opts.tools || []).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let all = "";
    for (let round = 0; round < 6; round++) {
      let res;
      try { res = await callClaude(msgs, round < 5 ? defs : [], opts.modelTier, opts.signal); }
      catch (e) { if (all) e.text = all; throw e; }
      const blocks = res.content || [], text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      if (text) { all += (all ? "\n\n" : "") + text; opts.onText && opts.onText({ text: all, delta: text }); }
      if (res.stop_reason !== "tool_use" || !defs.length) {
        if (!all.trim()) throw { code: "empty_completion", message: "empty" };
        return { text: all.trim(), truncated: res.stop_reason === "max_tokens", modelTierApplied: opts.modelTier || "default" };
      }
      msgs.push({ role: "assistant", content: blocks });
      const results = [];
      for (const b of blocks.filter(b => b.type === "tool_use")) {
        const t = opts.tools.find(x => x.name === b.name); let out, isErr = false;
        try { out = t ? await t.execute(b.input || {}, { signal: opts.signal || new AbortController().signal }) : "Unknown tool"; }
        catch (e) { out = "Error: " + ((e && e.message) || e); isErr = true; }
        results.push({ type: "tool_result", tool_use_id: b.id, content: typeof out === "string" ? out : JSON.stringify(out), is_error: isErr });
      }
      msgs.push({ role: "user", content: results });
    }
    return { text: all.trim(), truncated: true, modelTierApplied: opts.modelTier || "default" };
  }
  sample.json = async (input, opts) => {
    const add = "\n\nReply with only the JSON value, no other text.";
    const inp = typeof input === "string" ? input + add : input.map((m, i) => i === input.length - 1 ? { ...m, content: m.content + add } : m);
    const { text } = await sample(inp, { ...(opts || {}), tools: undefined });
    const tryParse = t => { try { return JSON.parse(t); } catch (e) { return undefined; } };
    let v = tryParse(text.trim());
    if (v === undefined) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) v = tryParse(m[1]); }
    if (v === undefined) { const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")); if (a >= 0 && b > a) v = tryParse(text.slice(a, b + 1)); }
    if (v === undefined) throw { code: "invalid_json", message: "no JSON", text };
    return v;
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
  window.claude = { use: async name => name === "db" ? db : name === "sample" ? sample : null };

  /* ---------- "Coco's brain" card in the Family tab (parents add the key once) ---------- */
  function keyCard() {
    const famTab = document.querySelector('[data-tab="family"]'); if (!famTab || document.getElementById("cocoBrain")) return;
    const box = document.createElement("div"); box.id = "cocoBrain";
    box.innerHTML = `<div class="section-h">Coco's brain</div>
      <div class="list plain"><div class="cell"><input class="field" id="cbKey" type="password" placeholder="Paste the free Gemini key (AIza…) or a Claude key" aria-label="Coco's brain key" autocomplete="off"></div></div>
      <p class="section-f" id="cbNote"></p>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" id="cbSave">Save key</button><button class="btn sm gray" id="cbRemove">Remove</button></div>`;
    const anchor = famTab.querySelector("#codeBox") || famTab.firstElementChild.nextSibling;
    famTab.insertBefore(box, anchor);
    const note = () => { box.querySelector("#cbNote").textContent = getKey() ? "✅ Coco can think and the kindness check is on (" + (isGemini(getKey()) ? "free Google Gemini" : "Claude") + "). The key stays only on this tablet." : "Without a key, Coco can only lead journeys and breathing. Free key: open aistudio.google.com/apikey, sign in with Google, tap Create API key, copy it and paste it here."; };
    note();
    box.querySelector("#cbSave").onclick = async () => {
      const k = box.querySelector("#cbKey").value.trim(); if (!k) return;
      try { localStorage.setItem(KEY_STORE, k); } catch (e) {}
      box.querySelector("#cbNote").textContent = "Checking the key…";
      try { await callClaude([{ role: "user", content: "Say OK." }], [], "quick"); box.querySelector("#cbKey").value = ""; note(); location.reload(); }
      catch (e) { box.querySelector("#cbNote").textContent = "That key didn't work (" + e.message + "). Check it and try again."; }
    };
    box.querySelector("#cbRemove").onclick = () => { try { localStorage.removeItem(KEY_STORE); } catch (e) {} note(); };
  }
  new MutationObserver(() => { const isParent = !!document.querySelector("#codeBox:not([hidden])"); const b = document.getElementById("cocoBrain");
    if (isParent && !b) keyCard(); if (b) b.hidden = !isParent; }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["hidden"] });

  if (navigator.serviceWorker && navigator.serviceWorker.register) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
