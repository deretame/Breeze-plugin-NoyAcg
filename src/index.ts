import wretch, { type ConfiguredMiddleware } from "wretch";
import {
  NOT_FOUND_IMAGE_URL,
  PLUGIN_ID,
  SettingsBundleContract,
  createActionItem,
  createBasicMetadata,
  createImage,
  createMetadataActionList,
  toStringMap,
} from "./common";
import { buildPluginInfo } from "./get-info";
import { cache, flutterTools, pluginConfig } from "./tools";

type BasePayload = {
  extern?: Record<string, unknown>;
};

type SearchPayload = BasePayload & {
  keyword?: string;
  page?: number;
};

type ComicDetailPayload = BasePayload & {
  comicId?: string;
};

type ChapterPayload = BasePayload & {
  comicId?: string;
  chapterId?: string;
};

type ReadSnapshotPayload = {
  comicId?: string;
  chapterId?: string;
  extern?: Record<string, unknown>;
};

type FetchImagePayload = {
  url?: string;
  timeoutMs?: number;
};

type LoginPayload = {
  account?: string;
  password?: string;
  reason?: string;
  persistCredentials?: boolean;
};

const BASE_GROUPS = [
  { api: "https://api.noymanga.com", img: "https://img.noymanga.com" },
  { api: "https://api.noyteam.online", img: "https://img.noyteam.online" },
  { api: "https://api.noy.asia", img: "https://img.noy.asia" },
];

const AUTH_ACCOUNT_CONFIG_KEY = "auth.account";
const AUTH_PASSWORD_CONFIG_KEY = "auth.password";
const AUTH_COOKIES_CONFIG_KEY = "auth.cookies";
const ALLOW_ADULT_CONFIG_KEY = "search.allowAdult";
const DOMAIN_GROUP_CONFIG_KEY = "network.domainGroup";
const AUTH_CREDENTIALS_REQUIRED_ERROR =
  "[AUTH_CREDENTIALS_REQUIRED] 账号或密码不能为空，请先在设置中填写";

let cookieStore: Map<string, string> = new Map();
let cookieStoreLoaded = false;
let loginInFlight: Promise<string> | null = null;
let noyInitStarted = false;

async function persistConfigValue(key: string, value: string) {
  await Promise.all([cache.set(key, value), saveConfigString(key, value)]);
}

function readConfigValueSync(key: string, fallback: string): string {
  return String(cache.getSync(key, fallback));
}

async function readConfigValue(key: string, fallback: string): Promise<string> {
  return await loadAndNormalizeConfigString(key, fallback);
}

function getDefaultHeadersSync() {
  const headers: Record<string, string> = {
    "User-Agent": "NoyAcg/3.0",
    "allow-adult": readConfigValueSync(ALLOW_ADULT_CONFIG_KEY, "both"),
    Accept: "application/json, text/plain, */*",
  };
  const cookie = getCookieHeader();
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

const loginRetryMiddleware: ConfiguredMiddleware =
  (next) => async (url, opts) => {
    await loadCookieStore();
    const mergedOpts = {
      ...opts,
      headers: {
        ...getDefaultHeadersSync(),
        ...((opts.headers as Record<string, string>) || {}),
      },
    };

    let response = await next(url, mergedOpts);
    updateCookiesFromResponse(response);

    // Don't intercept login endpoint or non-JSON responses
    if (url.includes("/api/login")) {
      return response;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return response;
    }

    // Check for login-required status
    let json: Record<string, unknown> | null = null;
    try {
      const clone = response.clone();
      json = (await clone.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body, skip login check
    }

    if (json && json.status === "login") {
      await tryAutoLogin("api");
      // Retry once with fresh cookies
      const retryOpts = {
        ...opts,
        headers: {
          ...getDefaultHeadersSync(),
          ...((opts.headers as Record<string, string>) || {}),
        },
      };
      response = await next(url, retryOpts);
      updateCookiesFromResponse(response);
    }

    return response;
  };

async function getDomainGroup() {
  try {
    const raw = await readConfigValue(DOMAIN_GROUP_CONFIG_KEY, "2");
    const index = Number(raw);
    return BASE_GROUPS[
      Number.isFinite(index) && index >= 0 && index <= 2 ? index : 2
    ];
  } catch {
    return BASE_GROUPS[2];
  }
}

async function createApiWretch() {
  const base = await getDomainGroup();
  return wretch(base.api).middlewares([loginRetryMiddleware]);
}

function decodeConfigString(raw: unknown, fallback = "") {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  if (typeof raw === "object") {
    const map = raw as Record<string, unknown>;
    if (map.ok === true && "value" in map) {
      return decodeConfigString(map.value, fallback);
    }
    return fallback;
  }
  const text = String(raw);
  if (!text.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text.trim());
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).ok === true &&
      "value" in (parsed as Record<string, unknown>)
    ) {
      return decodeConfigString(
        (parsed as Record<string, unknown>).value,
        fallback,
      );
    }
    if (
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    ) {
      return String(parsed);
    }
  } catch {
    // use raw text
  }
  return text;
}

