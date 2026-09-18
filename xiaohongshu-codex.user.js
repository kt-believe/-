// ==UserScript==
// @name         小红书 · Codex 外观
// @namespace    https://www.xiaohongshu.com/
// @version      2.4.0
// @description  把小红书网页版（www.xiaohongshu.com）伪装成 OpenAI Codex 桌面应用外观：左侧会话栏 + 中间对话流 + 右侧代码面板。笔记流与详情页均以页面 DOM 为优先数据源；支持正文、图片灯箱和受控评论加载；带 xsec_token 的真实跳转、应急伪装键和设置面板。
// @author       doubao
// @match        https://www.xiaohongshu.com/*
// @noframes
// @grant        none
// @run-at       document-start
// ==/UserScript==
/*
 * ── 设计说明（参考 hupu-codex 的思路，针对小红书重写） ──────────────────
 *
 * 1. 数据来源：小红书当前 Web 版不一定暴露 window.__INITIAL_STATE__。
 *    因此页面 DOM 是一等数据源，state 仅作为增强回退。列表从真实笔记链接
 *    读取带 xsec_token 的 URL；详情从 #noteContainer 读取标题、正文、作者、
 *    图片与评论。评论只读取原生页已加载的内容；需要下一批时由用户手动触发一次
 *    原生滚动，脚本不会展开楼中楼或在后台连续分页，避免触发站点限流。
 *
 * 2. 路由：
 *      /explore 或 /            → 推荐流（feed）
 *      /discovery/item/<id>     → 笔记详情
 *      /search_result?keyword=  → 搜索结果
 *      /user/profile/<id>       → 用户主页
 *    其余页面只渲染外壳 + 空状态，不接管内容。
 *
 * 3. 伪装策略：
 *      · document-start 注入样式 + 全屏 boot 遮罩，原生 #app 直接被隐藏，
 *        不存在"先闪一下小红书原网页"的问题；
 *      · 标签页标题 → "<项目名>.ts — OpenAI Codex"；favicon → Codex 风花朵；
 *      · 笔记卡片渲染成对话流里的"思考块 + tool_call + 结果卡片"；
 *      · 应急伪装键按下后，整个视口变成"代码编辑器 + 构建日志"；
 *      · 点击笔记卡片会跳转真实笔记页（脚本会继续伪装），点返回可回到列表。
 *
 * 4. 只做外观。不代替用户登录、不采集、不发送任何数据；设置存在 localStorage。
 * ──────────────────────────────────────────────────────────────────────
 */
