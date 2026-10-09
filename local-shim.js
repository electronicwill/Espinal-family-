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

  /* ---------- Coco's brain: Claude, with the key saved on this device ---------- */
  const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
  const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } };
  async function callClaude(messages, tools, tier, signal) {
    const key = getKey();
    if (!key) throw { code: "not_granted", message: "No Claude key on this device" };
    const body = { model: MODELS[tier] || MODELS.default, max_tokens: 1500, messages };
    if (tools && tools.length) body.tools = tools;
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body) });
    } catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled", message: "cancelled" }; throw { code: "upstream_error", message: "No internet connection" }; }
    if (r.status === 401 || r.status === 403) throw { code: "not_granted", message: "The Claude key isn't valid" };
    if (r.status === 429) throw { code: "rate_limited", message: "Too many requests" };
    if (!r.ok) throw { code: "upstream_error", message: "Claude error " + r.status };
    return r.json();
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
      <div class="list plain"><div class="cell"><input class="field" id="cbKey" type="password" placeholder="Paste the Claude API key (sk-ant-…)" aria-label="Claude API key" autocomplete="off"></div></div>
      <p class="section-f" id="cbNote"></p>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" id="cbSave">Save key</button><button class="btn sm gray" id="cbRemove">Remove</button></div>`;
    const anchor = famTab.querySelector("#codeBox") || famTab.firstElementChild.nextSibling;
    famTab.insertBefore(box, anchor);
    const note = () => { box.querySelector("#cbNote").textContent = getKey() ? "✅ Coco can think and the kindness check is on. The key stays only on this tablet." : "Without a key, Coco can only lead journeys and breathing. Get a key at console.anthropic.com → API Keys (set a monthly limit under Billing)."; };
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