async function saveConfigString(key: string, value: string) {
  const normalized = decodeConfigString(value, "");
  await pluginConfig.save(key, normalized);
}

async function loadAndNormalizeConfigString(key: string, fallback = "") {
  const raw = await pluginConfig.load(key, fallback);
  const normalized = decodeConfigString(raw, fallback);
  const currentRawText =
    typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (currentRawText !== normalized) {
    try {
      await saveConfigString(key, normalized);
    } catch {
      // ignore
    }
  }
  return normalized;
}

async function loadAuthAccount() {
  return (await readConfigValue(AUTH_ACCOUNT_CONFIG_KEY, "")).trim();
}

async function loadAuthPassword() {
  return await readConfigValue(AUTH_PASSWORD_CONFIG_KEY, "");
}

async function loadCookieStore() {
  if (cookieStoreLoaded) {
    return;
  }
  try {
    const raw = await pluginConfig.load(AUTH_COOKIES_CONFIG_KEY, "{}");
    const obj = JSON.parse(String(raw ?? "{}"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && key) {
          cookieStore.set(key, value);
        }
      }
    }
  } catch {
    // ignore
  }
  cookieStoreLoaded = true;
}

async function saveCookieStore() {
  const obj: Record<string, string> = {};
  for (const [key, value] of cookieStore.entries()) {
    obj[key] = value;
  }
  await pluginConfig.save(AUTH_COOKIES_CONFIG_KEY, JSON.stringify(obj));
}

function updateCookiesFromResponse(res: Response) {
  const setCookieHeaders: string[] = [];
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    setCookieHeaders.push(...headers.getSetCookie());
  } else {
    const single = headers.get("set-cookie");
    if (single) setCookieHeaders.push(single);
  }
  for (const header of setCookieHeaders) {
    if (!header) continue;
    const first = header.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    cookieStore.set(name, value);
  }
}