(function () {
  "use strict";

  /* ============================== 设置 ============================== */
  const DEFAULTS = {
    theme: "dark",          // "auto" | "dark" | "light"
    stealth: true,          // 伪装：Codex 品牌名 + 标签页标题 + favicon
    stealthKey: "esc2",     // "esc2" 双击 Esc | "f2" | "ctrl+shift+h"
    brandName: "",          // 左栏品牌名，空 = 按 stealth 决定（Codex / 小红书）
    projectName: "platform",
    codePanel: true,        // 右侧代码面板（装饰）
    panelWidth: 420,
    railWidth: 264,
    listTraceRate: 55,      // 列表里穿插"思考块"的比例（%）
    traceOpen: false,       // 列表思考块默认展开
    favicon: "codex"        // "codex" | "site"
  };
  const SETTINGS_KEY = "xhs:codex:settings";
  let SETTINGS = null;

  function loadSettings() {
    const out = Object.assign({}, DEFAULTS);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
          if (obj[k] !== undefined && typeof obj[k] === typeof DEFAULTS[k]) out[k] = obj[k];
        }
      }
    } catch { /* 坏数据用默认 */ }
    return out;
  }
  function cfg(key) {
    if (!SETTINGS) SETTINGS = loadSettings();
    return SETTINGS[key] !== undefined ? SETTINGS[key] : DEFAULTS[key];
  }
  function setCfg(key, value, visualOnly) {
    if (!SETTINGS) SETTINGS = loadSettings();
    SETTINGS[key] = value;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* ignore */ }
    if (visualOnly) applyVisual();
    else applySettings();
  }
  function resetSettings() {
    SETTINGS = Object.assign({}, DEFAULTS);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* ignore */ }
    applySettings();
    toast("已恢复默认设置");
  }
  function brandName() {
    const custom = String(cfg("brandName") || "");
    return custom || (cfg("stealth") ? "Codex" : "小红书");
  }

  /* ============================== 常量 / 状态 ============================== */
  const ROOT_ID = "xhs-cx-root";
  const STYLE_ID = "xhs-cx-theme";
  const BOSS_ID = "xhs-cx-boss";
  const SETTINGS_ID = "xhs-cx-settings";
  const HOME = "https://www.xiaohongshu.com";
  const SITE_TITLE_ORIG = document.title;
  const SITE_FAVICON_ORIG = (document.querySelector('link[rel*="icon"]') || {}).href || "";

  let ready = false;          // DOMContentLoaded
  let started = false;        // 首次渲染完成
  let paused = false;         // 暂停伪装（露出原生页面）
  let nativeLoginMode = false; // 正在「原生页面登录」模式：检测到登录后自动恢复伪装
  let loginAutoPaused = false; // /login 页已自动暂停过一次（避免恢复后又立刻被暂停）
  let stateRef = null, stateGen = 0;
  let bossTimer = null, bossIdx = 0, bossTick = null;
  let lastEscAt = 0;
  let toasts = null;

  /* ============================== 内联 SVG ============================== */
  const ICONS = {
    sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.9 5.6 5.6 1.9-5.6 1.9L12 17.2l-1.9-5.6L4.5 9.7l5.6-1.9L12 2.2Z"/><path d="M18.4 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 3 21 9 15 9"/></svg>`,
    chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 9 12 14 17 9"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/></svg>`
  };

  /* ============================== 工具函数 ============================== */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function short(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function txt(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function fmtCount(v) {
    if (v == null || v === "") return "0";
    if (typeof v === "number") {
      if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
      return String(v);
    }
    return String(v);
  }
  function relTime(ts) {
    if (!ts) return "";
    const n = Number(ts);
    const d = new Date(n < 1e11 ? n * 1000 : n);
    if (isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    const m = 60000, h = 60 * m, day = 24 * h;
    if (diff >= 0 && diff < m) return "刚刚";
    if (diff >= 0 && diff < h) return Math.floor(diff / m) + " 分钟前";
    if (diff >= 0 && diff < day) return Math.floor(diff / h) + " 小时前";
    if (diff >= 0 && diff < 30 * day) return Math.floor(diff / day) + " 天前";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function traceOn(seed) {
    return mulberry32(hashSeed("tr-" + seed))() * 100 < Number(cfg("listTraceRate"));
  }
  let toastTimer = null;
  function toast(msg) {
    if (!toasts) return;
    toasts.textContent = msg;
    toasts.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toasts.classList.remove("on"), 1800);
  }
  function imgUrl(u) {
    if (!u) return "";
    return String(u).replace(/^http:\/\//i, "https://");
  }

  /* ============================== 读取页面数据 ============================== */
  function getState() {
    let s = null;
    try { s = window.__INITIAL_STATE__ || null; } catch { /* ignore */ }
    if (s !== stateRef) { stateRef = s; stateGen++; }
    return s;
  }
  function currentRoute() {
    const p = location.pathname;
    let m;
    // 当前小红书详情页标准路径是 /explore/{noteId}（带 xsec_token），旧路径 /discovery/item/{id} 也兼容
    if ((m = p.match(/^\/explore\/([^/?#]+)/))) return { kind: "detail", id: m[1] };
    if ((m = p.match(/^\/discovery\/item\/([^/?#]+)/))) return { kind: "detail", id: m[1] };
    if (p === "/explore" || p === "/explore/" || p === "/" || p === "") return { kind: "feed" };
    if (/^\/search_result/.test(p)) {
      let kw = "";
      try { kw = new URLSearchParams(location.search).get("keyword") || ""; } catch { /* ignore */ }
      return { kind: "search", kw: kw };
    }
    if (/^\/user\/profile\//.test(p)) return { kind: "profile" };
    // 评论/子接口失败时，小红书会跳到 /website-login/error，并把原笔记放在 redirectPath。
    if (/^\/website-login\/error/.test(p)) {
      let code = "", msg = "";
      try {
        const sp = new URLSearchParams(location.search);
        code = sp.get("error_code") || "";
        msg = sp.get("error_msg") || "";
      } catch { /* ignore */ }
      return { kind: "error", redirect: getRedirectPath(), code, msg };
    }
    return { kind: "other" };
  }
  function normFromCard(nc, fallbackId, token) {
    const id = String(nc.noteId || fallbackId || "");
    if (!id) return null;
    const u = nc.user || {};
    const it = nc.interactInfo || {};
    const cov = nc.cover || {};
    const ti = nc.timeInfo || {};
    // 小红书 2023 年后详情页必须带 xsec_token，否则返回 404（error 300031 当前笔记暂时无法浏览）。
    // token 通常在列表项上与 noteCard 平级（node.xsecToken），个别版本嵌在 noteCard 里；字段名可能为
    // xsecToken / xsec_token / XsecToken，都兼容。注意：未登录时服务端往往不下发有效 token。
    const tok = String(token || nc.xsecToken || nc.xsec_token || nc.XsecToken || "");
    return {
      id: id,
      type: String(nc.type || "normal"),
      title: String(nc.displayTitle || ""),
      author: String(u.nickname || u.nickName || u.userName || ""),
      avatar: imgUrl(u.avatar || ""),
      likes: fmtCount(it.likedCount),
      comments: fmtCount(it.commentCount),
      collects: fmtCount(it.collectedCount),
      shares: fmtCount(it.shareCount),
      timeText: ti && ti.timestamp ? relTime(ti.timestamp) : "",
      cover: imgUrl(cov.urlDefault || cov.urlPre || ""),
      desc: "",
      tags: [],
      images: [],
      video: String(nc.type || "normal") === "video",
      url: noteUrl(id, tok),
      _detail: false
    };
  }
  /** 拼详情页 URL（当前标准路径 /explore/{id}）；有 token 时必须带上，否则详情页直接 404 */
  function noteUrl(id, tok, source) {
    return HOME + "/explore/" + id +
      (tok ? "?xsec_token=" + encodeURIComponent(tok) + "&xsec_source=" + (source || "pc_feed") : "");
  }
  function normFromDetail(note) {
    const id = String(note.noteId || note.id || "");
    if (!id) return null;
    const u = note.user || {};
    const it = note.interactInfo || {};
    let imgs = Array.isArray(note.imageList)
      ? note.imageList.map((x) => imgUrl((x && (x.urlDefault || x.urlPre)) || "")).filter(Boolean)
      : [];
    // 视频笔记没有 imageList，用封面当首图
    if (!imgs.length && note.video && note.video.cover && note.video.cover.urlDefault) {
      imgs = [imgUrl(note.video.cover.urlDefault)];
    }
    return {
      id: id,
      type: String(note.type || "normal"),
      title: String(note.title || note.displayTitle || ""),
      author: String(u.nickname || ""),
      avatar: imgUrl(u.avatar || ""),
      likes: fmtCount(it.likedCount),
      comments: fmtCount(it.commentCount),
      collects: fmtCount(it.collectedCount),
      shares: fmtCount(it.shareCount),
      timeText: note.time ? String(note.time) : "",
      cover: imgs[0] || "",
      desc: String(note.desc || ""),
      tags: Array.isArray(note.tagList) ? note.tagList.map((t) => String((t && t.name) || t)).filter(Boolean) : [],
      images: imgs,
      video: !!(note.video && note.video.media) || String(note.type) === "video",
      url: noteUrl(id, ""),
      _detail: true
    };
  }
  /** 递归遍历 state 树，收集 noteCard / noteDetailMap 里的笔记（去重） */
  function collectNotes(root) {
    const out = [];
    const ids = new Set();
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || depth > 7 || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const it of node) visit(it, depth + 1); return; }
      if (seen.has(node)) return;
      seen.add(node);
      const nc = node.noteCard;
      // 注意：真实页面的 noteCard 里没有 noteId，ID 在条目层（node.id）；两者都要兼容
      if (nc && typeof nc === "object" && (nc.noteId || node.id)) {
        const n = normFromCard(nc, node.id, node.xsecToken || node.xsec_token);
        if (n && !ids.has(n.id)) { ids.add(n.id); out.push(n); }
      }
      if (node.noteDetailMap && typeof node.noteDetailMap === "object") {
        for (const k of Object.keys(node.noteDetailMap)) {
          const d = node.noteDetailMap[k];
          if (d && d.note) {
            const n = normFromDetail(d.note);
            if (n && !ids.has(n.id)) { ids.add(n.id); out.push(n); }
          }
        }
      }
      for (const k of Object.keys(node)) {
        if (k === "noteCard" || k === "noteDetailMap") continue;
        visit(node[k], depth + 1);
      }
    };
    visit(root, 0);
    return out;
  }
  /**
   * DOM 兜底 + token 真源：小红书当前版本把带 xsec_token 的详情链接直接渲染在
   * 卡片锚点上（封面 a.cover / 标题 a.title 的 href 形如
   *   /explore/{id}?xsec_token=xxx&xsec_source=... ），这是比 __INITIAL_STATE__
   * 更可靠的 token 来源（state 里 token 可能滞后于接口下发）。
   * 这里扫描所有笔记链接：取 id，优先保留带 xsec_token 的完整 href；顺手补标题/封面。
   */
  function domNotes() {
    const out = [];
    const byId = new Map();
    document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
      if (!m) return;
      const id = m[1];
      const q = href.indexOf("?") > -1 ? href.slice(href.indexOf("?") + 1) : "";
      const tok = q.match(/(?:^|&)xsec_token=([^&]+)/);
      let rec = byId.get(id);
      if (!rec) {
        rec = {
          id: id, type: "normal", title: "", author: "", avatar: "",
          likes: "", comments: "", collects: "", shares: "", timeText: "",
          cover: "", desc: "", tags: [], images: [], video: false,
          url: HOME + "/explore/" + id, _detail: false, _domTok: false
        };
        byId.set(id, rec);
        out.push(rec);
      }
      if (tok && !rec._domTok) { rec.url = href; rec._domTok = true; }
      const cls = (typeof a.className === "string" ? a.className : (a.className && a.className.baseVal) || "").toString();
      if (!rec.title && cls.indexOf("title") > -1) rec.title = short((a.textContent || "").trim(), 60);
      if (!rec.cover && cls.indexOf("cover") > -1) {
        const img = a.querySelector("img");
        if (img) rec.cover = imgUrl(img.getAttribute("src") || img.getAttribute("data-src") || "");
      }
    });
    return out;
  }
  /**
   * 详情页 DOM 回退。当前小红书 Web 版经常不再提供 __INITIAL_STATE__，但
   * #noteContainer 中仍有稳定的语义节点；这里读取已经渲染出来的详情内容。
   */
  function domDetail(id) {
    const box = document.querySelector("#noteContainer");
    if (!box) return null;
    const title = txt(box.querySelector("#detail-title, .note-content .title"));
    const desc = txt(box.querySelector(".detail-desc, .note-content .desc"));
    const author = txt(box.querySelector(".author .username, .author .name"));
    const avatar = imgUrl((box.querySelector(".author img.avatar-item, .author .avatar img") || {}).currentSrc ||
      (box.querySelector(".author img.avatar-item, .author .avatar img") || {}).src || "");
    const images = [];
    const seen = new Set();
    // Swiper 为无缝轮播复制首尾图片，按 URL 去重并跳过头像/评论图片。
    box.querySelectorAll(".media-container .swiper-slide:not(.swiper-slide-duplicate) img, .media-container img").forEach((img) => {
      const url = imgUrl(img.currentSrc || img.getAttribute("src") || "");
      if (url && !seen.has(url)) { seen.add(url); images.push(url); }
    });
    const tags = Array.from(box.querySelectorAll(".detail-desc #hash-tag, .note-content .tag"))
      .map((el) => txt(el).replace(/^#/, "")).filter(Boolean);
    const date = txt(box.querySelector(".note-content .date, .date"));
    if (!title && !desc && !images.length) return null;
    return {
      id: String(id || ""), type: "normal", title, author, avatar,
      likes: "", comments: "", collects: "", shares: "", timeText: date,
      cover: images[0] || "", desc, tags, images, video: !!box.querySelector("video"),
      url: location.href, _detail: true
    };
  }
  /** 仅映射当前原生页已经渲染出来的评论，不请求下一页也不改变滚动位置。 */
  function domComments() {
    const root = document.querySelector("#noteContainer .comments-container");
    if (!root) return { comments: [], count: 0, hasMore: false };
    const parse = (item) => {
      const content = txt(item.querySelector(":scope > .comment-inner-container .content"));
      const nickname = txt(item.querySelector(":scope > .comment-inner-container .author .name"));
      const avatarEl = item.querySelector(":scope > .comment-inner-container .avatar img");
      const avatar = imgUrl((avatarEl && (avatarEl.currentSrc || avatarEl.src)) || "");
      const likeCount = txt(item.querySelector(":scope > .comment-inner-container .interactions .count"));
      const createTime = txt(item.querySelector(":scope > .comment-inner-container .location"));
      return { id: item.id || "", content, likeCount, createTime, nickname, avatar, sub: [] };
    };
    // 回复容器是顶级 .comment-item 的兄弟节点，不是其子节点。
    const comments = Array.from(root.querySelectorAll(":scope .parent-comment")).map((parent) => {
      const top = parent.querySelector(":scope > .comment-item");
      if (!top) return null;
      const item = parse(top);
      item.sub = Array.from(parent.querySelectorAll(":scope > .reply-container .comment-item-sub"))
        .map(parse).filter((c) => c.content || c.nickname);
      return item;
    }).filter((c) => c && (c.content || c.nickname));
    const totalText = txt(root.querySelector(".total"));
    const m = totalText.match(/[\d,.]+/);
    const count = m ? Number(m[0].replace(/,/g, "")) || comments.length : comments.length;
    const loaded = root.querySelectorAll(".comment-item").length;
    const hasExpand = Array.from(root.querySelectorAll(".show-more")).some((el) => isVisible(el));
    return { comments, count, loaded, hasMore: hasExpand || (count > 0 && loaded < count) };
  }
  function isVisible(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" &&
      !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  function countCommentTree(list) {
    let n = 0;
    for (const c of (list || [])) { n++; n += countCommentTree(c.sub); }
    return n;
  }
  /** 合并 state 笔记与 DOM 笔记：DOM 的 token 最新鲜，state 的展示字段更全 */
  function mergeNotes(stateNotes, domList) {
    const out = stateNotes.slice();
    const byId = new Map(out.map((n) => [n.id, n]));
    for (const d of domList) {
      const s = byId.get(d.id);
      if (s) {
        if (d._domTok) s.url = d.url;
        if (d.cover) s.cover = d.cover;
        if (d.title && !s.title) s.title = d.title;
      } else {
        byId.set(d.id, d);
        out.push(d);
      }
    }
    return out;
  }
  /**
   * 从评论源里递归收集评论。兼容两种真实结构：
   *  1) SSR 首屏：noteDetailMap[id].comments = { list:[{id,content,likeCount,userInfo:{nickname,avatar},
   *       createTime,subCommentCount,subComments:{comments:[...]}}], cursor, hasMore }   // camelCase
   *  2) 分页接口（被脚本捕获缓存）：data.comments = [{id,content,like_count,user_info:{nick_name,avatar},
   *       create_time,sub_comment_count,sub_comments:[...]}]                              // snake_case
   * 传入数组或对象均可；按 id 去重。
   */
  function normComments(root) {
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || depth > 7 || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const it of node) walk(it, depth + 1); return; }
      if (seen.has(node)) return;
      seen.add(node);
      const ui = node.userInfo || node.user_info;
      if (ui && typeof ui === "object" && (node.content !== undefined || node.id !== undefined)) {
        const subSrc = node.subComments && node.subComments.comments
          ? node.subComments.comments
          : (Array.isArray(node.sub_comments) ? node.sub_comments : []);
        const subs = subSrc.length ? normComments(subSrc) : [];
        out.push({
          id: String(node.id || ""),
          content: String(node.content || ""),
          likeCount: fmtCount(node.likeCount !== undefined ? node.likeCount : node.like_count),
          createTime: relTime(node.createTime !== undefined ? node.createTime : node.create_time),
          nickname: String(ui.nickname || ui.nick_name || ""),
          avatar: imgUrl(ui.avatar || ""),
          sub: subs
        });
        return; // 评论对象内部不再下钻（userInfo/subComments 已单独处理）
      }
      for (const k of Object.keys(node)) {
        if (k === "userInfo" || k === "user_info" || k === "subComments" || k === "sub_comments") continue;
        walk(node[k], depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }
  /** 详情页数据：笔记 + 评论。兼容几种常见 state 形态，找不到返回 null */
  function detailBundle(state, id) {
    if (!state) return null;
    let entry = null;
    let map = state.note && state.note.noteDetailMap;
    if (map && map[id]) entry = map[id];
    if (!entry) { map = state.noteDetailMap; if (map && map[id]) entry = map[id]; }
    if (!entry && state.note && state.note.note && String(state.note.note.noteId || state.note.note.id || "") === String(id)) {
      entry = { note: state.note.note, comments: state.note.comments || state.note.note.comments || null };
    }
    if (!entry) return null;
    const note = entry.note ? normFromDetail(entry.note) : null;
    // 评论 = SSR 首屏(list) + 脚本捕获的分页接口缓存(__xhsCxComments) 合并去重
    const rawCm = entry.comments || {};
    const base = Array.isArray(rawCm.list) ? rawCm.list : (Array.isArray(rawCm.comments) ? rawCm.comments : []);
    const merged = base.slice();
    const ids = new Set(merged.map((c) => c && c.id).filter(Boolean));
    let captured = null;
    try { captured = (window.__xhsCxComments && window.__xhsCxComments[id]) || null; } catch { /* ignore */ }
    if (captured && Array.isArray(captured.list)) {
      for (const c of captured.list) {
        if (c && c.id && !ids.has(c.id)) { ids.add(c.id); merged.push(c); }
      }
    }
    const comments = merged.length ? normComments(merged) : (entry.comments ? normComments(entry.comments) : []);
    let commentCount = 0;
    if (entry.comments) {
      const cc = entry.comments.commentCount;
      commentCount = (cc != null && Number(cc) > 0) ? Number(cc) : comments.length;
    }
    // commentCount 兜底：取笔记互动数据里的真实评论数
    if (commentCount === 0 && entry.note && entry.note.interactInfo && entry.note.interactInfo.commentCount) {
      commentCount = Number(entry.note.interactInfo.commentCount) || 0;
    }
    if (captured && captured.totalCount && commentCount < Number(captured.totalCount)) {
      commentCount = Number(captured.totalCount);
    }
    return { note, comments, commentCount, hasMore: captured ? captured.hasMore : !!rawCm.hasMore };
  }
  function pageData() {
    const route = currentRoute();
    const state = getState();
    let notes = state ? collectNotes(state) : [];
    // 用 DOM 里的真实 xsec_token 补全/覆盖 state 笔记的跳转 URL（token 可能滞后下发）
    const dom = domNotes();
    if (dom.length) notes = mergeNotes(notes, dom);
    if (!notes.length) notes = domNotes();
    let detail = null, comments = [], commentCount = 0, hasMore = false;
    if (route.kind === "detail") {
      const b = state ? detailBundle(state, route.id) : null;
      if (b) { detail = b.note; comments = b.comments; commentCount = b.commentCount; hasMore = !!b.hasMore; }
      if (!detail) detail = notes.find((n) => n._detail && n.id === route.id) || null;
      // state 在新版页面常为 null，详情必须直接从原生节点读取。
      if (!detail) detail = domDetail(route.id);
      // 没有 state 时照样展示当前页已加载的评论；绝不主动拉取更多。
      if (!comments.length) {
        const domCm = domComments();
        comments = domCm.comments;
        commentCount = Math.max(commentCount, domCm.count);
        hasMore = domCm.hasMore;
      }
      // state 缺失时，合并旁观到的原生分页响应；这些请求均由小红书页面发起。
      try {
        const cached = window.__xhsCxComments && window.__xhsCxComments[route.id];
        if (cached && Array.isArray(cached.list)) {
          const cachedComments = normComments(cached.list);
          const ids = new Set(comments.map((c) => c.id).filter(Boolean));
          for (const c of cachedComments) {
            if (!c.id || !ids.has(c.id)) { comments.push(c); ids.add(c.id); }
          }
          commentCount = Math.max(commentCount, Number(cached.totalCount) || 0, comments.length);
          hasMore = cached.hasMore !== false;
        }
      } catch { /* ignore */ }
    }
    return { state, route, notes, detail, comments, commentCount, hasMore };
  }
  function routeSig() {
    const r = currentRoute();
    return r.kind + "|" + (r.id || r.kw || "") + "|" + stateGen + "|" + location.search;
  }

  /* ============================== 登录状态 ============================== */
  /**
   * 登录态检测（多信号，任中一个即视为已登录）：
   *   __INITIAL_STATE__ 在页面水合后是 Vue 响应式对象，布尔字段往往被包装成 ref
   *   （形如 { _value: true, deps: ... }），必须解包后再比较；直接 === true 会永远失败。
   *   可靠信号：user.loggedIn / user.isLogin / login.loggedIn / login.isLogin 解包后为 true。
   *   不可靠信号（不采用）：web_session cookie（访客也有）；secretKey（访客也可能有）；
   *   userInfo.userId（未登录时也会下发 guest 的占位 userId）。
   */
  function unwrapRef(v) {
    let n = 0;
    while (v && typeof v === "object" && n < 5) {
      if ("_value" in v) v = v._value;
      else if ("value" in v) v = v.value;
      else break;
      n++;
    }
    return v;
  }
  function detectLoginFromState(st) {
    try {
      if (!st) return false;
      const u = unwrapRef(st.user) || {};
      if (unwrapRef(u.loggedIn) === true) return true;
      if (unwrapRef(u.isLogin) === true) return true;
      const lg = unwrapRef(st.login) || {};
      if (unwrapRef(lg.isLogin) === true || unwrapRef(lg.loggedIn) === true) return true;
      if (unwrapRef(st.isLogin) === true) return true;
    } catch { /* ignore */ }
    return false;
  }
  function isLoggedIn() {
    return detectLoginFromState(window.__INITIAL_STATE__);
  }
  /** 当前是否在原生登录页（该页需要露出二维码，不能盖住） */
  function isLoginPage() {
    return /^\/login/.test(location.pathname);
  }
  /** 从 /login?redirectPath=... 取回跳地址（仅允许小红书站内地址，防开放跳转） */
  function getRedirectPath() {
    try {
      const m = location.search.match(/[?&]redirectPath=([^&]+)/);
      if (!m) return "";
      const p = decodeURIComponent(m[1]);
      if (/^https?:\/\/www\.xiaohongshu\.com\/(explore|discovery)/.test(p)) return p;
      if (/^\/(explore|discovery)\//.test(p)) return "https://www.xiaohongshu.com" + p;
      return "";
    } catch { return ""; }
  }
  /** 未登录时会话里有没有 token（决定笔记能否打开） */
  function hasAnyToken(notes) {
    return notes.some((n) => /[?&]xsec_token=/.test(n.url));
  }

  /* ============================== favicon / 标题 ============================== */
  const CX_OPENAI_PATH =
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
  let faviconCache = null;
  function faviconUri() {
    if (cfg("favicon") === "site") return null;
    if (faviconCache) return faviconCache;
    const light = !isDark();
    const bg = light ? "#f2f2f3" : "#0b0b0f";
    const fg = light ? "#0f0f0f" : "#ffffff";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="5.5" fill="' + bg + '"/>' +
      '<path fill="' + fg + '" d="' + CX_OPENAI_PATH + '"/></svg>';
    faviconCache = "data:image/svg+xml," + encodeURIComponent(svg);
    return faviconCache;
  }
  function applyFavicon() {
    if (paused) return;
    const uri = faviconUri();
    let link = document.querySelector('link[rel*="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      (document.head || document.documentElement).appendChild(link);
    }
    if (uri) link.href = uri;
  }
  function restoreFavicon() {
    if (!SITE_FAVICON_ORIG) return;
    const link = document.querySelector('link[rel*="icon"]');
    if (link) link.href = SITE_FAVICON_ORIG;
  }
  function applyTitle() {
    if (paused || !cfg("stealth")) return;
    document.title = cfg("projectName") + ".ts — OpenAI Codex";
  }
  function restoreTitle() {
    document.title = SITE_TITLE_ORIG;
  }

  /* ============================== 主题 ============================== */
  function isDark() {
    const t = cfg("theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
  }
  function applyTheme() {
    document.documentElement.classList.toggle("xhs-cx-light", !isDark());
  }

  /* ============================== CSS ============================== */
  const CSS = `
html.xhs-cx, html.xhs-cx body {
  background: #0b0b0f !important;
  margin: 0 !important;
  overflow: hidden !important;
}
html.xhs-cx #app { display: none !important; }
/* 覆盖层模式（详情页）：原生页保留布局、可被真实滚动以触发评论懒加载；
   Codex 界面是不透明全屏覆盖层，用户看到的仍是完整伪装。 */
html.xhs-cx.xhs-cx-overlay, html.xhs-cx.xhs-cx-overlay body {
  overflow: visible !important;
  scrollbar-width: none !important;
}
html.xhs-cx.xhs-cx-overlay::-webkit-scrollbar { display: none !important; }
html.xhs-cx.xhs-cx-overlay #app {
  display: block !important;
  visibility: visible !important;
  position: static !important;
}
html.xhs-cx-light, html.xhs-cx-light body { background: #f7f7f8 !important; }

#xhs-cx-root {
  --xhs-bg: #0b0b0f; --xhs-rail: #0f0f13; --xhs-panel: #0d0d11;
  --xhs-border: #232329; --xhs-text: #ececf1; --xhs-muted: #9b9ba4;
  --xhs-dim: #63636e; --xhs-accent: #10a37f; --xhs-accent-soft: rgba(16,163,127,.13);
  --xhs-user: #182821; --xhs-card: #141419; --xhs-code: #16161b; --xhs-think: #141419;
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: row;
  background: var(--xhs-bg); color: var(--xhs-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px; line-height: 1.6;
}
html.xhs-cx-light #xhs-cx-root {
  --xhs-bg: #f7f7f8; --xhs-rail: #f0f0f2; --xhs-panel: #fafafa;
  --xhs-border: #e2e2e8; --xhs-text: #101014; --xhs-muted: #5f5f6b;
  --xhs-dim: #8a8a95; --xhs-accent-soft: rgba(16,163,127,.12);
  --xhs-user: #e7f2ee; --xhs-card: #ffffff; --xhs-code: #f1f1f4; --xhs-think: #f4f4f6;
}
#xhs-cx-root * { box-sizing: border-box; }
#xhs-cx-root .xhs-mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
#xhs-cx-root .xhs-mut { color: var(--xhs-muted); }
#xhs-cx-root .xhs-dim { color: var(--xhs-dim); }

/* —— boot —— */
#xhs-cx-root .xhs-boot-box {
  position: fixed; inset: 0; z-index: 5;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--xhs-bg); text-align: center; color: var(--xhs-muted);
}
.xhs-cx-boot-mark { width: 34px; height: 34px; color: var(--xhs-accent); margin: 0 auto 12px; }
.xhs-boot-spin {
  display: inline-block; width: 14px; height: 14px; margin-top: 10px;
  border: 2px solid var(--xhs-border); border-top-color: var(--xhs-accent); border-radius: 50%;
  animation: xhs-cx-spin 0.9s linear infinite;
}
@keyframes xhs-cx-spin { to { transform: rotate(360deg); } }

/* —— rail —— */
.xhs-cx-rail {
  width: var(--rail-w, 264px); flex: none; border-right: 1px solid var(--xhs-border);
  background: var(--xhs-rail); display: flex; flex-direction: column; min-height: 0;
}
.xhs-cx-brand { display: flex; align-items: center; gap: 9px; padding: 14px 14px 10px; }
.xhs-cx-brand svg { width: 22px; height: 22px; color: var(--xhs-accent); }
.xhs-cx-brand b { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
.xhs-cx-brand span { font-size: 11px; color: var(--xhs-dim); }
.xhs-cx-new {
  margin: 2px 12px 10px; padding: 8px 12px; border: 1px solid var(--xhs-border); border-radius: 9px;
  background: transparent; color: var(--xhs-text); cursor: pointer; display: flex; align-items: center; gap: 8px;
  font-size: 13px; transition: background .15s;
}
.xhs-cx-new:hover { background: var(--xhs-card); }
.xhs-cx-new svg { width: 15px; height: 15px; color: var(--xhs-muted); }
.xhs-cx-sessions { flex: 1; overflow-y: auto; padding: 2px 8px; }
.xhs-cx-session {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; margin: 1px 0;
  border-radius: 8px; cursor: pointer; color: var(--xhs-muted); font-size: 13px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.xhs-cx-session:hover { background: var(--xhs-card); color: var(--xhs-text); }
.xhs-cx-session svg { width: 14px; height: 14px; flex: none; color: var(--xhs-dim); }
.xhs-cx-session.on { background: var(--xhs-card); color: var(--xhs-text); }
.xhs-cx-rail-foot {
  border-top: 1px solid var(--xhs-border); padding: 8px 10px; display: flex; gap: 6px;
}
.xhs-cx-rail-foot button {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  background: transparent; border: 1px solid var(--xhs-border); border-radius: 8px;
  color: var(--xhs-muted); cursor: pointer; padding: 6px 4px; font-size: 12px;
}
.xhs-cx-rail-foot button:hover { color: var(--xhs-text); background: var(--xhs-card); }
.xhs-cx-rail-foot svg { width: 14px; height: 14px; }
.xhs-cx-rail-login { padding: 2px 12px 8px; }
.xhs-cx-rail-login button {
  width: 100%; padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid rgba(16,163,127,.45); background: var(--xhs-accent-soft);
  color: var(--xhs-accent); font-size: 12.5px; font-weight: 650; font-family: inherit;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.xhs-cx-rail-login button:hover { background: rgba(16,163,127,.22); }
.xhs-cx-rail-login button.on { border-color: var(--xhs-border); background: transparent; color: var(--xhs-dim); cursor: default; font-weight: 500; }

/* —— 登录弹窗（内嵌小红书原生页面，配合 @noframes 脚本不会在 iframe 里运行） —— */
#xhs-cx-login {
  position: fixed; inset: 0; z-index: 2147483080; display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55);
}
#xhs-cx-login.on { display: flex; }
.xhs-cx-login-card {
  width: 600px; max-width: calc(100vw - 40px); overflow: hidden;
  background: #141419; color: #ececf1; border: 1px solid #2a2a31; border-radius: 14px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.xhs-cx-login-hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #222228; }
.xhs-cx-login-hd b { font-size: 15px; }
.xhs-cx-login-close { cursor: pointer; color: #9b9ba4; font-size: 16px; padding: 4px 10px; border-radius: 6px; }
.xhs-cx-login-close:hover { color: #ececf1; background: #222228; }
.xhs-cx-login-tip { padding: 10px 16px; font-size: 12.5px; color: #9b9ba4; line-height: 1.6; border-bottom: 1px solid #222228; }
.xhs-cx-login-frame { height: 500px; background: #ffffff; }
.xhs-cx-login-frame iframe { width: 100%; height: 100%; border: none; display: block; }
.xhs-cx-login-status { padding: 10px 16px; font-size: 12.5px; color: #10a37f; border-top: 1px solid #222228; }
.xhs-cx-login-status.warn { color: #e0a45c; }
.xhs-cx-login-btns { padding: 0 16px 14px; }
.xhs-cx-login-btns button {
  width: 100%; padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid #2a2a31; background: #0f0f13; color: #9b9ba4;
  font-size: 12.5px; font-family: inherit;
}
.xhs-cx-login-btns button:hover { color: #ececf1; border-color: #10a37f; }

/* —— main —— */
.xhs-cx-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.xhs-cx-topbar {
  height: 50px; flex: none; border-bottom: 1px solid var(--xhs-border);
  display: flex; align-items: center; gap: 10px; padding: 0 16px;
}
.xhs-cx-topbar .xhs-tb-btn {
  width: 30px; height: 30px; border: none; background: transparent; color: var(--xhs-muted);
  border-radius: 7px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.xhs-cx-topbar .xhs-tb-btn:hover { background: var(--xhs-card); color: var(--xhs-text); }
.xhs-cx-topbar .xhs-tb-btn svg { width: 17px; height: 17px; }
.xhs-cx-crumb { font-size: 12.5px; color: var(--xhs-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xhs-cx-crumb b { color: var(--xhs-text); font-weight: 600; }
.xhs-cx-topbar .xhs-tb-right { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--xhs-muted); }
.xhs-cx-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--xhs-accent); box-shadow: 0 0 6px var(--xhs-accent); animation: xhs-cx-pulse 2s ease-in-out infinite; }
@keyframes xhs-cx-pulse { 50% { opacity: .35; } }

.xhs-cx-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; }
.xhs-cx-flow { max-width: 880px; margin: 0 auto; padding: 22px 26px 60px; }

.xhs-cx-turn-user { display: flex; justify-content: flex-end; margin: 14px 0 6px; }
.xhs-cx-turn-user .xhs-cx-bubble {
  background: var(--xhs-user); border: 1px solid rgba(16,163,127,.35);
  border-radius: 13px; padding: 9px 14px; max-width: 78%;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.8px; color: var(--xhs-text);
  word-break: break-all;
}

.xhs-cx-think {
  margin: 12px 0 6px; border: 1px solid var(--xhs-border); border-left: 2px solid var(--xhs-accent);
  background: var(--xhs-think); border-radius: 9px; overflow: hidden;
}
.xhs-cx-think-hd {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer;
  font-size: 12.5px; color: var(--xhs-muted); user-select: none;
}
.xhs-cx-think-hd svg { width: 13px; height: 13px; transition: transform .15s; color: var(--xhs-dim); }
.xhs-cx-think.open .xhs-cx-think-hd svg { transform: rotate(180deg); }
.xhs-cx-think-bd { display: none; padding: 0 12px 10px; font-size: 13px; color: var(--xhs-muted); }
.xhs-cx-think.open .xhs-cx-think-bd { display: block; }

.xhs-cx-tool {
  display: flex; align-items: baseline; gap: 8px; margin: 4px 0 2px;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--xhs-muted);
  padding-left: 2px;
}
.xhs-cx-tool .xhs-tool-mark { color: var(--xhs-dim); flex: none; }
.xhs-cx-tool .xhs-tool-name { color: #c678dd; }
.xhs-cx-tool .xhs-tool-args { color: var(--xhs-muted); word-break: break-all; }

.xhs-cx-result { margin: 6px 0 18px; font-size: 12.5px; color: var(--xhs-muted); }

/* —— 笔记卡片 —— */
.xhs-cx-card {
  display: block; text-decoration: none; color: inherit; cursor: pointer;
  background: var(--xhs-card); border: 1px solid var(--xhs-border); border-radius: 11px;
  padding: 13px 15px; margin: 6px 0 14px; transition: border-color .15s, background .15s;
}
.xhs-cx-card:hover { border-color: var(--xhs-accent); background: var(--xhs-think); }
.xhs-cx-card-hd { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; }
.xhs-cx-avatar {
  width: 24px; height: 24px; border-radius: 50%; background: var(--xhs-border); color: var(--xhs-muted);
  display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex: none;
  overflow: hidden; position: relative;
}
.xhs-cx-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.xhs-cx-card-author { font-size: 12.5px; color: var(--xhs-muted); }
.xhs-cx-card-title { font-size: 15px; font-weight: 620; line-height: 1.45; }
.xhs-cx-card-body { display: flex; gap: 14px; margin-top: 9px; }
.xhs-cx-card-desc { flex: 1; min-width: 0; font-size: 13px; color: var(--xhs-muted); line-height: 1.65; }
.xhs-cx-card-desc .xhs-readmore { color: var(--xhs-accent); font-size: 12.5px; }
.xhs-cx-cover {
  width: 122px; height: 92px; flex: none; border-radius: 8px; object-fit: cover;
  background: var(--xhs-border); border: 1px solid var(--xhs-border);
}
.xhs-cx-card-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 12px; color: var(--xhs-dim); }
.xhs-cx-card-meta b { color: var(--xhs-muted); font-weight: 600; }
.xhs-cx-chip {
  display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
  background: var(--xhs-accent-soft); color: var(--xhs-accent);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.xhs-cx-tag { display: inline-block; padding: 2px 9px; margin: 3px 6px 0 0; border-radius: 999px; font-size: 11.5px; background: var(--xhs-think); border: 1px solid var(--xhs-border); color: var(--xhs-muted); }
.xhs-cx-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 10px; }
.xhs-cx-images img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; border: 1px solid var(--xhs-border); cursor: zoom-in; }
.xhs-cx-card .xhs-open { margin-top: 10px; font-size: 12px; color: var(--xhs-accent); }

/* —— 详情页 —— */
.xhs-cx-detail {
  background: var(--xhs-card); border: 1px solid var(--xhs-border); border-radius: 12px;
  padding: 16px 18px; margin: 6px 0 10px;
}
.xhs-cx-desc { margin-top: 10px; font-size: 14px; color: var(--xhs-text); line-height: 1.75; white-space: pre-wrap; word-break: break-word; }
.xhs-cx-cmts { margin: 4px 0 10px; background: var(--xhs-card); border: 1px solid var(--xhs-border); border-radius: 11px; padding: 4px 16px; }
.xhs-cx-cmt { display: flex; gap: 10px; padding: 13px 0; border-bottom: 1px solid var(--xhs-border); }
.xhs-cx-cmt:last-child { border-bottom: none; }
.xhs-cx-cmt .xhs-cx-avatar { width: 28px; height: 28px; flex: none; margin-top: 2px; }
.xhs-cx-cmt-body { flex: 1; min-width: 0; }
.xhs-cx-cmt-hd { font-size: 12px; color: var(--xhs-dim); }
.xhs-cx-cmt-content { font-size: 13.5px; color: var(--xhs-text); margin-top: 3px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.xhs-cx-cmt-meta { font-size: 11.5px; color: var(--xhs-dim); margin-top: 4px; }
.xhs-cx-backlink {
  display: inline-block; margin-top: 12px; padding: 8px 16px; border-radius: 9px;
  background: var(--xhs-accent); color: #04251c; font-weight: 650; font-size: 13px; text-decoration: none;
}
.xhs-cx-backlink:hover { filter: brightness(1.08); }

/* —— 图片灯箱 —— */
#xhs-cx-lightbox {
  position: fixed; inset: 0; z-index: 2147483250; background: rgba(4,4,8,.92);
  display: none; align-items: center; justify-content: center;
}
#xhs-cx-lightbox.on { display: flex; }
#xhs-cx-lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 10px; box-shadow: 0 10px 50px rgba(0,0,0,.6); }
#xhs-cx-lightbox .xhs-cx-lb-close {
  position: absolute; top: 14px; right: 20px; font-size: 22px; color: #9b9ba4; cursor: pointer; padding: 10px; line-height: 1;
}
#xhs-cx-lightbox .xhs-cx-lb-close:hover { color: #ffffff; }

.xhs-cx-fin { display: flex; align-items: center; gap: 8px; margin: 10px 0 26px; color: var(--xhs-dim); font-size: 12px; }
.xhs-cx-fin::after { content: ""; flex: 1; height: 1px; background: var(--xhs-border); }
.xhs-cx-empty { text-align: center; padding: 70px 20px; color: var(--xhs-muted); font-size: 13px; }
.xhs-cx-empty svg { width: 30px; height: 30px; color: var(--xhs-dim); margin-bottom: 10px; }

/* —— composer —— */
.xhs-cx-composer { flex: none; border-top: 1px solid var(--xhs-border); padding: 12px 26px 16px; }
.xhs-cx-composer-in { max-width: 880px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; }
.xhs-cx-composer textarea {
  flex: 1; resize: none; height: 46px; max-height: 140px; padding: 11px 14px;
  background: var(--xhs-card); border: 1px solid var(--xhs-border); border-radius: 11px;
  color: var(--xhs-text); font-family: inherit; font-size: 13.5px; outline: none;
}
.xhs-cx-composer textarea:focus { border-color: var(--xhs-accent); }
.xhs-cx-composer textarea::placeholder { color: var(--xhs-dim); }
.xhs-cx-send {
  height: 46px; padding: 0 18px; border: none; border-radius: 11px; cursor: pointer;
  background: var(--xhs-accent); color: #04251c; font-weight: 650; font-size: 13.5px;
  display: flex; align-items: center; gap: 7px;
}
.xhs-cx-send:hover { filter: brightness(1.08); }
.xhs-cx-send:disabled { opacity: .5; cursor: default; }

/* —— 右侧代码面板 —— */
.xhs-cx-panel {
  width: var(--panel-w, 420px); flex: none; border-left: 1px solid var(--xhs-border);
  background: var(--xhs-panel); display: flex; flex-direction: column; min-height: 0;
}
.xhs-cx-panel-hd { height: 42px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--xhs-border); }
.xhs-cx-dots { display: flex; gap: 6px; }
.xhs-cx-dots i { width: 11px; height: 11px; border-radius: 50%; display: block; }
.xhs-cx-dots i:nth-child(1) { background: #ff5f57; }
.xhs-cx-dots i:nth-child(2) { background: #febc2e; }
.xhs-cx-dots i:nth-child(3) { background: #28c840; }
.xhs-cx-panel-fname { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--xhs-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xhs-cx-panel-body { flex: 1; overflow: auto; padding: 14px 16px; }
.xhs-cx-panel-body pre { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.75; color: #d4d4d8; white-space: pre; }
html.xhs-cx-light .xhs-cx-panel-body pre { color: #3a3a44; }
.xhs-cx-panel-body .hl-com { color: var(--xhs-dim); }
.xhs-cx-panel-body .hl-str { color: #98c379; }
.xhs-cx-panel-body .hl-kw { color: #c678dd; }
.xhs-cx-panel-body .hl-num { color: #d19a66; }
.xhs-cx-panel-status { flex: none; border-top: 1px solid var(--xhs-border); padding: 7px 14px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--xhs-dim); }

/* —— toast —— */
#xhs-cx-toast {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%) translateY(12px);
  z-index: 2147483200; background: var(--xhs-card, #141419); color: var(--xhs-text, #ececf1);
  border: 1px solid var(--xhs-border, #232329); padding: 8px 16px; border-radius: 999px;
  font-size: 12.5px; opacity: 0; pointer-events: none; transition: all .2s;
}
#xhs-cx-toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* —— 应急伪装（boss） —— */
#xhs-cx-boss {
  position: fixed; inset: 0; z-index: 2147483100; background: #0b0b0f; color: #ececf1;
  display: none; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px;
}
#xhs-cx-boss.on { display: flex; }
.xhs-boss-tree { width: 240px; flex: none; border-right: 1px solid #232329; padding: 12px 8px; overflow: auto; }
.xhs-boss-tree .xhs-boss-f { display: flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: 6px; color: #9b9ba4; cursor: default; }
.xhs-boss-tree .xhs-boss-f svg { width: 13px; height: 13px; color: #63636e; }
.xhs-boss-tree .xhs-boss-f.on { background: #1b1b20; color: #ececf1; }
.xhs-boss-editor { flex: 1; overflow: auto; padding: 18px 22px; white-space: pre; line-height: 1.7; }
.xhs-boss-editor .l-com { color: #63636e; }
.xhs-boss-editor .l-str { color: #98c379; }
.xhs-boss-editor .l-kw { color: #c678dd; }
.xhs-boss-log { width: 340px; flex: none; border-left: 1px solid #232329; display: flex; flex-direction: column; }
.xhs-boss-log-hd { padding: 9px 14px; border-bottom: 1px solid #232329; color: #63636e; font-size: 11.5px; }
.xhs-boss-log-bd { flex: 1; overflow: hidden; padding: 12px 14px; line-height: 1.85; color: #b8b8c0; }

/* —— 设置面板 —— */
#xhs-cx-settings {
  position: fixed; inset: 0; z-index: 2147483050; display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55);
}
#xhs-cx-settings.on { display: flex; }
.xhs-cx-settings-card {
  width: 440px; max-width: calc(100vw - 40px); max-height: calc(100vh - 60px); overflow: auto;
  background: #141419; color: #ececf1; border: 1px solid #2a2a31; border-radius: 14px; padding: 20px 22px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.xhs-cx-settings-card h3 { margin: 0 0 4px; font-size: 16px; }
.xhs-cx-settings-card .xhs-cx-sc-sub { color: #9b9ba4; font-size: 12px; margin-bottom: 16px; }
.xhs-cx-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 9px 0; border-bottom: 1px solid #222228; font-size: 13.5px; }
.xhs-cx-row:last-child { border-bottom: none; }
.xhs-cx-row label { color: #cfcfd6; }
.xhs-cx-row input[type="text"], .xhs-cx-row select {
  width: 150px; padding: 6px 9px; background: #0f0f13; border: 1px solid #2a2a31; border-radius: 8px;
  color: #ececf1; font-size: 13px; outline: none;
}
.xhs-cx-row input[type="range"] { width: 150px; accent-color: #10a37f; }
.xhs-cx-row .xhs-cx-val { width: 42px; text-align: right; color: #9b9ba4; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.xhs-cx-row input[type="checkbox"] { accent-color: #10a37f; width: 16px; height: 16px; }
.xhs-cx-settings-btns { display: flex; gap: 10px; margin-top: 16px; }
.xhs-cx-settings-btns button {
  flex: 1; padding: 8px 0; border-radius: 9px; border: 1px solid #2a2a31; background: #0f0f13;
  color: #ececf1; cursor: pointer; font-size: 13px;
}
.xhs-cx-settings-btns button:hover { border-color: #10a37f; }
.xhs-cx-settings-btns .xhs-cx-btn-primary { background: #10a37f; color: #04251c; border: none; font-weight: 650; }
`;

  /* ============================== DOM 骨架 ============================== */
  let rootEl = null, scrollEl = null, flowEl = null, railEl = null, sessionsEl = null;
  let panelBodyEl = null, bossEl = null, bossLogEl = null, settingsEl = null;

  function ensureRoot() {
    if (rootEl) return;
    rootEl = document.getElementById(ROOT_ID);
    if (rootEl) { rootEl.innerHTML = ""; return; }
    rootEl = document.createElement("div");
    rootEl.id = ROOT_ID;
    (document.body || document.documentElement).appendChild(rootEl);
  }
  function buildAppShell() {
    ensureRoot();
    rootEl.innerHTML =
      '<div class="xhs-boot-box" id="xhs-cx-boot-box">' +
        '<div class="xhs-boot-mark">' + ICONS.sparkle + '</div>' +
        '<div>Codex</div><div class="xhs-boot-spin"></div>' +
      '</div>';

    /* rail */
    railEl = document.createElement("aside");
    railEl.className = "xhs-cx-rail";
    railEl.innerHTML =
      '<div class="xhs-cx-brand">' + ICONS.sparkle + '<b></b><span>v2.4.0</span></div>' +
      '<button class="xhs-cx-new" id="xhs-cx-new">' + ICONS.plus + '<span>新建会话</span></button>' +
      '<div class="xhs-cx-sessions" id="xhs-cx-sessions"></div>' +
      '<div class="xhs-cx-rail-login"><button id="xhs-cx-login-btn" title="登录小红书后才能打开笔记详情">未登录 · 点击登录</button></div>' +
      '<div class="xhs-cx-rail-foot">' +
        '<button id="xhs-cx-pause" title="暂停伪装 / 恢复伪装">' + ICONS.pause + '<span>暂停</span></button>' +
        '<button id="xhs-cx-settings-btn" title="设置">' + ICONS.gear + '</button>' +
      '</div>';
    sessionsEl = railEl.querySelector("#xhs-cx-sessions");
    rootEl.appendChild(railEl);

    /* main */
    const mainEl = document.createElement("main");
    mainEl.className = "xhs-cx-main";
    mainEl.innerHTML =
      '<div class="xhs-cx-topbar">' +
        '<button class="xhs-tb-btn" id="xhs-cx-back" title="返回">' + ICONS.back + '</button>' +
        '<button class="xhs-tb-btn" id="xhs-cx-refresh" title="刷新数据（获取新的 xsec_token）">' + ICONS.refresh + '</button>' +
        '<div class="xhs-cx-crumb xhs-mono" id="xhs-cx-crumb"></div>' +
        '<div class="xhs-tb-right"><span class="xhs-cx-dot"></span><span id="xhs-cx-status">agent 就绪</span></div>' +
      '</div>' +
      '<div class="xhs-cx-scroll" id="xhs-cx-scroll"><div class="xhs-cx-flow" id="xhs-cx-flow"></div></div>' +
      '<div class="xhs-cx-composer">' +
        '<div class="xhs-cx-composer-in">' +
          '<textarea id="xhs-cx-input" placeholder="输入关键词搜索小红书，Enter 发送 · / 聚焦输入框" rows="1"></textarea>' +
          '<button class="xhs-cx-send" id="xhs-cx-send">发送 ↗</button>' +
        '</div>' +
      '</div>';
    rootEl.appendChild(mainEl);
    scrollEl = mainEl.querySelector("#xhs-cx-scroll");
    flowEl = mainEl.querySelector("#xhs-cx-flow");

    /* panel */
    const panelEl = document.createElement("aside");
    panelEl.className = "xhs-cx-panel";
    panelEl.innerHTML =
      '<div class="xhs-cx-panel-hd">' +
        '<div class="xhs-cx-dots"><i></i><i></i><i></i></div>' +
        '<span class="xhs-cx-panel-fname" id="xhs-cx-panel-fname">feed.ts — 小红书店</span>' +
      '</div>' +
      '<div class="xhs-cx-panel-body" id="xhs-cx-panel-body"><pre></pre></div>' +
      '<div class="xhs-cx-panel-status xhs-mono" id="xhs-cx-panel-status"></div>';
    rootEl.appendChild(panelEl);
    panelBodyEl = panelEl.querySelector("#xhs-cx-panel-body");

    applyVisual();
  }

  /* ============================== 渲染 ============================== */
  function applyVisual() {
    const r = document.documentElement;
    r.style.setProperty("--rail-w", cfg("railWidth") + "px");
    r.style.setProperty("--panel-w", cfg("panelWidth") + "px");
    applyTheme();
    applyFavicon();
    const rail = rootEl && rootEl.querySelector(".xhs-cx-brand b");
    if (rail) rail.textContent = brandName();
    const panel = rootEl && rootEl.querySelector(".xhs-cx-panel");
    if (panel) panel.style.display = cfg("codePanel") ? "" : "none";
  }
  function applySettings() {
    applyVisual();
    render();
  }

  /* —— 思考块 / 工具调用 装饰 —— */
  const THINK_POOL = [
    (t) => "分析笔记「" + t + "」的热度与内容结构，提取关键词用于后续检索。",
    (t) => "「" + t + "」涉及的主题与当前上下文相关，先快速浏览摘要再决定是否精读。",
    (t) => "判断「" + t + "」是否值得阅读：先看互动量，再结合标题语义过滤。",
    (t) => "过滤重复内容后，保留「" + t + "」作为候选结果，等待下一步处理。",
    (t) => "「" + t + "」的内容密度较高，展开正文并归纳要点。"
  ];
  function thinkHtml(seed, title) {
    const rnd = mulberry32(hashSeed("th-" + seed));
    const text = THINK_POOL[Math.floor(rnd() * THINK_POOL.length)](title || "该笔记");
    const dur = (rnd() * 1.4 + 0.6).toFixed(1);
    const open = cfg("traceOpen");
    return '<div class="xhs-cx-think' + (open ? " open" : "") + '" data-toggle="1">' +
      '<div class="xhs-cx-think-hd">' + ICONS.chev + '<span>思考 · ' + dur + 's</span></div>' +
      '<div class="xhs-cx-think-bd">' + escapeHtml(text) + '</div></div>';
  }
  function toolLine(name, args) {
    return '<div class="xhs-cx-tool"><span class="xhs-tool-mark">⎿</span>' +
      '<span class="xhs-tool-name">' + escapeHtml(name) + '</span>' +
      '<span class="xhs-tool-args">' + escapeHtml(args) + '</span></div>';
  }
  function userTurn(text) {
    return '<div class="xhs-cx-turn-user"><div class="xhs-cx-bubble">' + escapeHtml(text) + '</div></div>';
  }

  /* —— 笔记卡片 —— */
  function noteCardHtml(n) {
    const cover = n.cover
      ? '<img class="xhs-cx-cover" loading="lazy" src="' + escapeHtml(n.cover) + '" onerror="this.remove()">'
      : "";
    const avatar = n.avatar
      ? '<div class="xhs-cx-avatar"><img src="' + escapeHtml(n.avatar) + '" onerror="this.style.display=\'none\'"><span>' + escapeHtml((n.author || "?").charAt(0)) + '</span></div>'
      : '<div class="xhs-cx-avatar">' + escapeHtml((n.author || "?").charAt(0)) + '</div>';
    const chips = (n.type === "video" ? '<span class="xhs-cx-chip">▶ 视频</span> ' : "") +
      (n.timeText ? '<span class="xhs-cx-chip">' + escapeHtml(n.timeText) + '</span>' : "");
    const tags = (n.tags || []).slice(0, 5).map((t) => '<span class="xhs-cx-tag">#' + escapeHtml(t) + '</span>').join("");
    const images = (n.images || []).length
      ? '<div class="xhs-cx-images">' + n.images.map((u) =>
          '<img loading="lazy" src="' + escapeHtml(u) + '" onerror="this.remove()">').join("") + '</div>'
      : "";
    return '<a class="xhs-cx-card" data-nav="' + escapeHtml(n.url) + '" data-id="' + escapeHtml(n.id) + '">' +
      '<div class="xhs-cx-card-hd">' + avatar + '<span class="xhs-cx-card-author">' + escapeHtml(n.author || "未知作者") + '</span>' + chips + '</div>' +
      '<div class="xhs-cx-card-title">' + escapeHtml(n.title || "（无标题）") + '</div>' +
      (n.desc ? '<div class="xhs-cx-card-body">' +
          '<div class="xhs-cx-card-desc">' + escapeHtml(short(n.desc, 120)) + '<span class="xhs-readmore"> 展开 →</span></div>' + cover +
        '</div>' : (cover ? '<div class="xhs-cx-card-body"><div class="xhs-cx-card-desc"></div>' + cover + '</div>' : "")) +
      (tags ? '<div>' + tags + '</div>' : "") +
      images +
      '<div class="xhs-cx-card-meta">' +
        '<span>赞 <b>' + escapeHtml(n.likes || "0") + '</b></span>' +
        '<span>评论 <b>' + escapeHtml(n.comments || "0") + '</b></span>' +
        '<span>收藏 <b>' + escapeHtml(n.collects || "0") + '</b></span>' +
        (n.shares ? '<span>分享 <b>' + escapeHtml(n.shares) + '</b></span>' : "") +
      '</div>' +
      '<div class="xhs-open">打开笔记 →</div>' +
    '</a>';
  }

  /* —— 详情页笔记卡片（完整正文 + 全部图片 + 标签） —— */
  function detailCardHtml(n) {
    const avatar = n.avatar
      ? '<div class="xhs-cx-avatar"><img src="' + escapeHtml(n.avatar) + '" onerror="this.remove()"></div>'
      : '<div class="xhs-cx-avatar">' + escapeHtml((n.author || "?").charAt(0)) + '</div>';
    const chips = (n.video ? '<span class="xhs-cx-chip">▶ 视频</span> ' : "") +
      (n.timeText ? '<span class="xhs-cx-chip">' + escapeHtml(n.timeText) + '</span>' : "");
    const tags = (n.tags || []).map((t) => '<span class="xhs-cx-tag">#' + escapeHtml(t) + '</span>').join("");
    const gallery = (n.images || []).length
      ? '<div class="xhs-cx-images">' + n.images.map((u) =>
          '<img loading="lazy" src="' + escapeHtml(u) + '" data-lb="' + escapeHtml(u) + '" onerror="this.remove()">').join("") + '</div>'
      : "";
    return '<div class="xhs-cx-detail">' +
      '<div class="xhs-cx-card-hd">' + avatar + '<span class="xhs-cx-card-author">' + escapeHtml(n.author || "未知作者") + '</span>' + chips + '</div>' +
      '<div class="xhs-cx-card-title">' + escapeHtml(n.title || "（无标题）") + '</div>' +
      (n.desc ? '<div class="xhs-cx-desc">' + escapeHtml(n.desc) + '</div>' : "") +
      (tags ? '<div style="margin-top:10px">' + tags + '</div>' : "") +
      gallery +
      '<div class="xhs-cx-card-meta">' +
        '<span>赞 <b>' + escapeHtml(n.likes || "0") + '</b></span>' +
        '<span>评论 <b>' + escapeHtml(n.comments || "0") + '</b></span>' +
        '<span>收藏 <b>' + escapeHtml(n.collects || "0") + '</b></span>' +
        (n.shares ? '<span>分享 <b>' + escapeHtml(n.shares) + '</b></span>' : "") +
      '</div>' +
    '</div>';
  }
  /* —— 评论条目（楼中楼递归缩进） —— */
  function commentHtml(c, depth) {
    const avatar = c.avatar
      ? '<div class="xhs-cx-avatar"><img src="' + escapeHtml(c.avatar) + '" onerror="this.remove()"></div>'
      : '<div class="xhs-cx-avatar">' + escapeHtml((c.nickname || "?").charAt(0)) + '</div>';
    const subs = (c.sub || []).map((s) => commentHtml(s, depth + 1)).join("");
    return '<div class="xhs-cx-cmt" style="margin-left:' + Math.min(depth * 20, 60) + 'px">' +
      avatar +
      '<div class="xhs-cx-cmt-body">' +
        '<div class="xhs-cx-cmt-hd">' + escapeHtml(c.nickname || "匿名用户") +
          (c.createTime ? ' · ' + escapeHtml(c.createTime) : "") + '</div>' +
        '<div class="xhs-cx-cmt-content">' + escapeHtml(c.content || "") + '</div>' +
        '<div class="xhs-cx-cmt-meta">' + (c.likeCount && c.likeCount !== "0" ? '赞 ' + escapeHtml(c.likeCount) : "") + '</div>' +
        subs +
      '</div>' +
    '</div>';
  }

  /* —— 各路由渲染 —— */
  function renderFeed(notes, subtitle) {
    flowEl.appendChild(elFrom(userTurn(subtitle || "fetch(\"/explore\")")));
    flowEl.appendChild(elFrom(thinkHtml("feed-" + routeSig(), "推荐流")));
    flowEl.appendChild(elFrom(toolLine("browse_feed", '{ page: 1, size: ' + Math.min(notes.length, 30) + ' }')));
    if (!notes.length) {
      flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>没有解析到笔记数据。<br><span class="xhs-dim">可能未登录或页面结构已变更，可尝试刷新。</span></div>'));
      return;
    }
    flowEl.appendChild(elFrom('<div class="xhs-cx-result">返回 ' + notes.length + ' 条笔记，已按热度排序并去重。' +
      (isLoggedIn() && !hasAnyToken(notes)
        ? '<br><span style="color:#e0a45c">⚠ 已登录但未获取到 xsec_token，笔记详情可能仍无法打开（建议刷新页面）。</span>'
        : "") +
      (!isLoggedIn()
        ? '<br><span style="color:#e0a45c">⚠ 未登录：笔记详情会被小红书拦截（error 300031），请先在左下角登录。</span>'
        : "") +
      '</div>'));
    const list = notes.slice(0, 30);
    list.forEach((n) => {
      if (traceOn(n.id)) flowEl.appendChild(elFrom(thinkHtml(n.id, n.title)));
      flowEl.appendChild(elFrom(toolLine("search_notes", '{ query: "' + short(n.title, 14) + '", limit: 1 }')));
      flowEl.appendChild(elFrom(noteCardHtml(n)));
    });
    flowEl.appendChild(elFrom('<div class="xhs-cx-fin">完成 · ' + list.length + ' 条 · ' + (Math.random() * 1.5 + 0.8).toFixed(1) + 's</div>'));
  }
  function renderDetail(note, comments, commentCount, hasMore) {
    const id = note ? note.id : (currentRoute().id || "");
    flowEl.appendChild(elFrom(userTurn("read(\"" + location.pathname + location.search + "\")")));
    flowEl.appendChild(elFrom(thinkHtml("detail-" + id, note ? note.title : "笔记")));
    flowEl.appendChild(elFrom(toolLine("fetch_note", '{ id: "' + id + '", with_images: true }')));
    flowEl.appendChild(elFrom(toolLine("summarize_note", '{ id: "' + id + '", lang: "zh" }')));
    if (!note) {
      flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>没有解析到笔记内容。<br><span class="xhs-dim">可能未登录、链接已失效或页面结构已变更。</span></div>'));
      return;
    }
    flowEl.appendChild(elFrom(detailCardHtml(note)));
    flowEl.appendChild(elFrom(toolLine("fetch_comments", '{ id: "' + id + '", limit: 1000 }')));
    const loadedCount = countCommentTree(comments);
    const totalTxt = (commentCount || loadedCount) + ' 条';
    const loginHint = isLoggedIn() ? '' : '（未登录仅显示部分评论，登录后可查看全部）';
    flowEl.appendChild(elFrom('<div class="xhs-cx-result">评论 ' + totalTxt +
      (loadedCount ? '（当前页面已加载 ' + loadedCount + ' 条' + (hasMore ? '，原生页还有更多' : '，已全部加载') + '）' : '') +
      (loginHint || '') + '</div>'));
    if (!comments.length) {
      flowEl.appendChild(elFrom('<div class="xhs-cx-empty" style="padding:24px 20px">暂无评论' + (hasMore ? '，可手动请求下一批。' : '') + '。</div>'));
    } else {
      const box = elFrom('<div class="xhs-cx-cmts"></div>');
      comments.forEach((c) => box.appendChild(elFrom(commentHtml(c, 0))));
      flowEl.appendChild(box);
    }
    const loadMore = hasMore
      ? '<button class="xhs-cx-backlink" data-comment-load="' + escapeHtml(id) + '">加载下一批评论</button>' : '';
    flowEl.appendChild(elFrom('<div class="xhs-cx-fin">笔记阅读完毕 · ' + (note.images.length || 0) + ' 张图片 · ' + (note.desc ? note.desc.length : 0) + ' 字 · 评论 ' + totalTxt + ' · ' +
      (hasMore ? '还有评论未加载（每次只请求一批，间隔 3 秒）' : '仅展示当前已加载内容') +
      (loadMore ? '<span style="display:block;margin-top:12px">' + loadMore + '</span>' : '') +
      '</div>'));
  }
  function renderSearch(notes, kw) {
    flowEl.appendChild(elFrom(userTurn('search("' + (kw || "") + '")')));
    flowEl.appendChild(elFrom(thinkHtml("search-" + kw, kw || "搜索")));
    flowEl.appendChild(elFrom(toolLine("search_notes", '{ query: "' + short(kw, 14) + '", engine: "xiaohongshu" }')));
    if (!notes.length) {
      flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>没有解析到搜索结果。</div>'));
      return;
    }
    flowEl.appendChild(elFrom('<div class="xhs-cx-result">命中 ' + notes.length + ' 条笔记。</div>'));
    notes.slice(0, 30).forEach((n) => {
      if (traceOn(n.id)) flowEl.appendChild(elFrom(thinkHtml(n.id, n.title)));
      flowEl.appendChild(elFrom(noteCardHtml(n)));
    });
    flowEl.appendChild(elFrom('<div class="xhs-cx-fin">完成 · ' + Math.min(notes.length, 30) + ' 条</div>'));
  }
  function renderProfile(notes) {
    flowEl.appendChild(elFrom(userTurn("open_user_profile(\"" + location.pathname + "\")")));
    flowEl.appendChild(elFrom(toolLine("list_user_notes", '{ page: 1 }')));
    if (!notes.length) {
      flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>没有解析到该用户的笔记。</div>'));
      return;
    }
    flowEl.appendChild(elFrom('<div class="xhs-cx-result">该用户发布 ' + notes.length + ' 篇笔记。</div>'));
    notes.slice(0, 30).forEach((n) => {
      if (traceOn(n.id)) flowEl.appendChild(elFrom(thinkHtml(n.id, n.title)));
      flowEl.appendChild(elFrom(noteCardHtml(n)));
    });
    flowEl.appendChild(elFrom('<div class="xhs-cx-fin">完成 · ' + Math.min(notes.length, 30) + ' 条</div>'));
  }
  function renderOther() {
    flowEl.appendChild(elFrom(userTurn("open(\"" + location.pathname + location.search + "\")")));
    if (/^\/404/.test(location.pathname)) {
      let rp = "", em = "";
      try {
        const sp = new URLSearchParams(location.search);
        // 小红的 404 可能把 redirectPath 放在顶层，也可能嵌在 source 参数里：
        //   /404?redirectPath=... 或 /404?source=/404/sec_xxx?redirectPath=...
        rp = sp.get("redirectPath") || "";
        if (!rp) {
          const src = sp.get("source") || "";
          const m = src.match(/[?&]redirectPath=([^&]+)/);
          if (m) rp = decodeURIComponent(m[1]);
        }
        em = sp.get("error_msg") || "";
      } catch { /* ignore */ }
      if (rp.indexOf("/discovery/item/") > -1 || rp.indexOf("/explore/") > -1) {
        flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>' +
          '笔记暂时无法浏览' + (em ? '（' + escapeHtml(em) + '）' : '（error 300031）') + '。<br>' +
          '<span class="xhs-dim">原因是缺少有效的 xsec_token：可能尚未登录、token 已过期（约 5 分钟），或该笔记已删除/仅粉丝可见。请回到首页刷新后重新进入。</span><br>' +
          '<span style="display:inline-flex;gap:10px;margin-top:12px">' +
          (isLoggedIn()
            ? '<a class="xhs-cx-backlink" data-nav="' + HOME + '/explore">← 返回首页刷新重试</a>'
            : '<button class="xhs-cx-backlink" data-open-login="1">去登录</button>' +
              '<a class="xhs-cx-backlink" style="background:transparent;border:1px solid var(--xhs-border);color:var(--xhs-muted)" data-nav="' + HOME + '/explore">返回首页</a>') +
          '</span></div>'));
        return;
      }
    }
    flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>当前页面不在伪装范围内（仅接管 feed / 笔记 / 搜索 / 主页）。<br><span class="xhs-dim">外壳与应急伪装键仍然可用。</span></div>'));
  }
  function renderWebsiteError(route) {
    const code = route.code ? '（error ' + escapeHtml(route.code) + '）' : '';
    let msg = route.msg || "评论接口或登录状态暂时失效";
    try { msg = decodeURIComponent(msg); } catch { /* ignore */ }
    const isRateLimited = route.code === "300013";
    const retry = route.redirect
      ? '<a class="xhs-cx-backlink" data-nav="' + escapeHtml(route.redirect) + '">重新打开原笔记</a>' : '';
    flowEl.appendChild(elFrom(userTurn("open(\"/website-login/error\")")));
    flowEl.appendChild(elFrom('<div class="xhs-cx-empty"><div>' + ICONS.file + '</div>' +
      '小红书临时跳转到了错误页' + code + '<br>' +
      '<span class="xhs-dim">' + escapeHtml(msg) + (isRateLimited
        ? '。为防止继续触发限流，脚本已停止后台评论加载。请等待至少 60 秒后，从首页重新进入笔记。'
        : '。通常是评论分页令牌过期或登录状态变化。') + '</span><br>' +
      '<span style="display:inline-flex;gap:10px;margin-top:12px;flex-wrap:wrap">' +
      retry +
      '<a class="xhs-cx-backlink" style="background:transparent;border:1px solid var(--xhs-border);color:var(--xhs-muted)" data-nav="' + HOME + '/explore">返回首页刷新</a>' +
      (!isLoggedIn() ? '<button class="xhs-cx-backlink" data-open-login="1">重新登录</button>' : '') +
      '</span></div>'));
  }
  function elFrom(html) {
    const t = document.createElement("div");
    t.innerHTML = html;
    return t.firstElementChild || t;
  }

  /* —— 顶栏面包屑 / 状态 —— */
  function renderChrome() {
    const r = currentRoute();
    const crumb = document.getElementById("xhs-cx-crumb");
    if (crumb) {
      const map = {
        feed: "~ /explore — 推荐流",
        detail: "~ /discovery/item/" + (r.id || "") + " — 笔记详情",
        search: "~ /search_result?keyword=" + (r.kw || "") + " — 搜索",
        profile: "~ /user/profile — 用户主页",
        error: "~ /website-login/error — 页面恢复",
        other: "~ " + location.pathname
      };
      crumb.innerHTML = '~/workspace <b>·</b> ' + escapeHtml(map[r.kind] || map.other);
    }
    const status = document.getElementById("xhs-cx-status");
    if (status) status.textContent = "agent 就绪" + (isLoggedIn() ? " · 已登录" : " · 未登录") +
      " · " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  /* —— 左侧会话列表 —— */
  function renderSessions(notes) {
    sessionsEl.innerHTML = "";
    const list = (notes.length ? notes : []).slice(0, 10);
    if (!list.length) {
      const d = document.createElement("div");
      d.className = "xhs-cx-session";
      d.innerHTML = ICONS.file + "<span>暂无会话</span>";
      sessionsEl.appendChild(d);
      return;
    }
    list.forEach((n, i) => {
      const s = document.createElement("div");
      s.className = "xhs-cx-session" + (i === 0 ? " on" : "");
      s.innerHTML = ICONS.file + "<span>" + escapeHtml(short("分析「" + (n.title || "笔记") + "」", 22)) + "</span>";
      s.addEventListener("click", () => {
        sessionsEl.querySelectorAll(".xhs-cx-session").forEach((x) => x.classList.remove("on"));
        s.classList.add("on");
        const qid = (window.CSS && CSS.escape) ? CSS.escape(n.id) : n.id;
        const card = flowEl.querySelector('.xhs-cx-card[data-id="' + qid + '"]');
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.style.outline = "2px solid var(--xhs-accent)";
          setTimeout(() => { card.style.outline = ""; }, 1400);
        }
      });
      sessionsEl.appendChild(s);
    });
  }

  /* —— 右侧代码面板 —— */
  function panelSource(notes) {
    const L = [];
    L.push("// feed.ts — 内容实时取自当前页面（仅装饰）");
    L.push("interface Note {");
    L.push("  id: string;");
    L.push("  title: string;");
    L.push("  author: string;");
    L.push("  likes: string;");
    L.push("  comments: string;");
    L.push("  collected: string;");
    L.push("}");
    L.push("");
    L.push("const notes: Note[] = [");
    notes.slice(0, 12).forEach((n) => {
      L.push('  { id: "' + n.id + '", title: "' + short(n.title, 20).replace(/"/g, '\\"') + '", author: "' + short(n.author, 8).replace(/"/g, '\\"') + '", likes: "' + (n.likes || "0") + '", comments: "' + (n.comments || "0") + '", collected: "' + (n.collects || "0") + '" },');
    });
    L.push("];");
    L.push("");
    L.push("function heat(n: Note): number {");
    L.push("  const toNum = (s: string) => parseFloat(s.replace(\"万\", \"e4\")) || 0;");
    L.push("  return toNum(n.likes) * 1 + toNum(n.comments) * 3 + toNum(n.collected) * 2;");
    L.push("}");
    L.push("");
    L.push("export function rankByHeat(list: Note[]): Note[] {");
    L.push("  return [...list].sort((a, b) => heat(b) - heat(a));");
    L.push("}");
    L.push("");
    L.push("export function extractKeywords(n: Note): string[] {");
    L.push("  // TODO: 接入语义检索后替换为真实关键词");
    L.push("  return n.title.split(/[，。、\\s]+/).filter(Boolean).slice(0, 3);");
    L.push("}");
    return L.join("\n");
  }
  function highlight(code) {
    return escapeHtml(code)
      .replace(/(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(const|function|return|interface|type|export|import|from|async|await|if|else|for|of|new|let|string|number|boolean)\b|\b(\d[\d_]*\.?\d*(?:e\d+)?)\b/gm,
        (m, com, str, kw, num) => com ? '<span class="hl-com">' + com + '</span>'
          : str ? '<span class="hl-str">' + str + '</span>'
          : kw ? '<span class="hl-kw">' + kw + '</span>'
          : num ? '<span class="hl-num">' + num + '</span>' : m);
  }
  function renderPanel(notes) {
    if (!panelBodyEl) return;
    const route = currentRoute();
    const pre = panelBodyEl.querySelector("pre");
    pre.innerHTML = highlight(panelSource(notes));
    const fname = document.getElementById("xhs-cx-panel-fname");
    if (fname) fname.textContent = route.kind === "detail" ? "note-detail.ts — " + (notes[0] ? notes[0].id : "?") : "feed.ts — 小红书店";
    const status = document.getElementById("xhs-cx-panel-status");
    if (status) status.textContent = "TypeScript · UTF-8 · Ln " + pre.innerHTML.split("<br>").length + " · " + notes.length + " items";
  }

  /* —— 主渲染入口 —— */
  let lastSig = "";
  let lastRenderedTokCount = 0; // 上次渲染结果里带 xsec_token 的笔记数（用于数据到达后重渲）
  function render() {
    if (paused || !rootEl) return;
    const bootBox = rootEl.querySelector("#xhs-cx-boot-box");
    if (bootBox) bootBox.remove();
    document.documentElement.classList.remove("xhs-cx-boot");
    applyTitle();
    const { route, notes, detail, comments, commentCount, hasMore } = pageData();
    // 详情页切「覆盖层模式」：原生页保留布局可真实滚动（评论懒加载依赖），Codex 不透明覆盖
    document.documentElement.classList.toggle("xhs-cx-overlay", route.kind === "detail");
    if (route.kind === "detail") {
      // 覆盖层模式下原生视频不可见，暂停避免后台无声播放
      try { document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch { /* ignore */ } }); } catch { /* ignore */ }
    }
    // 登录页：二维码/表单被伪装盖住就无法登录 → 自动露出原生页（只自动暂停一次），
    // 登录成功后心跳自动恢复并跳回 redirectPath
    if (!isLoginPage()) loginAutoPaused = false;
    if (route.kind === "other" && isLoginPage() && !paused && !loginAutoPaused) {
      loginAutoPaused = true;
      nativeLoginMode = true;
      setPaused(true);
      toast("请在原生页面完成扫码登录，成功后会自动恢复伪装");
      return;
    }
    lastRenderedTokCount = notes.filter((n) => /[?&]xsec_token=/.test(n.url)).length;
    renderChrome();
    renderSessions(notes);
    renderPanel(notes);
    updateLoginUI();
    flowEl.innerHTML = "";
    if (route.kind === "detail") { stopCommentPump(); renderDetail(detail, comments, commentCount, hasMore); }
    else { stopCommentPump(); if (route.kind === "search") renderSearch(notes, route.kw);
      else if (route.kind === "profile") renderProfile(notes);
      else if (route.kind === "feed") renderFeed(notes);
      else if (route.kind === "error") renderWebsiteError(route);
      else renderOther(); }
    lastSig = routeSig();
    if (scrollEl) scrollEl.scrollTop = 0;
    started = true;
  }
  let renderTimer = null;
  function scheduleRender() {
    if (paused) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      const sig = routeSig();
      if (!started || sig !== lastSig) render();
    }, 180);
  }

  /* ============================== 应急伪装（boss） ============================== */
  const BOSS_FILES = [
    "src/App.tsx", "src/api/notes.ts", "src/hooks/useFeed.ts", "components/NoteCard.tsx",
    "lib/utils.ts", "tsconfig.json", "package.json"
  ];
  const BOSS_EDITOR = [
    '// src/api/notes.ts',
    'import { Note } from "../types";',
    '',
    'export async function fetchFeed(): Promise<Note[]> {',
    '  const res = await fetch("/api/feed?tab=recommend");',
    '  if (!res.ok) throw new Error(`HTTP ${res.status}`);',
    '  const json = await res.json();',
    '  return json.data.map((n: any) => normalize(n));',
    '}',
    '',
    'export function normalize(raw: any): Note {',
    '  return {',
    '    id: String(raw.noteId ?? raw.id),',
    '    title: raw.displayTitle ?? "",',
    '    author: raw.user?.nickname ?? "",',
    '    likes: formatCount(raw.interactInfo?.likedCount),',
    '  };',
    '}',
    '',
    'export const HEAT_WEIGHTS = { like: 1, comment: 3, collect: 2 };',
    '',
    '// 与 feed.ts 中的 rankByHeat 保持一致的排序逻辑',
    'export function sortByHeat(notes: Note[]): Note[] {',
    '  return [...notes].sort((a, b) => heat(b) - heat(a));',
    '}',
  ].join("\n");
  const BOSS_LOG = [
    '$ codex run build --mode production',
    '> tsc --noEmit -p tsconfig.json',
    '> vite build --mode production',
    'transforming...',
    '✓ 312 modules transformed.',
    'rendering chunks...',
    'computing gzip sizes...',
    'dist/index-1a2b3c4d.js   128.4 kB │ gzip: 41.2 kB',
    'dist/index.css           52.1 kB  │ gzip: 12.9 kB',
    '✓ built in 2.34s',
    '',
    '$ git status',
    'On branch main',
    'Your branch is up to date with \'origin/main\'.',
    'nothing to commit, working tree clean',
    '',
    '$ npm test',
    '> jest --runInBand',
    ' PASS  src/__tests__/notes.spec.ts',
    ' PASS  src/__tests__/auth.spec.ts',
    'Test Suites: 2 passed, 2 total',
    'Tests:       14 passed, 14 total',
    '✓ done in 1.86s',
    ''
  ];
  function buildBoss() {
    bossEl = document.getElementById(BOSS_ID);
    if (bossEl) return;
    bossEl = document.createElement("div");
    bossEl.id = BOSS_ID;
    bossEl.innerHTML =
      '<div class="xhs-boss-tree">' + BOSS_FILES.map((f, i) =>
        '<div class="xhs-boss-f' + (i === 0 ? " on" : "") + '">' + ICONS.file + '<span>' + escapeHtml(f) + '</span></div>').join("") + '</div>' +
      '<div class="xhs-boss-editor" id="xhs-cx-boss-editor"></div>' +
      '<div class="xhs-boss-log">' +
        '<div class="xhs-boss-log-hd xhs-mono">TERMINAL — zsh</div>' +
        '<div class="xhs-boss-log-bd xhs-mono" id="xhs-cx-boss-log"></div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(bossEl);
    const ed = bossEl.querySelector("#xhs-cx-boss-editor");
    ed.innerHTML = BOSS_EDITOR.split("\n").map((l) => escapeHtml(l)).join("\n");
    bossLogEl = bossEl.querySelector("#xhs-cx-boss-log");
  }
  function toggleBoss() {
    buildBoss();
    const on = !bossEl.classList.contains("on");
    bossEl.classList.toggle("on", on);
    if (on) startBossLog();
    else stopBossLog();
  }
  function startBossLog() {
    stopBossLog();
    bossIdx = 0;
    bossLogEl.textContent = "";
    bossTick = setInterval(() => {
      const line = BOSS_LOG[bossIdx % BOSS_LOG.length];
      bossIdx++;
      bossLogEl.textContent = (bossLogEl.textContent + "\n" + line).replace(/^\n/, "");
      const lines = bossLogEl.textContent.split("\n");
      if (lines.length > 40) bossLogEl.textContent = lines.slice(lines.length - 40).join("\n");
    }, 650);
  }
  function stopBossLog() {
    if (bossTick) { clearInterval(bossTick); bossTick = null; }
  }

  /* ============================== 图片灯箱 ============================== */
  let lightbox = null;
  function buildLightbox() {
    if (lightbox) return;
    lightbox = document.createElement("div");
    lightbox.id = "xhs-cx-lightbox";
    lightbox.innerHTML = '<img alt=""><div class="xhs-cx-lb-close">✕</div>';
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox || (e.target.classList && e.target.classList.contains("xhs-cx-lb-close"))) closeLightbox();
    });
    (document.body || document.documentElement).appendChild(lightbox);
  }
  function openLightbox(url) {
    buildLightbox();
    lightbox.querySelector("img").src = url;
    lightbox.classList.add("on");
  }
  function closeLightbox() {
    if (lightbox) lightbox.classList.remove("on");
  }

  /* ============================== 登录（内嵌同源 iframe） ==============================
   *
   * 小红书未登录时不下发有效的 xsec_token，所有笔记详情都会 404（error 300031），
   * 必须登录后才能看详情。伪装界面把原生 #app 藏起来了，用户没法点原生「登录」，
   * 所以这里开一个同源 iframe 加载小红书原生页面（脚本加了 @noframes，不会在
   * iframe 里再次伪装），用户在 iframe 里点右上角「登录」扫码即可。
   * 登录成功后 iframe 里的 __INITIAL_STATE__.user 会带上登录态，轮询到后自动刷新
   * 外层页面，让列表数据带上 token。
   */
  let loginModal = null, loginFrame = null, loginPoll = null;
  function buildLogin() {
    if (loginModal) return;
    loginModal = document.createElement("div");
    loginModal.id = "xhs-cx-login";
    loginModal.innerHTML =
      '<div class="xhs-cx-login-card">' +
        '<div class="xhs-cx-login-hd"><b>登录小红书</b><span class="xhs-cx-login-close" id="xhs-cx-login-close">✕</span></div>' +
        '<div class="xhs-cx-login-tip">在本窗口内完成授权，全程不离开伪装界面。<br>' +
          '<b>请点击内嵌页面右上角的「登录」按钮</b>，用小红书 App 扫码确认（或手机号验证码登录）。<br>' +
          '<span class="xhs-dim">若内嵌页面没有显示「登录」按钮（部分环境会被站点限制），请用下方按钮切到原生页面登录。</span></div>' +
        '<div class="xhs-cx-login-frame"><iframe id="xhs-cx-login-frame" src="' + HOME + '/explore"></iframe></div>' +
        '<div class="xhs-cx-login-status" id="xhs-cx-login-status">正在加载内嵌页面…</div>' +
        '<div class="xhs-cx-login-btns">' +
          '<button id="xhs-cx-login-native" class="xhs-cx-login-sec">内嵌页面无法登录？改用原生页面登录</button>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(loginModal);
    loginFrame = loginModal.querySelector("#xhs-cx-login-frame");
    loginModal.querySelector("#xhs-cx-login-close").addEventListener("click", closeLogin);
    loginModal.addEventListener("click", (e) => { if (e.target === loginModal) closeLogin(); });
    loginModal.querySelector("#xhs-cx-login-native").addEventListener("click", () => {
      closeLogin();
      nativeLoginMode = true;
      setPaused(true);
      toast("请在原生页面右上角完成登录，成功后会自动恢复伪装");
    });
    // 内嵌页加载完成后提示用户去哪里点登录
    loginFrame.addEventListener("load", () => {
      const st = loginModal.querySelector("#xhs-cx-login-status");
      if (st && st.textContent.indexOf("正在加载") > -1) {
        st.textContent = "内嵌页面已加载 ✓ 请点击右上角「登录」，用 App 扫码";
      }
    });
    // 内嵌页 6 秒还没加载完 → 提示改用原生登录兜底
    setTimeout(() => {
      const st = loginModal.querySelector("#xhs-cx-login-status");
      if (st && st.textContent.indexOf("正在加载") > -1) {
        st.classList.add("warn");
        st.textContent = "内嵌页面加载较慢。可稍等片刻，或用下方按钮切到原生页面登录。";
      }
    }, 6000);
  }
  function openLogin() {
    buildLogin();
    loginModal.classList.add("on");
    const st = loginModal.querySelector("#xhs-cx-login-status");
    st.classList.remove("warn");
    st.textContent = isLoggedIn() ? "检测到登录态，将前往首页刷新数据" : "正在加载内嵌页面…";
    startLoginPoll();
  }
  function closeLogin() {
    if (loginModal) loginModal.classList.remove("on");
    stopLoginPoll();
  }
  function startLoginPoll() {
    stopLoginPoll();
    loginPoll = setInterval(() => {
      let ok = isLoggedIn(); // localStorage 同源共享，iframe 登录成功后这里立刻能读到
      if (!ok) {
        try {
          const fw = loginFrame && loginFrame.contentWindow;
          if (fw) ok = detectLoginFromState(fw.__INITIAL_STATE__);
        } catch { /* ignore */ }
      }
      if (!ok) return;
      stopLoginPoll();
      const st = loginModal.querySelector("#xhs-cx-login-status");
      if (st) st.textContent = "登录成功 ✓ 正在进入首页…";
      toast("登录成功，正在进入首页刷新数据…");
      setTimeout(() => { location.href = HOME + "/explore"; }, 1200);
    }, 1000);
  }
  function stopLoginPoll() {
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
  }
  function updateLoginUI() {
    const btn = rootEl && rootEl.querySelector("#xhs-cx-login-btn");
    if (!btn) return;
    const on = isLoggedIn();
    btn.classList.toggle("on", on);
    btn.textContent = on ? "已登录 ✓" : "未登录 · 点击登录";
  }

  /* ============================== 设置面板 ============================== */
  function buildSettings() {
    settingsEl = document.getElementById(SETTINGS_ID);
    if (settingsEl) return;
    settingsEl = document.createElement("div");
    settingsEl.id = SETTINGS_ID;
    settingsEl.innerHTML =
      '<div class="xhs-cx-settings-card">' +
        '<h3>Codex 外观设置</h3>' +
        '<div class="xhs-cx-sc-sub">小红书 · 伪装脚本 v2.4.0 — 评论按需、受控加载</div>' +
        '<div class="xhs-cx-row"><label>主题</label><select id="s-theme">' +
          '<option value="dark">深色</option><option value="light">浅色</option><option value="auto">跟随系统</option></select></div>' +
        '<div class="xhs-cx-row"><label>伪装（Codex 品牌 / 标题 / 图标）</label><input type="checkbox" id="s-stealth"></div>' +
        '<div class="xhs-cx-row"><label>应急伪装键</label><select id="s-key">' +
          '<option value="esc2">双击 Esc</option><option value="f2">F2</option><option value="ctrl+shift+h">Ctrl+Shift+H</option></select></div>' +
        '<div class="xhs-cx-row"><label>项目名</label><input type="text" id="s-project"></div>' +
        '<div class="xhs-cx-row"><label>左侧栏宽度</label><span style="display:flex;align-items:center;gap:8px"><input type="range" id="s-rail" min="180" max="380" step="4"><span class="xhs-cx-val" id="s-rail-v"></span></span></div>' +
        '<div class="xhs-cx-row"><label>右侧代码面板</label><input type="checkbox" id="s-panel"></div>' +
        '<div class="xhs-cx-row"><label>代码面板宽度</label><span style="display:flex;align-items:center;gap:8px"><input type="range" id="s-panelw" min="280" max="640" step="10"><span class="xhs-cx-val" id="s-panelw-v"></span></span></div>' +
        '<div class="xhs-cx-row"><label>列表思考块比例</label><span style="display:flex;align-items:center;gap:8px"><input type="range" id="s-trace" min="0" max="100" step="5"><span class="xhs-cx-val" id="s-trace-v"></span></span></div>' +
        '<div class="xhs-cx-settings-btns">' +
          '<button id="s-reset">恢复默认</button>' +
          '<button id="s-close">关闭</button>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(settingsEl);

    const bind = (id, on) => { const el = settingsEl.querySelector(id); if (el) el.addEventListener("change", on); };
    bind("#s-theme", (e) => setCfg("theme", e.target.value));
    bind("#s-stealth", (e) => setCfg("stealth", e.target.checked));
    bind("#s-key", (e) => setCfg("stealthKey", e.target.value));
    bind("#s-project", (e) => setCfg("projectName", e.target.value || "platform"));
    bind("#s-panel", (e) => { setCfg("codePanel", e.target.checked); });
    bind("#s-rail", (e) => { document.getElementById("s-rail-v").textContent = e.target.value; setCfg("railWidth", Number(e.target.value), true); });
    bind("#s-panelw", (e) => { document.getElementById("s-panelw-v").textContent = e.target.value; setCfg("panelWidth", Number(e.target.value), true); });
    bind("#s-trace", (e) => { document.getElementById("s-trace-v").textContent = e.target.value + "%"; setCfg("listTraceRate", Number(e.target.value)); });
    settingsEl.querySelector("#s-reset").addEventListener("click", () => { settingsEl.classList.remove("on"); resetSettings(); });
    settingsEl.querySelector("#s-close").addEventListener("click", () => settingsEl.classList.remove("on"));
    settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) settingsEl.classList.remove("on"); });
  }
  function openSettings() {
    buildSettings();
    const set = (sel, val) => { const el = settingsEl.querySelector(sel); if (el) el.value = val; };
    set("#s-theme", cfg("theme"));
    settingsEl.querySelector("#s-stealth").checked = !!cfg("stealth");
    set("#s-key", cfg("stealthKey"));
    set("#s-project", cfg("projectName"));
    settingsEl.querySelector("#s-panel").checked = !!cfg("codePanel");
    set("#s-rail", cfg("railWidth")); document.getElementById("s-rail-v").textContent = cfg("railWidth");
    set("#s-panelw", cfg("panelWidth")); document.getElementById("s-panelw-v").textContent = cfg("panelWidth");
    set("#s-trace", cfg("listTraceRate")); document.getElementById("s-trace-v").textContent = cfg("listTraceRate") + "%";
    settingsEl.classList.add("on");
  }

  /* ============================== 暂停 / 恢复 ============================== */
  let pausePill = null;
  function showPausePill() {
    if (pausePill) return;
    pausePill = document.createElement("button");
    pausePill.id = "xhs-cx-pill";
    pausePill.textContent = nativeLoginMode ? "登录完成后点此恢复" : "恢复 Codex 伪装";
    pausePill.style.cssText =
      "position:fixed;right:18px;bottom:18px;z-index:2147483300;background:#10a37f;color:#04251c;" +
      "border:none;border-radius:999px;padding:10px 16px;font:650 13px -apple-system,system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);";
    pausePill.addEventListener("click", () => setPaused(false));
    (document.body || document.documentElement).appendChild(pausePill);
  }
  function hidePausePill() {
    if (pausePill) { pausePill.remove(); pausePill = null; }
  }
  function setPaused(v) {
    paused = v;
    document.documentElement.classList.toggle("xhs-cx", !v);
    if (rootEl) rootEl.style.display = v ? "none" : "";
    if (v) { restoreTitle(); restoreFavicon(); stopBossLog(); showPausePill(); }
    else { applyTitle(); applyFavicon(); render(); hidePausePill(); }
    toast(v ? "已暂停伪装，显示原页面" : "已恢复伪装");
  }

  /* ============================== 事件绑定 ============================== */
  function bindEvents() {
    document.addEventListener("click", (e) => {
      const lb = e.target.closest && e.target.closest("[data-lb]");
      if (lb) { openLightbox(lb.getAttribute("data-lb")); return; }
      const commentLoad = e.target.closest && e.target.closest("[data-comment-load]");
      if (commentLoad) {
        e.preventDefault();
        loadOneCommentBatch(commentLoad.getAttribute("data-comment-load") || "");
        return;
      }
      const lg = e.target.closest && e.target.closest("[data-open-login]");
      if (lg) { openLogin(); return; }
      const nav = e.target.closest && e.target.closest("[data-nav]");
      if (nav) {
        e.preventDefault();
        const url = nav.getAttribute("data-nav") || "";
        // 始终直接跳转对应笔记详情；未登录时不拦截（否则所有笔记都会卡在同一个登录弹窗），
        // 仅作非阻断提示。若未登录导致 404，详情页的兜底会给出「去登录」引导。
        const isNote = url.indexOf("/discovery/item/") > -1 || /\/explore\/[0-9a-zA-Z]+/.test(url);
        if (isNote && !isLoggedIn()) {
          toast("未登录，笔记详情可能被拦截（打不开时点左下角登录）");
        }
        location.href = url;
        return;
      }
      const tg = e.target.closest && e.target.closest("[data-toggle]");
      if (tg) { tg.classList.toggle("open"); return; }
    });

    const root = document.getElementById(ROOT_ID);
    root.addEventListener("click", (e) => {
      // 图标是 button 的子元素；点击 SVG/path 时事件目标没有 id，必须向上找按钮。
      const control = e.target && e.target.closest && e.target.closest("button[id]");
      const id = control && control.id;
      if (id === "xhs-cx-new") { if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: "smooth" }); }
      else if (id === "xhs-cx-back") { if (history.length > 1) history.back(); else location.href = HOME + "/explore"; }
      else if (id === "xhs-cx-refresh") { location.reload(); }
      else if (id === "xhs-cx-settings-btn") openSettings();
      else if (id === "xhs-cx-pause") setPaused(!paused);
      else if (id === "xhs-cx-login-btn") { if (!isLoggedIn()) openLogin(); }
      else if (id === "xhs-cx-send") doSearch();
    });

    const input = document.getElementById("xhs-cx-input");
    const send = document.getElementById("xhs-cx-send");
    const auto = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; send.disabled = !input.value.trim(); };
    input.addEventListener("input", auto);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSearch(); }
    });
    function doSearch() {
      const v = input.value.trim();
      if (!v) return;
      location.href = HOME + "/search_result?keyword=" + encodeURIComponent(v);
    }
  }
  function bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "H" || e.key === "h")) {
        e.preventDefault(); toggleBoss(); return;
      }
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "Escape") {
        // 图片灯箱打开时，Esc 先关灯箱，不触发应急伪装
        if (lightbox && lightbox.classList.contains("on")) { closeLightbox(); return; }
        if (loginModal && loginModal.classList.contains("on")) { closeLogin(); return; }
        if (cfg("stealthKey") === "esc2") {
          const now = Date.now();
          if (now - lastEscAt < 500) { lastEscAt = 0; toggleBoss(); }
          else lastEscAt = now;
        }
        return;
      }
      if (cfg("stealthKey") === "f2" && e.key === "F2") { toggleBoss(); return; }
      if (e.key === "/") {
        const input = document.getElementById("xhs-cx-input");
        if (input) { e.preventDefault(); input.focus(); }
      }
    });
  }

  /* ============================== SPA 路由监听 ============================== */
  function hookHistory() {
    const patch = (fn) => function () {
      const r = fn.apply(this, arguments);
      scheduleRender();
      return r;
    };
    try {
      history.pushState = patch(history.pushState);
      history.replaceState = patch(history.replaceState);
    } catch { /* ignore */ }
    window.addEventListener("popstate", scheduleRender);
    new MutationObserver(scheduleRender).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  /* ============================== 心跳（标题 / favicon / 数据到达重渲） ============================== */
  function startHeartbeat() {
    setInterval(() => {
      if (paused) {
        // 原生页面登录模式（或停在 /login）：登录成功（检测到登录态）后自动恢复伪装并跳回
        if ((nativeLoginMode || isLoginPage()) && isLoggedIn()) {
          nativeLoginMode = false;
          const rp = getRedirectPath();
          toast(rp ? "已检测到登录成功，正在恢复伪装并打开原笔记…" : "已检测到登录成功，正在恢复伪装并刷新首页…");
          setPaused(false);
          setTimeout(() => { location.href = rp || HOME + "/explore"; }, 600);
        }
        return;
      }
      applyTitle();
      applyFavicon();
      updateLoginUI();
      renderChrome();
      // 关键：xsec_token 是页面加载后接口才下发、并渲染进 DOM 的（state 常滞后）。
      // 若当前渲染结果还没有任何 token、而 DOM 里已经出现了带 token 的链接，强制重渲一次。
      if (lastRenderedTokCount === 0) {
        let domTok = 0;
        try { domTok = document.querySelectorAll('a[href*="xsec_token="]').length; } catch { /* ignore */ }
        if (domTok > 0) render();
      }
      if (!started) { scheduleRender(); }
    }, 1200);
  }

  /* ============================== 启动 ============================== */
  /* —— 评论分页捕获与后台加载（目标：展示全部评论） —— */
  /**
   * document-start 安装：接管 fetch / XHR，捕获小红书自己的评论分页响应。
   * 分页接口自带合法 X-S 签名，脚本不自己调接口，只旁观 SPA 的请求并把响应缓存进
   * window.__xhsCxComments[noteId] = { list, cursor, hasMore, totalCount }。
   * 接口响应形如 { code:0, data:{ comments:[{id,content,like_count,user_info:{nick_name,avatar},create_time,sub_comments}], cursor, has_more } }。
   */
  function installCommentCapture() {
    try {
      const cap = (window.__xhsCxComments && typeof window.__xhsCxComments === "object")
        ? window.__xhsCxComments : {};
      window.__xhsCxComments = cap;
      const grab = (txt, url, body) => {
        try {
          if (!txt) return;
          const j = JSON.parse(txt);
          const d = j && j.data;
          if (!d || !Array.isArray(d.comments)) return;
          const id = d.note_id || d.noteId ||
            (((url || "").match(/[?&]note_id=([^&]+)/) || [])[1] || "") ||
            (((body || "").match(/note_id[\"':=]+([0-9a-fA-F]+)/) || [])[1] || "");
          if (!id) return;
          let rec = cap[id] || (cap[id] = { list: [], cursor: "", hasMore: true, totalCount: 0 });
          if (d.total && Number(d.total) > 0) rec.totalCount = Number(d.total);
          for (const c of d.comments) {
            if (c && c.id && !rec.list.some((x) => x && x.id === c.id)) rec.list.push(c);
          }
          rec.cursor = d.cursor || rec.cursor;
          rec.hasMore = d.has_more !== false;
        } catch { /* ignore */ }
      };
      const isCommentUrl = (u) => !!u && u.indexOf("comment") > -1;
      // fetch
      const of = window.fetch;
      if (typeof of === "function") {
        window.fetch = function (input, init) {
          const p = of.apply(this, arguments);
          try {
            const url = typeof input === "string" ? input : (input && (input.url || "")) || "";
            if (isCommentUrl(url)) {
              let bd = "";
              try { bd = typeof (init && init.body) === "string" ? init.body : ""; } catch { /* ignore */ }
              p.then((res) => {
                try { res.clone().text().then((t) => grab(t, url, bd)); } catch { /* ignore */ }
              }).catch(() => {});
            }
          } catch { /* ignore */ }
          return p;
        };
      }
      // XHR
      const OX = window.XMLHttpRequest;
      if (OX) {
        const oOpen = OX.prototype.open, oSend = OX.prototype.send;
        OX.prototype.open = function (m, u) { this.__xhsUrl = String(u || ""); return oOpen.apply(this, arguments); };
        OX.prototype.send = function (body) {
          try {
            if (isCommentUrl(this.__xhsUrl || "")) {
              const self = this;
              this.addEventListener("load", () => { try { grab(self.responseText, self.__xhsUrl || "", body); } catch { /* ignore */ } });
            }
          } catch { /* ignore */ }
          return oSend.apply(this, arguments);
        };
      }
    } catch { /* ignore */ }
  }
  let pumpTimer = null, pumpNoteId = "";
  function stopCommentPump() {
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  }
  /**
   * 用户主动请求一批评论。只滚动一次原生评论容器，不点击“展开回复”、不循环、
   * 不直接请求私有接口；这样由站点决定是否分页，并避免 300013 访问频繁。
   */
  let lastManualCommentLoad = 0;
  function loadOneCommentBatch(noteId) {
    if (!noteId) return;
    const now = Date.now();
    const wait = 3000 - (now - lastManualCommentLoad);
    if (wait > 0) {
      toast("请在 " + Math.ceil(wait / 1000) + " 秒后再加载下一批评论");
      return;
    }
    lastManualCommentLoad = now;
    pumpNoteId = noteId;
    try {
      const nc = document.querySelector("#noteContainer");
      const inner = nc && nc.querySelector(".note-scroller");
      const scroller = inner && inner.scrollHeight > inner.clientHeight ? inner : nc;
      if (!scroller) { toast("原生评论区尚未准备好，请稍后重试"); return; }
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = target;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      toast("已请求一批评论，正在等待小红书页面返回…");
    } catch { toast("无法滚动原生评论区，请刷新笔记后重试"); return; }
    // 只在本次用户操作后读一次结果；不会继续触发分页。
    stopCommentPump();
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      try {
        const sc = scrollEl, sp = sc ? sc.scrollTop : 0;
        render();
        if (sc) sc.scrollTop = sp;
      } catch { /* ignore */ }
    }, 2200);
  }

  function bootstrap() {
    if (document.getElementById(ROOT_ID)) return; // 防重复注入
    // 只旁观原生评论接口以汇总已加载结果；不自行请求接口或伪造签名。
    installCommentCapture();
    document.documentElement.classList.add("xhs-cx", "xhs-cx-boot");
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    buildAppShell();
    buildBoss();
    buildLightbox();
    buildLogin();
    bindEvents();
    bindKeys();
    hookHistory();

    // toast
    toasts = document.createElement("div");
    toasts.id = "xhs-cx-toast";
    (document.body || document.documentElement).appendChild(toasts);

    // 首次渲染
    applyVisual();
    const tryRender = () => {
      const d = pageData();
      if (d.notes.length || d.route.kind === "other" || d.route.kind === "error") { render(); return true; }
      return false;
    };
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (tryRender() || tries > 30) { clearInterval(iv); }
    }, 250);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { ready = true; scheduleRender(); }, { once: true });
    } else { ready = true; scheduleRender(); }

    startHeartbeat();
  }

  if (document.readyState === "loading") {
    bootstrap(); // document-start 立即注入，避免闪原生页面
  } else {
    bootstrap();
  }
})();
