(function () {
  if (window.__xh6Injected) return;
  window.__xh6Injected = true;

  let capturedHeaders = {
    authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
  };
  const templates = {};
  let followingQueryTemplate = null;

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]*)/);
    return m ? m[1] : "";
  }

  function parseFollowingResponse(json, mode = "following") {
    const users = [];
    let nextCursor = null;

    try {
      const instructions =
        json?.data?.user?.result?.timeline?.timeline?.instructions ||
        json?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
        [];

      for (const inst of instructions) {
        const entries = inst.entries || (inst.entry ? [inst.entry] : []);
        for (const entry of entries) {
          const eid = entry.entryId || "";

          if (eid.startsWith("cursor-bottom-") || entry?.content?.cursorType === "Bottom") {
            nextCursor = entry?.content?.value || null;
            continue;
          }

          if (!eid.startsWith("user-")) continue;

          const res = entry?.content?.itemContent?.user_results?.result;
          if (!res) continue;

          const u = res.__typename === "UserWithVisibilityResults" ? res.user : res;
          if (!u || !u.rest_id) continue;

          const legacy = u.legacy || {};
          const core = u.core || {};
          const rel = u.relationship_perspectives || {};

          const screen_name = legacy.screen_name || core.screen_name;
          const name = legacy.name || core.name || screen_name;
          if (!screen_name) continue;

          const relationship = (key) => typeof rel[key] === "boolean" ? rel[key] : typeof legacy[key] === "boolean" ? legacy[key] : null;
          const following = relationship("following");
          const followed_by = relationship("followed_by");
          if (following === false) continue;

          users.push({
            id: String(u.rest_id),
            screen_name: String(screen_name),
            name: String(name),
            avatar: (u.avatar && u.avatar.image_url) || legacy.profile_image_url_https || "",
            followed_by,
            following: true,
            verified: Boolean(u.is_blue_verified || legacy.verified),
            bio: legacy.description || ""
          });
        }
      }
    } catch (e) {}

    return { users, nextCursor };
  }

  function trySaveFollowingTemplate(urlStr) {
    try {
      if (!urlStr || !/\/graphql\/[^/]+\/Following\?/i.test(urlStr)) return false;
      const u = new URL(urlStr, location.origin);
      const vars = u.searchParams.get("variables");
      const features = u.searchParams.get("features");
      const fieldToggles = u.searchParams.get("fieldToggles");
      if (vars && features) {
        followingQueryTemplate = {
          baseUrl: u.origin + u.pathname,
          variables: JSON.parse(vars),
          features: features,
          fieldToggles: fieldToggles
        };
        templates[u.pathname.split("/").pop().toLowerCase()] = followingQueryTemplate;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function recoverTemplateFromPerformance() {

    try {
      if (templates.following) return true;
      const entries = performance.getEntriesByType("resource") || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (trySaveFollowingTemplate(entries[i].name)) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._xh_url = url;
    trySaveFollowingTemplate(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (k && v) {
      const low = k.toLowerCase();
      if (
        [
          "authorization",
          "x-csrf-token",
          "x-twitter-active-user",
          "x-twitter-auth-type",
          "x-twitter-client-language",
          "x-xp-forwarded-for",
          "x-client-uuid"
        ].includes(low)
      ) {
        capturedHeaders[low] = v;
      }
    }
    return origSetHeader.call(this, k, v);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      if (this._xh_url && /\/Following(\?|$)/i.test(this._xh_url)) {
        try {
          const data = JSON.parse(this.responseText);
          const mode = "following";
          const { users, nextCursor } = parseFollowingResponse(data, mode);
          window.postMessage(
            { type: "XH6_PAGE_DATA", mode, users, nextCursor, hasTemplate: true },
            "*"
          );
        } catch (e) {}
      }
    });
    return origSend.apply(this, args);
  };

  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(url, location.origin);
    const relevant = target.origin === location.origin && /\/graphql\/[^/]+\/Following$/.test(target.pathname);
    if (relevant) {
      trySaveFollowingTemplate(target.href);
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      for (const [key, value] of headers) {
        if (["authorization", "x-csrf-token", "x-twitter-active-user", "x-twitter-auth-type", "x-twitter-client-language"].includes(key)) capturedHeaders[key] = value;
      }
    }
    const response = await originalFetch.call(this, input, init);
    if (relevant && response.ok) {
      response.clone().json().then(json => {
        const mode = "following";
        const {users, nextCursor} = parseFollowingResponse(json, mode);
        window.postMessage({type:"XH6_PAGE_DATA", mode, users, nextCursor}, location.origin);
      }).catch(() => {});
    }
    return response;
  };

  function buildAuthHeaders(extra = {}) {
    return {
      ...capturedHeaders,
      "x-csrf-token": getCsrfToken(),
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      ...extra
    };
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    const requestId = e.data.requestId;
    const reply = (data) => window.postMessage({ ...data, requestId }, location.origin);

    if (e.data.type === "XH6_FETCH_NEXT_CURSOR") {
      const { cursor, mode = "following" } = e.data;
      if (mode !== "following") return;
      recoverTemplateFromPerformance();

      followingQueryTemplate = templates[mode];
      if (!followingQueryTemplate) {
        reply({ type: "XH6_CURSOR_ERROR", error: "NO_TEMPLATE" });
        return;
      }

      try {
        const newVars = {
          ...followingQueryTemplate.variables,
          count: 50
        };
        if (cursor) {
          newVars.cursor = cursor;
        } else {
          delete newVars.cursor;
        }

        const params = new URLSearchParams();
        params.set("variables", JSON.stringify(newVars));
        params.set("features", followingQueryTemplate.features);
        if (followingQueryTemplate.fieldToggles) {
          params.set("fieldToggles", followingQueryTemplate.fieldToggles);
        }

        const url = `${followingQueryTemplate.baseUrl}?${params.toString()}`;
        const res = await fetch(url, {
          method: "GET",
          headers: buildAuthHeaders(),
          credentials: "include"
        });

        if (!res.ok) {
          reply({ type: "XH6_CURSOR_ERROR", error: `HTTP_${res.status}`, status: res.status });
          return;
        }

        const json = await res.json();
        if (json.errors || !json.data?.user?.result) throw new Error("接口返回异常，未确认列表完整性");
        const { users, nextCursor } = parseFollowingResponse(json, mode);
        reply({ type: "XH6_CURSOR_RESULT", users, nextCursor });
      } catch (err) {
        reply({ type: "XH6_CURSOR_ERROR", error: err.message });
      }
    }

    if (e.data.type === "XH6_DIRECT_UNFOLLOW") {
      const { userId, screenName, action = "unfollow" } = e.data;
      if (!/^\d+$/.test(String(userId)) || action !== "unfollow") return;
      try {
        const res = await fetch(`${location.origin}/i/api/1.1/friendships/destroy.json`, {
          method: "POST",
          headers: buildAuthHeaders({
            "content-type": "application/x-www-form-urlencoded"
          }),
          body: `include_profile_interstitial_type=1&skip_status=1&user_id=${encodeURIComponent(userId)}`,
          credentials: "include"
        });

        const result = await res.json();
        if (res.ok && !result.errors && (result.id_str || result.id)) {
          reply({ type: "XH6_UNFOLLOW_DONE", userId, screenName, ok: true });
        } else {
          reply({ type: "XH6_UNFOLLOW_DONE", userId, screenName, ok: false, status: res.status, error: `HTTP ${res.status} / ${JSON.stringify(result.errors || "响应未确认")}` });
        }
      } catch (err) {
        reply({ type: "XH6_UNFOLLOW_DONE", userId, screenName, ok: false, status: 0, error: err.message });
      }
    }
  });
})();