function getCookieHeader() {
  if (cookieStore.size === 0) return "";
  return [...cookieStore.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function requireCredentials(account: string, password: string) {
  if (!account.trim() || !String(password ?? "").trim()) {
    throw new Error(AUTH_CREDENTIALS_REQUIRED_ERROR);
  }
}

async function loginWithPassword(payload: LoginPayload = {}) {
  const account = String(payload.account ?? "").trim();
  const password = String(payload.password ?? "");
  requireCredentials(account, password);

  if (loginInFlight) {
    await loginInFlight;
    return {
      source: PLUGIN_ID,
      data: { account, password },
    };
  }

  loginInFlight = (async () => {
    const base = await getDomainGroup();
    const formData = new URLSearchParams();
    formData.append("user", account);
    formData.append("pass", password);

    await loadCookieStore();
    const headers = getDefaultHeadersSync();
    let res = await wretch(`${base.api}/api/login`)
      .headers({
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      })
      .post(formData.toString())
      .res();

    if (!res.ok) {
      flutterTools.showToast({
        message: `登录请求失败(${res.status})`,
        level: "error",
      });
      throw new Error(`登录请求失败(${res.status})`);
    }

    updateCookiesFromResponse(res);

    const json = (await res.json()) as Record<string, unknown>;
    if (json.status !== "ok") {
      flutterTools.showToast({
        message: String(json.message ?? "登录失败"),
        level: "error",
      });
      throw new Error(String(json.message ?? "登录失败"));
    }

    if (payload.persistCredentials !== false) {
      await Promise.all([
        saveConfigString(AUTH_ACCOUNT_CONFIG_KEY, account),
        saveConfigString(AUTH_PASSWORD_CONFIG_KEY, password),
      ]);
    }
    await saveCookieStore();
    ``;
    return account;
  })();

  try {
    await loginInFlight;
    return {
      source: PLUGIN_ID,
      data: { account, password },
    };
  } finally {
    loginInFlight = null;
  }
}

function readSettingPayloadValue(
  payload: Record<string, unknown>,
  key: string,
) {
  const direct = payload.value;
  if (direct !== undefined && direct !== null) {
    return decodeConfigString(direct, "");
  }
  if (payload[key] !== undefined && payload[key] !== null) {
    return decodeConfigString(payload[key], "");
  }
  const data = toStringMap(payload.data);
  if (data[key] !== undefined && data[key] !== null) {
    return decodeConfigString(data[key], "");
  }
  if (data.value !== undefined && data.value !== null) {
    return decodeConfigString(data.value, "");
  }
  return "";
}

async function setAccountAndLogin(payload: Record<string, unknown> = {}) {
  const account = readSettingPayloadValue(
    payload,
    AUTH_ACCOUNT_CONFIG_KEY,
  ).trim();
  await saveConfigString(AUTH_ACCOUNT_CONFIG_KEY, account);
  const password = await loadAuthPassword();
  await loginWithPassword({
    account,
    password,
    reason: "settings.account.changed",
    persistCredentials: true,
  });
  flutterTools.showToast({ message: "登录成功", level: "success" });
  return {
    source: PLUGIN_ID,
    data: { account },
  };
}

async function setPasswordAndLogin(payload: Record<string, unknown> = {}) {
  const password = readSettingPayloadValue(payload, AUTH_PASSWORD_CONFIG_KEY);
  await saveConfigString(AUTH_PASSWORD_CONFIG_KEY, password);
  const account = await loadAuthAccount();
  await loginWithPassword({
    account,
    password,
    reason: "settings.password.changed",
    persistCredentials: true,
  });
  flutterTools.showToast({ message: "登录成功", level: "success" });
  return {
    source: PLUGIN_ID,
    data: { account },
  };
}

async function setDomainGroup(payload: Record<string, unknown> = {}) {
  const value = readSettingPayloadValue(payload, DOMAIN_GROUP_CONFIG_KEY);
  await persistConfigValue(DOMAIN_GROUP_CONFIG_KEY, value);
  cookieStore.clear();
  cookieStoreLoaded = false;
  await saveCookieStore();
  return {
    source: PLUGIN_ID,
    data: { domainGroup: value },
  };
}

async function setAllowAdult(payload: Record<string, unknown> = {}) {
  const raw = readSettingPayloadValue(payload, ALLOW_ADULT_CONFIG_KEY);
  const value = raw || "both";
  await persistConfigValue(ALLOW_ADULT_CONFIG_KEY, value);
  return {
    source: PLUGIN_ID,
    data: { allowAdult: value },
  };
}

function formatUnixSeconds(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createPagingInfo(page: number, pageCount: number, total: number) {
  return {
    page,
    pages: Math.max(1, pageCount),
    total,
    hasReachedMax: page >= Math.max(1, pageCount),
  };
}

async function tryAutoLogin(reason: string) {
  const [account, password] = await Promise.all([
    loadAuthAccount(),
    loadAuthPassword(),
  ]);
  if (!account || !String(password).trim()) {
    throw new Error("需要登录，请在设置中填写账号密码");
  }
  try {
    await loginWithPassword({
      account,
      password,
      reason,
      persistCredentials: true,
    });
  } catch (error) {
    throw new Error(
      `自动登录失败：${String((error as { message?: string } | null)?.message ?? error)}`,
    );
  }
}

function buildSearchResult(
  json: Record<string, unknown>,
  page: number,
  baseImg: string,
  ext: Record<string, unknown> | null | undefined,
) {
  const dataList = (
    Array.isArray(json.data) ? json.data : []
  ) as SearchApiItem[];
  const total = toNumber(json.count, dataList.length);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const items = dataList.map((item) => {
    const comicId = String(item.id ?? "").trim();
    const title = String(item.name ?? "").trim() || `漫画 ${comicId}`;
    const coverUrl = comicId ? `${baseImg}/${comicId}/m1.webp` : "";
    const author = String(item.author ?? "").trim();
    const isAdult = item.adult === 1;
    const isFinished = item.status === 0;
    const statusText = isFinished ? "短篇" : "连载中";
    const tagList = Array.isArray(item.tags) ? item.tags : [];
    const description = String(item.description ?? "").trim();
    const path = `comic/${comicId}/cover.webp`;

    return {
      source: PLUGIN_ID,
      id: comicId,
      title,
      subtitle: [author, isAdult ? "R18" : null, statusText]
        .filter(Boolean)
        .join(" · "),
      finished: isFinished,
      likesCount: toNumber(item.favorites, 0),
      viewsCount: toNumber(item.views, 0),
      updatedAt: "",
      cover: {
        id: comicId,
        url: coverUrl || NOT_FOUND_IMAGE_URL,
        path,
        name: `${comicId}.webp`,
        extern: { path },
      },
      metadata: [
        createMetadataActionList(
          "author",
          "作者",
          author ? [author] : [],
          (item) =>
            createActionItem(item, {
              type: "openSearch",
              payload: { keyword: item },
            }),
        ),
        createBasicMetadata("status", "状态", [statusText]),
        createBasicMetadata("categories", "分类", []),
        createMetadataActionList(
          "tags",
          "标签",
          tagList,
          (item) =>
            createActionItem(item, {
              type: "openSearch",
              payload: { keyword: item },
            }),
        ),
        createBasicMetadata("works", "作品", []),
        createBasicMetadata("actors", "角色", []),
      ],
      raw: item,
      extern: { comicId },
    };
  });

  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: ext ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { paging, items },
    paging,
    items,
  };
}

// -- Search --

type SearchApiItem = {
  id?: number;
  name?: string;
  author?: string;
  description?: string;
  tags?: string[];
  mode?: number;
  adult?: number;
  status?: number;
  views?: number;
  favorites?: number;
  rating_sum?: number;
};

async function searchComic(payload: SearchPayload = {}) {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  if (!keyword) {
    throw new Error("keyword 不能为空");
  }

  const formData = new URLSearchParams({
    value: keyword,
    mode: "default",
    sort: "time",
    type: "all",
    finished: "",
    page: String(page),
  });

  const domainGroup = await getDomainGroup();
  const api = wretch(domainGroup.api).middlewares([loginRetryMiddleware]);
  const res = await api
    .headers({
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    })
    .post(formData.toString(), "/api/v4/search/fetch")
    .res();

  if (!res.ok) {
    throw new Error(`搜索请求失败(${res.status})`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (json.status !== "ok") {
    throw new Error(String(json.message ?? "搜索失败"));
  }

  return buildSearchResult(json, page, domainGroup.img, payload.extern);
}

// -- Detail --

type BookApiInfo = {
  Bid?: number;
  Bookname?: string;
  Author?: string;
  Description?: string;
  Adult?: number;
  Status?: number;
  Views?: number;
  Favorites?: number;
  Time?: number;
  Ptag?: string;
  Otag?: string;
  Pname?: string;
  publish_year?: string;
  RatingSUM?: number;
};

type BookApiChapter = {
  id?: number;
  name?: string;
  count?: number;
  sort?: number;
  created_at?: number;
};

type BookApiResponse = {
  status?: string;
  message?: string;
  book?: {
    info?: BookApiInfo;
    recommend?: unknown;
  };
  chapters?: {
    categories?: Array<{ id?: number; name?: string }>;
    data?: Record<string, BookApiChapter[]>;
  };
  comment?: {
    count?: number;
    data?: unknown[];
  };
};

async function getComicDetail(payload: ComicDetailPayload = {}) {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const domainGroup = await getDomainGroup();
  const api = wretch(domainGroup.api).middlewares([loginRetryMiddleware]);
  const res = await api.get(`/api/v4/book/${comicId}`).res();

  if (!res.ok) {
    throw new Error(`详情请求失败(${res.status})`);
  }

  const json = (await res.json()) as BookApiResponse;
  if (json.status !== "ok" && json.message) {
    throw new Error(String(json.message));
  }

  return buildComicDetail(json, comicId, domainGroup.img, payload.extern);
}

function buildComicDetail(
  json: BookApiResponse,
  comicId: string,
  baseImg: string,
  ext: Record<string, unknown> | null | undefined,
) {
  const info = json.book?.info ?? ({} as BookApiInfo);
  const title = String(info.Bookname ?? "").trim() || `漫画 #${comicId}`;
  const coverUrl = comicId ? `${baseImg}/${comicId}/m1.webp` : "";
  const author = String(info.Author ?? "").trim();
  const isAdult = info.Adult === 1;
  const isFinished = info.Status === 0;
  const statusText = isFinished ? "短篇" : "连载中";
  const description = String(info.Description ?? "").trim();
  const tagList = [info.Ptag, info.Otag].filter(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  );
  const typeList = String(info.Ptag ?? "")
    .split(/[,，、]/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // Build chapters from categories
  const categories = json.chapters?.categories ?? [];
  const chapterData = json.chapters?.data ?? {};
  let orderCount = 1;
  const eps = categories
    .flatMap((category) => {
      const categoryId = String(category.id ?? "");
      const categoryName = String(category.name ?? "").trim();
      const chapters =
        chapterData[categoryId] ?? chapterData[String(category.id)] ?? [];
      if (!Array.isArray(chapters)) return [];

      return chapters.map((chapter, chapterIndex) => {
        const id = String(chapter.id ?? "").trim();
        if (!id) return null;
        const name =
          String(chapter.name ?? "").trim() || `第${chapterIndex + 1}话`;
        const pageCount = toNumber(chapter.count, 0);
        return {
          id,
          requestId: id,
          logicalKey: id,
          storageChapterId: id,
          name: categoryName ? `${categoryName}—${name}` : name,
          order: toNumber(chapter.sort, orderCount++),
          extern: {
            pageCount,
            categoryId,
            categoryName,
            createdAt: toNumber(chapter.created_at, 0),
          },
        };
      });
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.order - b.order);

  const updateText = formatUnixSeconds(info.Time);

  const normal = {
    comicInfo: {
      id: comicId,
      title,
      titleMeta: [
        createActionItem(`状态：${statusText || "未知"}`),
        createActionItem(`更新时间：${updateText || "未知"}`),
        createActionItem(`章节数：${eps.length}`),
      ],
      creator: {
        id: "",
        name: "",
        avatar: createImage({
          id: "",
          url: "",
          name: "",
          path: "",
          extern: {},
        }),
        onTap: {},
        extern: {},
      },
      description,
      cover: createImage({
        id: comicId,
        url: coverUrl || NOT_FOUND_IMAGE_URL,
        name: `${comicId}.webp`,
        path: `comic/${comicId}/cover.webp`,
        extern: {},
      }),
      metadata: [
        createMetadataActionList(
          "author",
          "作者",
          author ? [author] : [],
          (item) =>
            createActionItem(item, {
              type: "openSearch",
              payload: { keyword: item },
            }),
        ),
        createMetadataActionList(
          "categories",
          "分类",
          typeList,
          (item) =>
            createActionItem(item, {
              type: "openSearch",
              payload: { keyword: item },
            }),
        ),
        createMetadataActionList(
          "tags",
          "标签",
          tagList,
          (item) =>
            createActionItem(item, {
              type: "openSearch",
              payload: { keyword: item },
            }),
        ),
      ].filter((meta) => {
        const value = toStringMap(meta).value;
        return Array.isArray(value) && value.length > 0;
      }),
      extern: {},
    },
    eps,
    recommend: [],
    totalViews: toNumber(info.Views, 0),
    totalLikes: toNumber(info.Favorites, 0),
    totalComments: toNumber(json.comment?.count, 0),
    isFavourite: false,
    isLiked: false,
    allowComments: false,
    allowLike: false,
    allowCollected: false,
    allowDownload: true,
    extern: {},
  };

  const scheme = {
    version: "1.0.0",
    type: "comicDetail",
    source: PLUGIN_ID,
  };

  return {
    source: PLUGIN_ID,
    comicId,
    extern: ext ?? null,
    scheme,
    data: {
      normal,
      raw: json,
    },
  };
}

// -- Chapter (no API call, just construct image URLs) --

async function getChapter(payload: ChapterPayload = {}) {
  const extern = toStringMap(payload.extern);
  const comicId = String(payload.comicId ?? extern.comicId ?? "").trim();
  const chapterId = String(payload.chapterId ?? extern.chapterId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");
  if (!chapterId) throw new Error("chapterId 不能为空");

  // We need the page count from extern, or fetch detail to get it
  const pageCount = toNumber(extern.pageCount, 0);
  const chapterName =
    String(extern.chapterName ?? "").trim() || `章节 ${chapterId}`;

  const base = await getDomainGroup();
  const pages = Array.from({ length: Math.max(1, pageCount || 1) }, (_, i) => {
    const page = i + 1;
    const name = `${page}.webp`;
    const path = `comic/${comicId}/${chapterId}/${page}.webp`;
    const url = `${base.img}/${comicId}/${chapterId}/${page}.webp`;
    return {
      id: `${chapterId}-${page}`,
      name,
      path,
      url,
      extern: { index: page },
    };
  });

  const chapter = {
    epId: chapterId,
    epName: chapterName,
    length: pages.length,
    epPages: String(pages.length),
    docs: pages,
    series: [],
  };

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: PLUGIN_ID,
    },
    data: { chapter },
    chapter,
  };
}

// -- Read snapshot --

async function getReadSnapshot(payload: ReadSnapshotPayload = {}) {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");

  const detail = await getComicDetail({ comicId, extern: payload.extern });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const comicInfo = toStringMap(normal.comicInfo);
  const eps = (Array.isArray(normal.eps) ? normal.eps : [])
    .map((item) => toStringMap(item))
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      requestId: String(item.requestId ?? item.id ?? "").trim(),
      logicalKey: String(item.logicalKey ?? item.id ?? "").trim(),
      storageChapterId: String(item.storageChapterId ?? item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
      order: toNumber(item.order, 0),
      extern: toStringMap(item.extern),
    }))
    .filter((item) => item.id);

  // Pick target chapter
  const chapterIdInput = String(payload.chapterId ?? "").trim();
  const externInput = toStringMap(payload.extern);
  const orderFromExtern = toNumber(externInput.order, 0);

  const targetChapter =
    eps.find((item) => item.id === chapterIdInput) ??
    (orderFromExtern > 0
      ? eps.find((item) => item.order === orderFromExtern)
      : undefined) ??
    eps[0];

  if (!targetChapter) {
    throw new Error("未找到可阅读章节");
  }

  const base = await getDomainGroup();
  const pageCount = toNumber(targetChapter.extern.pageCount, 1);
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, i) => {
    const page = i + 1;
    const name = `${page}.webp`;
    const path = `comic/${comicId}/${targetChapter.id}/${page}.webp`;
    const url = `${base.img}/${comicId}/${targetChapter.id}/${page}.webp`;
    return {
      id: `${targetChapter.id}-${page}`,
      name,
      path,
      url,
      extern: { index: page },
    };
  });

  const chapters = eps.map((item) => ({
    id: item.id,
    requestId: item.requestId,
    logicalKey: item.logicalKey,
    storageChapterId: item.storageChapterId,
    name: item.name,
    order: item.order,
    extern: item.extern,
  }));

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: String(comicInfo.id ?? comicId),
        source: PLUGIN_ID,
        title: String(comicInfo.title ?? ""),
        description: String(comicInfo.description ?? ""),
        cover: {
          ...toStringMap(comicInfo.cover),
          extern: toStringMap(toStringMap(comicInfo.cover).extern),
        },
        creator: {
          ...toStringMap(comicInfo.creator),
          avatar: {
            ...toStringMap(toStringMap(comicInfo.creator).avatar),
            extern: toStringMap(
              toStringMap(toStringMap(comicInfo.creator).avatar).extern,
            ),
          },
          extern: toStringMap(toStringMap(comicInfo.creator).extern),
        },
        titleMeta: Array.isArray(comicInfo.titleMeta)
          ? comicInfo.titleMeta
          : [],
        metadata: Array.isArray(comicInfo.metadata) ? comicInfo.metadata : [],
        extern: toStringMap(comicInfo.extern),
      },
      chapter: {
        id: targetChapter.id,
        requestId: targetChapter.requestId,
        logicalKey: targetChapter.logicalKey,
        storageChapterId: targetChapter.storageChapterId,
        name: targetChapter.name,
        order: targetChapter.order,
        pages,
        extern: targetChapter.extern,
      },
      chapters,
    },
  };
}

