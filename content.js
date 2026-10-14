(function () {
  if (window.__xh6ContentLoaded) return;
  window.__xh6ContentLoaded = true;

  const userStore = new Map(); // id -> user
  // 双重白名单：同时存 id 和 小写 screen_name，并保存完整用户快照，清空列表时绝不丢失！
  let wlKeys = new Set(); 
  let wlProfiles = new Map(); // id -> user snapshot
  let isRunning = false;
  let stopRequested = false;
  let listMode = "following";
  let storageReady = false;
  let searchKeyword = "";
  let viewMode = "unmutual"; // "unmutual" | "all" | "whitelist"

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 判断某个用户是否在白名单中（只要 ID 或 @用户名 任一命中即算白名单！）
  function isUserWhitelisted(u) {
    if (!u) return false;
    const idStr = String(u.id || "");
    const handleStr = String(u.screen_name || "").toLowerCase();
    return (idStr && wlKeys.has(idStr)) || (handleStr && wlKeys.has(handleStr));
  }

  // 初始化读取所有历史版本的白名单数据，确保老数据 100% 继承不丢失
  chrome.storage.local.get(
    ["whitelist", "xh_whitelist_v3", "xh4_whitelist", "xh5_whitelist", "xh6_whitelist", "xh6_wl_profiles", "xh7_migrated"],
    (res) => {
      const mergeArr = (arr) => {
        if (Array.isArray(arr)) {
          arr.forEach((item) => {
            if (item) wlKeys.add(String(item).trim().toLowerCase());
          });
        }
      };
      if (!res.xh7_migrated) {
      mergeArr(res.xh_whitelist_v3);
      mergeArr(res.xh4_whitelist);
      mergeArr(res.xh5_whitelist);
      mergeArr(res.xh6_whitelist);
      if (typeof res.whitelist === "string") {
        res.whitelist.split(/[\n,，\s]+/).forEach((s) => {
          const clean = s.trim().replace(/^@/, "").toLowerCase();
          if (clean) wlKeys.add(clean);
        });
      } else {
        mergeArr(res.whitelist);
      }

      }
      mergeArr(res.xh6_whitelist);
      if (Array.isArray(res.xh6_wl_profiles)) {
        res.xh6_wl_profiles.forEach((p) => {
          if (p && p.id) {
            wlProfiles.set(String(p.id), p);
            wlKeys.add(String(p.id));
            if (p.screen_name) wlKeys.add(String(p.screen_name).toLowerCase());
          }
        });
      }
      storageReady = true;
      saveWhitelistToStorage();
      updateUI();
    }
  );

  function saveWhitelistToStorage() {
    chrome.storage.local.set({
      xh7_migrated: true,
      xh6_whitelist: Array.from(wlKeys),
      xh6_wl_profiles: Array.from(wlProfiles.values())
    });
  }

  // 加入或移出白名单（同时操作 ID 和 @用户名）
  function toggleUserWhitelist(u) {
    if (!u) return;
    const idStr = String(u.id);
    const handleStr = String(u.screen_name || "").toLowerCase();

    if (isUserWhitelisted(u)) {
      wlKeys.delete(idStr);
      if (handleStr) wlKeys.delete(handleStr);
      wlProfiles.delete(idStr);
      u.selected = false;
    } else {
      wlKeys.add(idStr);
      if (handleStr) wlKeys.add(handleStr);
      u.selected = false; // 加入白名单后强制取消勾选
      wlProfiles.set(idStr, {
        id: idStr,
        screen_name: u.screen_name,
        name: u.name,
        avatar: u.avatar,
        followed_by: u.followed_by,
        verified: u.verified,
        bio: u.bio,
        selected: false
      });
    }
    saveWhitelistToStorage();
    updateUI();
  }

  function shouldAutoSelect(u) {
    if (u.followed_by !== false) return false;
    if (isUserWhitelisted(u)) return false;
    const skipV = document.getElementById("xh6-skip-v")?.checked ?? true;
    if (skipV && u.verified) return false;
    return true;
  }

  function upsertUser(u) {
    if (!u || !u.id) return false;
    const id = String(u.id);

    // 如果命中白名单，顺便把完整资料同步更新到白名单快照库里
    if (isUserWhitelisted(u)) {
      wlKeys.add(id);
      if (u.screen_name) wlKeys.add(u.screen_name.toLowerCase());
      wlProfiles.set(id, {
        id,
        screen_name: u.screen_name,
        name: u.name || u.screen_name,
        avatar: u.avatar || "",
        followed_by: u.followed_by,
        verified: Boolean(u.verified),
        bio: u.bio || "",
        selected: false
      });
      saveWhitelistToStorage();
    }

    if (userStore.has(id)) {
      const old = userStore.get(id);
      if (typeof u.followed_by === "boolean") old.followed_by = u.followed_by;
      if (typeof u.following === "boolean") old.following = u.following;
      if (u.verified) old.verified = true;

      if (!old.bio && u.bio) old.bio = u.bio;
      // 更新关系不改变用户手动选择；取关资格独立计算。
      return false;
    }

    const userObj = {
      id,
      screen_name: u.screen_name,
      name: u.name || u.screen_name,
      avatar: u.avatar || "",
      followed_by: u.followed_by,
      following: u.following,
      verified: Boolean(u.verified),
      bio: u.bio || "",
      selected: false
    };
    userObj.selected = false;
    userStore.set(id, userObj);
    return true;
  }

  // 清空普通列表缓存，但 100% 保留白名单数据！
  function clearNormalListKeepWhitelist() {
    userStore.clear();
    // 把永久保存的白名单用户恢复展示在列表中，方便随时看到
    wlProfiles.forEach((p, id) => {
      userStore.set(id, { ...p, selected: false });
    });
    updateUI();
  }

  function scanInitialDOM() {
    if (listMode !== "following" || !location.pathname.endsWith("/following")) return;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return;
    const cells = primary.querySelectorAll('[data-testid="UserCell"]');
    let added = 0;

    cells.forEach((cell) => {
      const btn = cell.querySelector('[data-testid$="-unfollow"]');
      if (!btn) return;
      const m = (btn.getAttribute("data-testid") || "").match(/^(\d+)-unfollow$/);
      if (!m) return;
      const id = m[1];

      let screen_name = id;
      for (const a of cell.querySelectorAll('a[href^="/"]')) {
        const href = a.getAttribute("href") || "";
        if (/^\/[a-zA-Z0-9_]{1,20}$/.test(href)) {
          screen_name = href.slice(1);
          break;
        }
      }

      const text = cell.innerText || "";
      const followed_by = (
        cell.querySelector('[data-testid="userFollowIndicator"]') ||
        /Follows you|关注了你|跟隨你|フォローされています/i.test(text)
      ) ? true : null;
      const verified = Boolean(
        cell.querySelector('[data-testid="icon-verified"]') ||
        cell.querySelector('svg[aria-label*="Verified"]') ||
        cell.querySelector('svg[aria-label*="认证"]')
      );
      const img = cell.querySelector("img");
      const name = (text.split("\n")[0] || screen_name).trim();

      if (upsertUser({ id, screen_name, name, avatar: img ? img.src : "", followed_by, verified, bio: "" })) {
        added++;
      }
    });

    if (added > 0) updateUI();
  }

  const pending = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    const data = e.data;
    if (data.type === "XH6_PAGE_DATA" && data.mode === listMode && location.pathname.endsWith("/" + listMode)) {
      (data.users || []).forEach(upsertUser); updateUI();
    }
    const item = pending.get(data.requestId);
    if (!item || !item.types.includes(data.type)) return;
    if (item.userId && String(data.userId) !== item.userId) return;
    clearTimeout(item.timer); pending.delete(data.requestId);
    item.resolve({ ok: data.type !== "XH6_CURSOR_ERROR", ...data });
  });
  function request(type, payload, types) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok:false, error:"TIMEOUT" }); }, 15000);
      pending.set(requestId, { resolve, timer, types, userId: payload.userId });
      window.postMessage({ type, requestId, ...payload }, location.origin);
    });
  }
  function fetchNextPageByCursor(cursor) {
    return request("XH6_FETCH_NEXT_CURSOR", { cursor, mode:listMode }, ["XH6_CURSOR_RESULT", "XH6_CURSOR_ERROR"]);
  }
  function directUnfollowById(userId, screenName) {
    return request("XH6_DIRECT_UNFOLLOW", { userId:String(userId), screenName, action:"unfollow" }, ["XH6_UNFOLLOW_DONE"]);
  }

  function initUI() {
    const style = document.createElement("style");
    style.textContent = `
      #xh6-fab { position:fixed; bottom:22px; right:22px; z-index:999998; background:#0f1419; color:#fff; border:2px solid #1d9bf0; padding:12px 20px; border-radius:999px; font-weight:bold; font-size:14px; cursor:pointer; box-shadow:0 8px 25px rgba(0,0,0,0.4); font-family:sans-serif; }
      #xh6-fab:hover { background:#1d9bf0; }
      #xh6-modal { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:900px; max-width:96vw; height:670px; max-height:90vh; background:#fff; color:#0f1419; z-index:999999; border-radius:16px; box-shadow:0 16px 55px rgba(0,0,0,0.5); display:none; flex-direction:column; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; overflow:hidden; border:1px solid #cfd9de; }
      .xh6-head { padding:14px 22px; background:#0f1419; color:#fff; display:flex; justify-content:space-between; align-items:center; }
      .xh6-head h3 { margin:0; font-size:16px; }
      .xh6-bar { padding:10px 22px; background:#f7f9f9; border-bottom:1px solid #eff3f4; display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:12px; }
      .xh6-btn { padding:7px 13px; border-radius:18px; border:none; font-weight:bold; cursor:pointer; font-size:12px; }
      .xh6-btn:disabled { opacity:.45; cursor:not-allowed; }
      .xh6-blue { background:#1d9bf0; color:#fff; }
      .xh6-red { background:#f4212e; color:#fff; }
      .xh6-gray { background:#eff3f4; color:#0f1419; border:1px solid #cfd9de; }
      .xh6-select { padding:6px 10px; border:1px solid #cfd9de; border-radius:14px; font-size:12px; font-weight:bold; background:#fff; cursor:pointer; }
      .xh6-search { padding:6px 12px; border:1px solid #cfd9de; border-radius:16px; font-size:12px; width:140px; outline:none; }
      .xh6-status { padding:9px 22px; background:#eff6ff; border-bottom:1px solid #dbeafe; color:#1e40af; font-size:12px; display:flex; justify-content:space-between; font-weight:600; }
      .xh6-list { flex:1; overflow-y:auto; }
      .xh6-row { display:flex; align-items:center; padding:10px 22px; border-bottom:1px solid #eff3f4; gap:12px; font-size:13px; }
      .xh6-row:hover { background:#f8fafc; }
      .xh6-ava { width:38px; height:38px; border-radius:50%; object-fit:cover; background:#e2e8f0; }
      .xh6-info { flex:1; min-width:0; }
      .xh6-name { font-weight:bold; color:#0f1419; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .xh6-bio { color:#536471; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
      .xh6-tag { padding:3px 8px; border-radius:10px; font-size:11px; font-weight:bold; white-space:nowrap; }
      .xh6-t-no { background:#fee2e2; color:#dc2626; }
      .xh6-t-yes { background:#dcfce7; color:#16a34a; }
      .xh6-t-wl { background:#fef3c7; color:#d97706; }
      .xh6-fans { background:#f1f5f9; color:#475569; padding:2px 6px; border-radius:6px; font-size:11px; font-weight:normal; }
    `;
    document.head.appendChild(style);

    const fab = document.createElement("button");
    fab.id = "xh6-fab";
    fab.innerHTML = `⚡ 互关助手 V7.5 (<span id="xh6-fab-num">0</span>)`;
    document.body.appendChild(fab);

    const modal = document.createElement("div");
    modal.id = "xh6-modal";
    modal.innerHTML = `
      <div class="xh6-head">
        <h3>⚡ X 互关检测与后台直连取关 V7.5（批量白名单）</h3>
        <button id="xh6-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;">✕</button>
      </div>
      <div class="xh6-bar">
        <button class="xh6-btn xh6-blue" id="xh6-fetch-all">📥 拉取当前列表</button>
        <button class="xh6-btn xh6-gray" id="xh7-export">导出白名单</button>
        <button class="xh6-btn xh6-gray" id="xh7-import">导入白名单</button><input id="xh7-file" type="file" accept="application/json" hidden>
        <button class="xh6-btn xh6-gray" id="xh6-stop" style="display:none;">⏹ 停止</button>
        <button class="xh6-btn xh6-gray" id="xh6-clear" title="只清空普通缓存，保留本地白名单">🗑️ 清空列表(保留白名单)</button>
        <select class="xh6-select" id="xh6-view-mode">
          <option value="unmutual">只看未回关 / 待确认</option>
          <option value="all">显示全部已拉取</option>
          <option value="whitelist">🛡️ 只看我的白名单</option>
        </select>
        <input type="text" class="xh6-search" id="xh6-search" placeholder="🔍 搜名字/@账号...">
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
          <input type="checkbox" id="xh6-skip-v" checked> 保蓝V
        </label>
        <button class="xh6-btn xh6-gray" id="xh6-sel-all">全选当前结果</button>
        <button class="xh6-btn xh6-gray" id="xh7-select-safe">仅选可取关</button>
        <button class="xh6-btn xh6-gray" id="xh7-add-selected">已选加入白名单</button>
        <button class="xh6-btn xh6-gray" id="xh7-remove-selected">已选移出白名单</button>
        <button class="xh6-btn xh6-gray" id="xh6-sel-none">全不选</button>
        <button class="xh6-btn xh6-red" id="xh6-unfollow" style="margin-left:auto;">🔥 2. 一键取关已选 (0)</button>
      </div>
      <div class="xh6-status">
        <span id="xh6-msg">就绪：先拉取列表，再选择用户。白名单和互关用户不会取关。</span>
        <span id="xh6-stats">已拉取: 0 | 未互关: 0 | 🛡️白名单: 0 | 已选: 0</span>
      </div>
      <div style="padding:6px 22px;background:#f7f9f9;font-size:12px;color:#536471">按住鼠标左键拖过行内空白、名字或简介即可连续选择；从已选行开始拖动可取消选择。</div>
      <div class="xh6-list" id="xh6-list"></div>
    `;
    document.body.appendChild(modal);

    document.getElementById("xh7-export").onclick = () => {
      if (!storageReady) return;
      const blob = new Blob([JSON.stringify({version:7, keys:[...wlKeys], profiles:[...wlProfiles.values()]}, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download="X-white-list-backup.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    document.getElementById("xh7-import").onclick = () => { if (!isRunning && storageReady) document.getElementById("xh7-file").click(); };
    document.getElementById("xh7-file").onchange = async (e) => {
      try {
        const data=JSON.parse(await e.target.files[0].text());
        if (!Array.isArray(data.keys) || !Array.isArray(data.profiles)) throw new Error("备份格式无效");
        data.keys.forEach(k=>wlKeys.add(String(k).replace(/^@/, "").trim().toLowerCase()));
        data.profiles.forEach(p=>{if (p && /^\d+$/.test(String(p.id))) {wlProfiles.set(String(p.id), {...p, selected:false}); wlKeys.add(String(p.id)); if(p.screen_name) wlKeys.add(String(p.screen_name).toLowerCase());}});
        userStore.forEach(u=>{if(isUserWhitelisted(u)) u.selected=false;}); saveWhitelistToStorage(); updateUI(); setMsg("白名单备份已合并导入。");
      } catch(err) { alert("导入失败："+err.message); } e.target.value="";
    };
    const dragList = document.getElementById("xh6-list");
    let dragActive = false, dragSelect = true, dragStart = null;
    function paintDrag(id) {
      const rows = visibleUsers();
      const first = rows.findIndex(u=>u.id === dragStart), last = rows.findIndex(u=>u.id === id);
      if(first < 0 || last < 0) return;
      for(let i=Math.min(first,last);i<=Math.max(first,last);i++) rows[i].selected=dragSelect;
      // 拖动中只更新勾选状态，保留鼠标下的行，避免列表重建打断拖动。
      dragList.querySelectorAll(".xh6-cb").forEach(cb=>{const u=userStore.get(cb.dataset.id);if(u) cb.checked=u.selected;});
    }
    dragList.addEventListener("pointerdown", e=>{
      if(e.button !== 0 || isRunning || !storageReady || e.target.closest("button,a,input,select")) return;
      const row=e.target.closest(".xh6-row"); if(!row) return;
      const u=userStore.get(row.dataset.userId);if(!u)return;
      dragActive=true;dragStart=u.id;dragSelect=!u.selected;
      e.preventDefault();paintDrag(u.id);
    });
    document.addEventListener("pointerover", e=>{
      if(!dragActive)return;
      const row=e.target.closest?.(".xh6-row");if(row && dragList.contains(row)) paintDrag(row.dataset.userId);
    });
    function finishDrag() {if(!dragActive)return;dragActive=false;dragStart=null;updateUI();}
    document.addEventListener("pointerup",finishDrag);
    document.addEventListener("pointercancel",finishDrag);
    window.addEventListener("blur",finishDrag);
    fab.onclick = () => {
      scanInitialDOM();
      updateUI();
      modal.style.display = modal.style.display === "flex" ? "none" : "flex";
    };
    document.getElementById("xh6-close").onclick = () => (modal.style.display = "none");
    document.getElementById("xh6-stop").onclick = () => { stopRequested=true; setMsg("正在停止：等待当前请求结束，不再开始下一项。"); };
    document.getElementById("xh6-clear").onclick = () => {
      if (isRunning) return;
      clearNormalListKeepWhitelist();
      setMsg(`🗑️ 普通列表已清空（您的 ${wlProfiles.size} 位白名单保护用户已保留，无需重选）。`);
    };
    document.getElementById("xh6-view-mode").onchange = (e) => {
      viewMode = e.target.value;
      updateUI();
    };
    document.getElementById("xh6-search").oninput = (e) => {
      searchKeyword = e.target.value.trim().toLowerCase();
      updateUI();
    };

    document.getElementById("xh6-skip-v").onchange = updateUI;
    document.getElementById("xh6-sel-all").onclick = () => {
      if (isRunning) return;
      const rows = visibleUsers(); rows.forEach(u => u.selected = true);
      updateUI(); setMsg(`已选择当前结果 ${rows.length} 人；保护对象仅可管理白名单，不会取关。`);
    };
    document.getElementById("xh6-sel-none").onclick = () => {
      if (isRunning) return;
      userStore.forEach(u => u.selected = false); updateUI(); setMsg("已取消全部选择（包括隐藏结果）。");
    };
    document.getElementById("xh7-select-safe").onclick = () => {
      if (isRunning) return;
      userStore.forEach(u=>u.selected=false);
      visibleUsers().forEach(u=>u.selected=shouldAutoSelect(u)); updateUI(); setMsg("已仅选择当前结果中可取关的人。");
    };
    document.getElementById("xh7-add-selected").onclick = () => batchWhitelist(true);
    document.getElementById("xh7-remove-selected").onclick = () => batchWhitelist(false);

    document.getElementById("xh6-fetch-all").onclick = startCursorFetchAll;
    document.getElementById("xh6-unfollow").onclick = startDirectBatchUnfollow;
  }

  function matchSearch(u, kw) {
    kw = kw.replace(/^@/, "");
    if (!kw) return true;
    return (
      (u.name && u.name.toLowerCase().includes(kw)) ||
      (u.screen_name && u.screen_name.toLowerCase().includes(kw)) ||
      (u.bio && u.bio.toLowerCase().includes(kw))
    );
  }

  function setMsg(t) {
    const el = document.getElementById("xh6-msg");
    if (el) el.innerText = t;
  }

  function visibleUsers() {
    return [...userStore.values()].filter(u => {
      if (viewMode === "whitelist" && !isUserWhitelisted(u)) return false;
      if (viewMode === "unmutual" && u.followed_by === true) return false;
      return !searchKeyword || matchSearch(u, searchKeyword);
    });
  }
  function batchWhitelist(add) {
    if (isRunning || !storageReady) return;
    const targets=[...userStore.values()].filter(u=>u.selected && (add ? !isUserWhitelisted(u) : isUserWhitelisted(u)));
    if (!targets.length) {setMsg(add ? "请先选择要加入白名单的人。" : "请在白名单视图选择要移除的人。");return;}
    if (!add && !confirm(`将 ${targets.length} 人移出白名单。不会立即取关。继续？`)) return;
    for (const u of targets) {
      const id=String(u.id), handle=String(u.screen_name || "").toLowerCase();
      if (add) {wlKeys.add(id);if(handle)wlKeys.add(handle);wlProfiles.set(id,{...u,selected:false});}
      else {wlKeys.delete(id);if(handle)wlKeys.delete(handle);wlProfiles.delete(id);}
      u.selected=false;
    }
    saveWhitelistToStorage();updateUI();setMsg(`已${add ? "加入" : "移出"}白名单 ${targets.length} 人。`);
  }
  function protectionReason(u) {
    if(isUserWhitelisted(u)) return "白名单保护";
    if(u.followed_by === true) return "互关保留";
    if(u.followed_by !== false) return "关系待确认，保留";
    if((document.getElementById("xh6-skip-v")?.checked ?? true) && u.verified) return "认证保护";
    return "可取关";
  }

  function updateUI() {
    const listEl = document.getElementById("xh6-list");
    if (!listEl) return;

    // 如果切到“只看白名单”视图，直接把永久保存的白名单资料合并展示出来
    if (viewMode === "whitelist") {
      wlProfiles.forEach((p, id) => {
        if (!userStore.has(id)) {
          userStore.set(id, { ...p, selected: false });
        }
      });
    }

    const all = Array.from(userStore.values());
    const relation = u => u.followed_by;
    const unmutual = all.filter((u) => relation(u) === false);
    const selected = all.filter(u => u.selected);
    const actionable = selected.filter(shouldAutoSelect);
    const wlTotal = wlProfiles.size || Math.floor(wlKeys.size / 2);

    document.getElementById("xh6-fab-num").innerText = unmutual.length;
    document.getElementById("xh6-stats").innerText =
      `已拉取: ${all.length} | 未互关: ${unmutual.length} | 🛡️白名单: ${wlTotal} | 已选: ${selected.length} | 可取关: ${actionable.length}`;
    document.getElementById("xh6-unfollow").innerText =
      `取关已选中的可操作用户 (${actionable.length})`;
    const controls=["xh6-fetch-all","xh6-clear","xh6-sel-all","xh6-sel-none","xh7-select-safe","xh7-add-selected","xh7-remove-selected","xh7-import","xh6-skip-v"];
    controls.forEach(id=>{const el=document.getElementById(id);if(el)el.disabled=isRunning || !storageReady;});
    document.getElementById("xh6-unfollow").disabled=isRunning || !storageReady || !actionable.length;

    const rows = visibleUsers();

    if (rows.length === 0) {
      listEl.innerHTML = `<div style="padding:50px;text-align:center;color:#536471;line-height:1.8;">
        当前视图下暂无用户。<br>请进入自己的 <b>/${listMode}</b> 页面，点击左上角 <b>“拉取当前列表”</b>。
      </div>`;
      return;
    }

    listEl.innerHTML = rows
      .map((u) => {
        const isWl = isUserWhitelisted(u);
        return `
        <div class="xh6-row" data-user-id="${esc(u.id)}" style="${isWl ? "background:#fffbeb;" : ""}">
          <input type="checkbox" class="xh6-cb" data-id="${esc(u.id)}" ${u.selected ? "checked" : ""} ${isRunning ? "disabled" : ""}>
          <img class="xh6-ava" src="${esc(u.avatar || "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png")}">
          <div class="xh6-info">
            <div class="xh6-name">
              <span>${esc(u.name)}</span>
              ${u.verified ? `<span style="color:#1d9bf0;" title="认证用户">☑️</span>` : ""}
              <a href="/${esc(u.screen_name)}" target="_blank" style="color:#536471;font-weight:normal;text-decoration:none;">@${esc(u.screen_name)}</a>
            </div>
            <div class="xh6-bio">${esc(protectionReason(u))}${u.bio ? " · " + esc(u.bio) : ""}</div>
          </div>
          ${
            isWl
              ? `<span class="xh6-tag xh6-t-wl">🛡️ 白名单</span>`
              : relation(u) === true
              ? `<span class="xh6-tag xh6-t-yes">✓ 互关</span>`
              : `<span class="xh6-tag xh6-t-no">${relation(u) === false ? ("对方未回关") : "关系待确认"}</span>`
          }
          <button class="xh6-btn xh6-gray xh6-wl" data-id="${esc(u.id)}">
            ${isWl ? "移出白名单" : "🛡️ 保护"}
          </button>
        </div>
      `;
      })
      .join("");

    listEl.querySelectorAll(".xh6-cb").forEach((cb) => {
      cb.onchange = (e) => {
        const u = userStore.get(e.target.dataset.id);
        if (u && !isRunning) {
          u.selected = e.target.checked;
        }
        updateUI();
      };
    });

    listEl.querySelectorAll(".xh6-wl").forEach((btn) => {
      btn.onclick = (e) => {
        const id = e.target.dataset.id;
        const u = userStore.get(id);
        if (u && !isRunning && storageReady) toggleUserWhitelist(u);
      };
    });
  }

  async function startCursorFetchAll() {
    if (isRunning || !storageReady) return;
    if (!location.pathname.endsWith("/" + listMode)) {
      alert("请先进入你自己的 /" + listMode + " 页面！");
      return;
    }

    const startingPath = location.pathname;
    stopRequested = false;
    isRunning = true;
    document.getElementById("xh6-stop").style.display = "inline-block";

    // 重新拉取时只清普通缓存，自动继承所有白名单！
    userStore.clear();
    scanInitialDOM();
    updateUI();

    let cursor = null;
    let page = 1;
    let emptyPagesInARow = 0;

    while (isRunning && !stopRequested && location.pathname === startingPath) {
      setMsg(`📥 正在后台拉取第 ${page} 页数据... (已捕获 ${userStore.size} 人，已自动跳过白名单勾选)`);
      const res = await fetchNextPageByCursor(cursor);

      if (stopRequested || location.pathname !== startingPath) break;
      if (!res.ok) {
        if (res.error === "NO_TEMPLATE") {
          setMsg("⏳ 正在自动激活页面 GraphQL 接口，请稍候...");
          window.scrollBy({ top: 700, behavior: "smooth" });
          await sleep(1200);
          const retry = await fetchNextPageByCursor(cursor);
          if (!retry.ok) {
            setMsg("⚠️ 请先刷新一次网页，然后再点击“拉取当前列表”！");
            break;
          }
          continue;
        }
        if (res.status === 429) {
          for (let s = 30; s > 0 && isRunning && !stopRequested; s--) {
            setMsg(`⏳ 触发 X 接口读取限流 (429)，自动冷却等待 ${s} 秒后继续拉取...`);
            await sleep(1000);
          }
          continue;
        }
        setMsg(`⚠️ 拉取中断 (${res.error})。当前已捕获 ${userStore.size} 人。`);
        break;
      }

      const list = res.users || [];
      list.forEach((u) => upsertUser(u));
      updateUI();

      const nextCur = res.nextCursor;
      if (!nextCur || nextCur.startsWith("0|") || nextCur === cursor) {
        setMsg(`已到接口返回的列表末尾。共获取 ${userStore.size} 人（白名单已自动保护并取消勾选）。`);
        break;
      }

      if (list.length === 0) {
        emptyPagesInARow++;
        if (emptyPagesInARow >= 3) {
          setMsg(`列表连续返回空页，已停止；完整性尚未确认。共获取 ${userStore.size} 人（白名单已自动保护）。`);
          break;
        }
      } else {
        emptyPagesInARow = 0;
      }

      cursor = nextCur;
      page++;
      await sleep(550);
    }

    isRunning = false;
    document.getElementById("xh6-stop").style.display = "none";
    updateUI();
  }

  async function startDirectBatchUnfollow() {
    // 双重保险：取关队列强制排除任何在白名单中的用户
    if (isRunning || !storageReady) return;
    const targets = Array.from(userStore.values()).filter((u) => u.selected && shouldAutoSelect(u));
    if (targets.length === 0) {
      alert("已选用户中没有可取关的人。请查看每行的保护原因。");
      return;
    }

    if (!location.pathname.endsWith("/" + listMode)) { alert("请回到你自己的 /"+listMode+" 页面"); return; }
    if (!confirm(`将${"取关"} ${targets.length} 人。请确认当前列表属于你自己。继续？`)) return;
    const startingPath = location.pathname;
    stopRequested = false;
    isRunning = true;
    document.getElementById("xh6-stop").style.display = "inline-block";

    let done = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
      if (!isRunning || stopRequested || location.pathname !== startingPath) break;
      const u = targets[i];

      if (isUserWhitelisted(u) || (listMode === "following" && !shouldAutoSelect(u))) continue;

      if (done > 0 && done % 40 === 0) {
        for (let s = 15; s > 0 && isRunning && !stopRequested; s--) {
          setMsg(`已完成 ${done} 人，休息 ${s} 秒后继续...`);
          await sleep(1000);
        }
      }

      if (!isRunning || stopRequested || location.pathname !== startingPath) break;
      setMsg(`🚀 正在后台执行${"取关"} @${u.screen_name} (${i + 1}/${targets.length})...`);
      let res = await directUnfollowById(u.id, u.screen_name);

      if (!res.ok && res.status === 429) {
        for (let s = 60; s > 0 && isRunning && !stopRequested; s--) {
          setMsg(`⏳ 触发 X 取关频率限制 (429)，自动休眠 ${s} 秒后重试 @${u.screen_name}...`);
          await sleep(1000);
        }
        if (isRunning && !stopRequested && location.pathname === startingPath) {
          res = await directUnfollowById(u.id, u.screen_name);
        }
      }

      if (!res.ok) {
        failed++; isRunning = false; setMsg("操作未确认，已停止，请刷新网页核对后再试。"); break;
      }

      if (res && res.ok) {
        done++;
        userStore.delete(u.id);
        updateUI();
      } else {
        failed++;
        setMsg(`⚠️ @${u.screen_name} 取关失败 (${res?.error || "未知"})，继续下一个...`);
      }

      if (i < targets.length - 1 && isRunning && !stopRequested) {
        await sleep(1300 + Math.floor(Math.random() * 900));
      }
    }

    isRunning = false;
    document.getElementById("xh6-stop").style.display = "none";
    updateUI();
    setMsg(`批量${"取关"}${stopRequested ? "已停止" : "已结束"}。成功 ${done} 人${failed ? ` (失败 ${failed} 人)` : ""}。`);
  }

  initUI();
  setTimeout(scanInitialDOM, 1000);
})();