// -- Fetch image --

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
}: FetchImagePayload = {}) {
  const targetUrl = String(url).trim();
  if (!targetUrl) {
    throw new Error("url 不能为空");
  }

  const base = await getDomainGroup();
  const requestHeaders = getDefaultHeadersSync();
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const resolvedTimeout = Math.max(0, Number(timeoutMs) || 30000);
  const timer = controller
    ? setTimeout(() => controller.abort(), resolvedTimeout)
    : undefined;

  let response: Response;
  try {
    response = await wretch(targetUrl)
      .headers({
        ...requestHeaders,
        Referer: `${base.api}/`,
        Origin: base.api,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      })
      .options({ signal: controller?.signal })
      .get()
      .res();
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`图片请求失败(${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    throw new Error("图片数据为空");
  }

  return bytes;
}

// -- Settings --

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const [account, password] = await Promise.all([
    loadAuthAccount(),
    loadAuthPassword(),
  ]);

  const domainGroup = await readConfigValue(DOMAIN_GROUP_CONFIG_KEY, "2");
  const allowAdult = await readConfigValue(ALLOW_ADULT_CONFIG_KEY, "both");

  const data = {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        {
          id: "account",
          title: "账号",
          fields: [
            {
              key: AUTH_ACCOUNT_CONFIG_KEY,
              kind: "text",
              label: "用户名",
              fnPath: "setAccountAndLogin",
            },
            {
              key: AUTH_PASSWORD_CONFIG_KEY,
              kind: "password",
              label: "密码",
              fnPath: "setPasswordAndLogin",
            },
          ],
        },
        {
          id: "network",
          title: "网络",
          fields: [
            {
              key: DOMAIN_GROUP_CONFIG_KEY,
              kind: "choice",
              label: "线路",
              fnPath: "setDomainGroup",
              options: [
                { label: "主线路", value: "2" },
                { label: "备用", value: "1" },
              ],
            },
          ],
        },
        {
          id: "search",
          title: "搜索",
          fields: [
            {
              key: ALLOW_ADULT_CONFIG_KEY,
              kind: "choice",
              label: "年龄限制",
              fnPath: "setAllowAdult",
              options: [
                { label: "所有", value: "both" },
                { label: "仅全年龄", value: "false" },
                { label: "仅限制级", value: "true" },
              ],
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      values: {
        [AUTH_ACCOUNT_CONFIG_KEY]: account,
        [AUTH_PASSWORD_CONFIG_KEY]: password,
        [DOMAIN_GROUP_CONFIG_KEY]: domainGroup,
        [ALLOW_ADULT_CONFIG_KEY]: allowAdult,
      },
    },
  };

  return data as SettingsBundleContract;
}

// -- Init --

async function init() {
  if (!noyInitStarted) {
    noyInitStarted = true;
    await loadCookieStore();
    try {
      const [account, password] = await Promise.all([
        loadAuthAccount(),
        loadAuthPassword(),
      ]);
      if (account && String(password).trim()) {
        await loginWithPassword({
          account,
          password,
          reason: "init",
          persistCredentials: true,
        });
        console.info("[noy.init] login success");
      } else {
        console.info("[noy.init] skip login: no credentials");
      }
    } catch (error) {
      console.warn("[noy.init] login failed", error);
    }
  }

  return {
    source: PLUGIN_ID,
    data: { ok: true, started: true },
  };
}

async function getInfo() {
  return buildPluginInfo();
}

export default {
  init,
  getInfo,
  loginWithPassword,
  setAccountAndLogin,
  setPasswordAndLogin,
  setDomainGroup,
  setAllowAdult,
  searchComic,
  getComicDetail,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getSettingsBundle,
};
