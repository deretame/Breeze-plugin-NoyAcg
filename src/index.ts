import type {
  AdvancedSearchContract,
  ChapterContentContract,
  ChapterWithPages,
  ComicDetailContract,
  ComicListSceneBundleContract,
  ComicPagedListContract,
  CommentFeedContract,
  CommentItem,
  CommentRepliesContract,
  FilterBundleContract,
  FunctionPageActionGridItem,
  FunctionPageChipItem,
  FunctionPageContract,
  ReadSnapshotContract,
  SearchResultContract,
  ToggleFavoriteResult,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import { cache, flutterTools, pluginConfig } from "breeze-plugin-kit";
import {
  createActionItem,
  createBasicMetadata,
  createImage,
  createMetadataActionList,
  NOT_FOUND_IMAGE_URL,
  PLACEHOLDER_IMAGE_PATH,
  PLUGIN_ID,
  SettingsBundleContract,
  toStringMap,
} from "./common";
import { buildPluginInfo } from "./get-info";
import {
  BASE_GROUPS,
  clearStoredCookies,
  DOMAIN_GROUP_CONFIG_KEY,
  getDomainGroup,
  getResponseJson,
  noyApi,
  requireApiPayloadString,
  saveCookieStore,
  setAutoLoginHandler,
  type RawApiPayload,
  type RawApiResult,
} from "./request";

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
  taskGroupKey?: string;
  extern?: Record<string, unknown>;
};

type LoginPayload = {
  account?: string;
  password?: string;
  reason?: string;
  persistCredentials?: boolean;
};

const AUTH_ACCOUNT_CONFIG_KEY = "auth.account";
const AUTH_PASSWORD_CONFIG_KEY = "auth.password";
const ALLOW_ADULT_CONFIG_KEY = "search.allowAdult";
const AUTH_CREDENTIALS_REQUIRED_ERROR =
  "[AUTH_CREDENTIALS_REQUIRED] 账号或密码不能为空，请先在设置中填写";

let loginInFlight: Promise<string> | null = null;
let noyInitStarted = false;

async function persistConfigValue(key: string, value: string) {
  await Promise.all([cache.set(key, value), saveConfigString(key, value)]);
}

async function readConfigValue(key: string, fallback: string): Promise<string> {
  return await loadAndNormalizeConfigString(key, fallback);
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

    const res = await noyApi.post(
      `${base.api}/api/login`,
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        skipAuthRetry: true,
      },
    );

    if (res.status < 200 || res.status >= 300) {
      flutterTools.showToast({
        message: `登录请求失败(${res.status})`,
        level: "error",
      });
      throw new Error(`登录请求失败(${res.status})`);
    }

    const json = getResponseJson(res.data) ?? {};
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
  await clearStoredCookies();
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

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return fallback;
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

setAutoLoginHandler(tryAutoLogin);

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
              payload: { keyword: item, extern: { mode: "author" } },
            }),
        ),
        createBasicMetadata("status", "状态", [statusText]),
        createBasicMetadata("categories", "分类", []),
        createMetadataActionList("tags", "标签", tagList, (item) =>
          createActionItem(item, {
            type: "openSearch",
            payload: { keyword: item, extern: { mode: "tag" } },
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
      version: "1.0.0" as const,
      type: "searchResult" as const,
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { paging, items },
    paging,
    items,
  };
}

// -- Search --

type SearchAdvancedValues = {
  mode: "default" | "tag" | "author";
  sort: "time" | "views" | "favorites" | "rating";
  finished: "" | "false" | "true";
};

function readSearchAdvancedValues(
  payload: Record<string, unknown>,
  extern: Record<string, unknown>,
): SearchAdvancedValues {
  const read = (key: string, fallback: string) => {
    const value = String(extern[key] ?? payload[key] ?? fallback).trim();
    return value || fallback;
  };

  const mode = read("mode", "default");
  const sort = read("sort", "time");
  const finished = read("finished", "");

  return {
    mode: ["default", "tag", "author"].includes(mode)
      ? (mode as SearchAdvancedValues["mode"])
      : "default",
    sort: ["time", "views", "favorites", "rating"].includes(sort)
      ? (sort as SearchAdvancedValues["sort"])
      : "time",
    finished: ["", "false", "true"].includes(finished)
      ? (finished as SearchAdvancedValues["finished"])
      : "",
  };
}

async function getAdvancedSearchScheme(
  payload: RawApiPayload = {},
): Promise<AdvancedSearchContract> {
  const payloadMap = toStringMap(payload);
  const extern = toStringMap(payload.extern);
  const values = readSearchAdvancedValues(payloadMap, extern);

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "advancedSearch" as const,
      title: "高级搜索",
      fields: [
        {
          key: "mode",
          kind: "choice" as const,
          label: "搜索模式",
          options: [
            { label: "综合", value: "default" },
            { label: "标签", value: "tag" },
            { label: "作者", value: "author" },
          ],
        },
        {
          key: "sort",
          kind: "choice" as const,
          label: "排序方式",
          options: [
            { label: "最新", value: "time" },
            { label: "阅读数", value: "views" },
            { label: "收藏数", value: "favorites" },
            { label: "评分", value: "rating" },
          ],
        },
        {
          key: "finished",
          kind: "choice" as const,
          label: "完结状态",
          options: [
            { label: "全部", value: "" },
            { label: "连载中", value: "false" },
            { label: "已完结", value: "true" },
          ],
        },
      ],
    },
    data: { values },
  };
}

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

async function searchComic(
  payload: SearchPayload = {},
): Promise<SearchResultContract> {
  const payloadMap = toStringMap(payload);
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  if (!keyword) {
    throw new Error("keyword 不能为空");
  }

  const advancedValues = readSearchAdvancedValues(payloadMap, extern);

  const formData = new URLSearchParams({
    value: keyword,
    mode: advancedValues.mode,
    sort: advancedValues.sort,
    type: "book",
    finished: advancedValues.finished,
    page: String(page),
  });

  const domainGroup = await getDomainGroup();
  const res = await noyApi.post(
    `${domainGroup.api}/api/v4/search/fetch`,
    formData.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    },
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`搜索请求失败(${res.status})`);
  }

  const json = getResponseJson(res.data) ?? {};
  if (json.status !== "ok") {
    throw new Error(String(json.message ?? "搜索失败"));
  }

  return buildSearchResult(json, page, domainGroup.img, {
    ...extern,
    ...advancedValues,
    type: "book",
  });
}

// -- Detail --

type BookApiInfo = {
  Bid?: number;
  Bookname?: string;
  Author?: string;
  Description?: string;
  Len: number;
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
  F?: boolean;
  f?: boolean;
  is_favorite?: boolean;
  favorite?: boolean;
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

async function getComicDetail(
  payload: ComicDetailPayload = {},
): Promise<ComicDetailContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const domainGroup = await getDomainGroup();
  const res = await noyApi.get(`${domainGroup.api}/api/v4/book/${comicId}`);

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`详情请求失败(${res.status})`);
  }

  const json = (getResponseJson(res.data) ?? {}) as BookApiResponse;
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
  const isFavourite = toBoolean(
    info.F ?? info.f ?? info.is_favorite ?? info.favorite,
  );
  const statusText = isFinished ? "短篇" : "连载中";
  const description = String(info.Description ?? "").trim();
  const originList = String(info.Otag ?? "")
    .split(/ +/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const roleList = String(info.Pname ?? "")
    .split(/ +/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const typeList = String(info.Ptag ?? "")
    .split(/ +/g)
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
          order: orderCount++,
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

  if (eps.length === 0) {
    eps.push({
      id: "noChapterInfo",
      requestId: "noChapterInfo",
      logicalKey: "noChapterInfo",
      storageChapterId: "noChapterInfo",
      name: "第一章",
      order: 1,
      extern: {
        pageCount: Math.max(1, toNumber(info.Len, 1)),
        categoryId: "",
        categoryName: "",
        createdAt: 0,
      },
    });
  }

  const updateText = formatUnixSeconds(info.Time);

  const normal = {
    comicInfo: {
      id: comicId,
      title,
      titleMeta: [
        createActionItem(`状态：${statusText || "未知"}`),
        createActionItem(`更新时间：${updateText || "未知"}`),
        createActionItem(`章节数：${eps.length}`),
        createActionItem(`页数：${info.Len}`),
        createActionItem(`观看量：${info.Views || 0}`),
        createActionItem(`评分：${((info?.RatingSUM ?? 0) / 2).toFixed(1)}`),
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
        path: `cover.webp`,
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
              payload: { keyword: item, extern: { mode: "author" } },
            }),
        ),
        createMetadataActionList("categories", "分类", typeList, (item) =>
          createActionItem(item, {
            type: "openSearch",
            payload: { keyword: item, extern: { mode: "tag" } },
          }),
        ),
        createMetadataActionList("roles", "角色", roleList, (item) =>
          createActionItem(item, {
            type: "openSearch",
            payload: { keyword: item, extern: { mode: "tag" } },
          }),
        ),
        createMetadataActionList("origins", "原作", originList, (item) =>
          createActionItem(item, {
            type: "openSearch",
            payload: { keyword: item, extern: { mode: "tag" } },
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
    isFavourite,
    isLiked: false,
    allowComments: true,
    allowLike: false,
    allowCollected: true,
    allowDownload: true,
    extern: {},
  };

  const scheme = {
    version: "1.0.0" as const,
    type: "comicDetail" as const,
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

async function getChapter(
  payload: ChapterPayload = {},
): Promise<ChapterContentContract> {
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
  const chapterSegment = chapterId === "noChapterInfo" ? "" : `/${chapterId}`;
  const pages = Array.from({ length: Math.max(1, pageCount || 1) }, (_, i) => {
    const page = i + 1;
    const name = `${page}.webp`;
    const path = `comic/${comicId}${chapterSegment}/${page}.webp`;
    const url = `${base.img}/${comicId}${chapterSegment}/${page}.webp`;
    return {
      id: `${chapterId}-${page}`,
      name,
      path,
      url,
      extern: { index: page },
    };
  });

  const chapter: ChapterWithPages = {
    id: chapterId,
    requestId: "",
    logicalKey: "",
    storageChapterId: "",
    name: chapterName,
    order: Number(chapterId),
    pages,
    extern: {},
  };

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0" as const,
      type: "chapterContent" as const,
      source: PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: chapterName,
        extern: {},
      },
      chapter,
      chapters: [],
    },
  };
}

// -- Read snapshot --

async function getReadSnapshot(
  payload: ReadSnapshotPayload = {},
): Promise<ReadSnapshotContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");

  const detail = await getComicDetail({ comicId, extern: payload.extern });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const comicInfo = toStringMap(normal.comicInfo);
  let epsOrder = 1;
  const eps = (Array.isArray(normal.eps) ? normal.eps : [])
    .map((item) => toStringMap(item))
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      requestId: String(item.requestId ?? item.id ?? "").trim(),
      logicalKey: String(item.logicalKey ?? item.id ?? "").trim(),
      storageChapterId: String(item.storageChapterId ?? item.id ?? "").trim(),
      name: String(item.name ?? "").trim(),
      order: epsOrder++,
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
  const chapterSegment =
    targetChapter.id === "noChapterInfo" ? "" : `/${targetChapter.id}`;
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, i) => {
    const page = i + 1;
    const name = `${page}.webp`;
    const path = `${page}.webp`;
    const url = `${base.img}/${comicId}${chapterSegment}/${page}.webp`;
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

  const data = {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: String(comicInfo.id ?? comicId),
        source: PLUGIN_ID,
        title: String(comicInfo.title ?? ""),
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

  return data;
}

// -- Fetch image --

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  taskGroupKey = "",
  extern = {},
}: FetchImagePayload = {}): Promise<Uint8Array<ArrayBufferLike>> {
  const targetUrl = String(url).trim();
  if (!targetUrl) {
    throw new Error("url 不能为空");
  }

  const base = await getDomainGroup();
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const resolvedTimeout = Math.max(0, Number(timeoutMs) || 30000);
  const timer = controller
    ? setTimeout(() => controller.abort(), resolvedTimeout)
    : undefined;

  try {
    const response = await noyApi.get(targetUrl, {
      headers: {
        Referer: `${base.api}/`,
        Origin: base.api,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      responseType: "arraybuffer",
      signal: controller?.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`图片请求失败(${response.status})`);
    }

    const data = response.data;
    const bytes =
      data instanceof Uint8Array
        ? new Uint8Array(data)
        : new Uint8Array(data as ArrayBuffer);
    if (bytes.byteLength === 0) {
      throw new Error("图片数据为空");
    }

    return bytes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -- Noy ACG user/content APIs --

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
};

function createFormBody(payload: RawApiPayload, keys: string[]) {
  const form = new URLSearchParams();
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    form.set(
      key,
      Array.isArray(value)
        ? value.map((item) => String(item ?? "")).join(",")
        : String(value),
    );
  }
  return form.toString();
}

function createApiResult(
  name: string,
  method: "GET" | "POST",
  endpoint: string,
  response: { status: number; data: unknown },
): RawApiResult {
  const data = getResponseJson(response.data) ?? response.data;
  console.info(`[noy.api] ${name} ${method} ${endpoint} response body`, data);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${name}请求失败(${response.status})`);
  }
  return { source: PLUGIN_ID, method, endpoint, status: response.status, data };
}

async function signIn(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v4/signin/sign`;
  const response = await noyApi.post(endpoint, createFormBody(payload, []), {
    headers: FORM_HEADERS,
  });
  const result = createApiResult("签到", "POST", endpoint, response);
  const data = toStringMap(result.data);
  if (Number(data.status) !== 200) {
    throw new Error(String(data.msg ?? data.message ?? "签到失败"));
  }
  return result;
}

async function getSignInRecord(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const query = createFormBody(payload, []);
  const endpoint = `${base.api}/api/v4/signin/record${query ? `?${query}` : ""}`;
  const response = await noyApi.get(endpoint);
  return createApiResult("签到记录", "GET", endpoint, response);
}

function isSignedInToday(value: unknown) {
  const data = toStringMap(value);
  const nested = toStringMap(data.data);
  const today = data.today ?? nested.today;
  if (typeof today === "boolean") return today;
  if (typeof today === "number") return today === 1 || today === 200;
  const normalized = String(today ?? "")
    .trim()
    .toLowerCase();
  return ["true", "1", "yes", "ok", "signed", "signed_in", "已签到"].includes(
    normalized,
  );
}

function waitForSignInRetry() {
  return new Promise<void>((resolve) => setTimeout(resolve, 60_000));
}

async function ensureTodaySignedIn() {
  while (true) {
    try {
      const record = await getSignInRecord();
      if (isSignedInToday(record.data)) {
        console.info("[noy.init] already signed in today");
        return;
      }

      try {
        await signIn();
        console.info("[noy.init] sign-in success");
        try {
          await flutterTools.showToast({
            message: "noyacg 自动签到成功",
            level: "success",
          });
        } catch (error) {
          console.warn("[noy.init] sign-in notification failed", error);
        }
        return;
      } catch (error) {
        console.warn("[noy.init] sign-in failed, retrying in 1 minute", error);
      }
    } catch (error) {
      console.warn(
        "[noy.init] sign-in record check failed, retrying in 1 minute",
        error,
      );
    }

    await waitForSignInRetry();
  }
}

async function getUserInfo(payload: RawApiPayload = {}) {
  const msg =
    payload.msg === true ||
    payload.msg === 1 ||
    String(payload.msg ?? "").toLowerCase() === "true";
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v3/userinfo${msg ? "?msg=true" : ""}`;
  const response = await noyApi.post(endpoint, createFormBody(payload, []), {
    headers: FORM_HEADERS,
  });
  return createApiResult(
    msg ? "用户信息及消息计数" : "用户信息",
    "POST",
    endpoint,
    response,
  );
}

async function getUserInfoWithMsg(payload: RawApiPayload = {}) {
  return getUserInfo({ ...payload, msg: true });
}

async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  const result = await getUserInfoWithMsg();
  const data = toStringMap(result.data);
  const nested = toStringMap(data.data);
  const user = toStringMap(data.userinfo ?? data.userInfo ?? nested.userinfo);
  const read = (...keys: string[]) =>
    keys
      .map((key) => user[key])
      .find((value) => value !== undefined && value !== null);

  const username = String(
    read("Username", "username", "nickname") ?? "",
  ).trim();
  if (!username) {
    const message = String(data.message ?? data.msg ?? "").trim();
    throw new Error(message || "未获取到用户信息，请先完成登录或刷新会话");
  }

  const base = await getDomainGroup();
  const uid = String(read("Uid", "uid", "id") ?? "").trim();
  const avatarPath = String(read("Avatar", "avatar", "avatar_url") ?? "")
    .trim()
    .replace(/^\/+/, "");
  const avatarUrl = avatarPath
    ? /^https?:\/\//i.test(avatarPath)
      ? avatarPath
      : `${base.img}/${avatarPath}`
    : "";
  const msgCount = data.msgCount ?? data.msg_count;
  const email = String(read("Email", "email") ?? "").trim();
  const integral = read("Integral", "integral");
  const commentLen = read("CommentLen", "commentLen", "comment_len");

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "userInfo",
    },
    data: {
      title: "账号",
      avatar: createImage({
        id: uid || username,
        url: avatarUrl,
        name: avatarPath,
        path: avatarPath,
        extern: { uid },
      }),
      lines: [
        username,
        email ? `邮箱：${email}` : "",
        integral !== undefined ? `积分：${integral}` : "",
        commentLen !== undefined ? `评论：${commentLen}` : "",
        msgCount !== undefined ? `未读消息：${msgCount}` : "",
      ].filter(Boolean),
      extern: {
        uid,
      },
    },
  };
}

async function toggleFavorite(
  payload: RawApiPayload = {},
): Promise<ToggleFavoriteResult> {
  const bid = String(payload.comicId ?? payload.bid ?? "").trim();
  if (!bid) throw new Error("作品 ID 不能为空");
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v4/favorites/toggle`;
  const response = await noyApi.post(
    endpoint,
    createFormBody({ ...payload, bid }, ["bid"]),
    { headers: FORM_HEADERS },
  );
  const result = createApiResult("切换收藏", "POST", endpoint, response);
  const data = toStringMap(result.data);
  const status = String(data.status ?? "")
    .trim()
    .toLowerCase();
  if (status && status !== "ok") {
    throw new Error(String(data.message ?? "收藏操作失败"));
  }
  return { favorited: !toBoolean(payload.currentFavorite), nextStep: "none" };
}

async function getFavorites(payload: RawApiPayload = {}) {
  const extern = toStringMap(payload.extern);
  const requestPayload = {
    ...payload,
    page: payload.page ?? 1,
    class: payload.class ?? extern.class ?? "",
    filter: payload.filter ?? extern.filter ?? "",
  };
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v4/favorites/get`;
  const response = await noyApi.post(
    endpoint,
    createFormBody(requestPayload, ["page", "class", "filter"]),
    { headers: FORM_HEADERS },
  );
  return createApiResult("收藏列表", "POST", endpoint, response);
}

async function getFavoriteClasses(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v4/favorites/class/get`;
  const response = await noyApi.post(endpoint, createFormBody(payload, []), {
    headers: FORM_HEADERS,
  });
  return createApiResult("收藏分类", "POST", endpoint, response);
}

function getFavoriteApiItems(response: RawApiResult): unknown[] {
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(nested.data)) return nested.data;
  if (Array.isArray(raw.info)) return raw.info;
  if (Array.isArray(nested.info)) return nested.info;
  return [];
}

async function getFavoriteData(
  payload: RawApiPayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const favoriteClass = String(payload.class ?? extern.class ?? "").trim();
  const filter = String(payload.filter ?? extern.filter ?? "").trim();
  const response = await getFavorites({
    ...payload,
    page,
    class: favoriteClass,
    filter,
  });
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  const rawItems = getFavoriteApiItems(response);
  const items = rawItems
    .map((item, index) =>
      buildRankingItem(item, index, response.endpoint.split("/api/")[0], {
        ranked: false,
      }),
    )
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const total = toNumber(raw.count ?? nested.count, rawItems.length);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: { source: "cloudFavorite", class: favoriteClass, filter },
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { items, hasReachedMax: paging.hasReachedMax },
  };
}

async function getCloudFavoriteFilterBundle(
  payload: RawApiPayload = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  const response = await getFavoriteClasses(payload);
  const raw = toStringMap(response.data);
  const classItems = Array.isArray(raw.data) ? raw.data : [];
  const options = [
    {
      label: "全部",
      value: "",
      result: { extern: { class: "" } },
    },
    ...classItems
      .map((item) => {
        const value = toStringMap(item);
        const id = String(value.id ?? "").trim();
        const name = String(value.name ?? "").trim();
        if (!id || !name) return null;
        return {
          label: name,
          value: id,
          result: { extern: { class: id } },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
  ];

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "favoriteFilter",
      title: "云端收藏筛选",
      fields: [
        {
          key: "class",
          kind: "choice",
          label: "收藏分类",
          options,
        },
      ],
    },
    data: {
      values: {
        class: String(extern.class ?? "").trim(),
      },
    },
  };
}

async function getCloudFavoriteSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: {
        title: "云端收藏",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: {
            fnPath: "getFavoriteData",
            core: {},
            extern: { source: "cloudFavorite", class: "", filter: "" },
          },
        },
        filter: {
          fnPath: "getCloudFavoriteFilterBundle",
          extern: { source: "cloudFavorite" },
        },
      },
    },
  };
}

async function getBookComments(payload: RawApiPayload = {}) {
  const id = requireApiPayloadString(payload, "id", "作品 ID");
  const base = await getDomainGroup();
  const query = createFormBody(payload, ["page"]);
  const endpoint = `${base.api}/api/v4/comment/book/${encodeURIComponent(id)}/comments${query ? `?${query}` : ""}`;
  const response = await noyApi.get(endpoint);
  return createApiResult("漫画评论", "GET", endpoint, response);
}

async function getBookCommentReplies(payload: RawApiPayload = {}) {
  const id = requireApiPayloadString(payload, "id", "作品 ID");
  const cid = requireApiPayloadString(payload, "cid", "评论 ID");
  const base = await getDomainGroup();
  const query = createFormBody(payload, ["page"]);
  const endpoint = `${base.api}/api/v4/comment/book/${encodeURIComponent(id)}/comment/${encodeURIComponent(cid)}/replies${query ? `?${query}` : ""}`;
  const response = await noyApi.get(endpoint);
  return createApiResult("漫画评论回复", "GET", endpoint, response);
}

function formatCommentTime(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const seconds = numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  return formatUnixSeconds(seconds);
}

function buildCommentItem(value: unknown, baseImg: string): CommentItem | null {
  const item = toStringMap(value);
  const id = String(item.cid ?? item.id ?? "").trim();
  const content = String(item.content ?? item.reply ?? "").trim();
  if (!id || !content) return null;

  const user = toStringMap(item.user);
  const avatarPath = String(item.avatar ?? "")
    .trim()
    .replace(/^\/+/, "");
  const avatarUrl = avatarPath
    ? /^https?:\/\//i.test(avatarPath)
      ? avatarPath
      : `${baseImg}/${avatarPath}`
    : "";
  const replies = Array.isArray(item.replies) ? item.replies : [];
  const replyCount = toNumber(
    item.reply_num ?? item.reply_count ?? item.replyCount,
    replies.length,
  );

  return {
    id,
    author: {
      name:
        String(
          item.username ?? user.name ?? item.reply_username ?? "匿名用户",
        ).trim() || "匿名用户",
      avatar: {
        url: avatarUrl,
        path: avatarPath,
      },
    },
    content,
    createdAt: formatCommentTime(item.time ?? item.created_at),
    replyCount,
    replies: [],
    extern: { commentId: id },
  };
}

async function getCommentFeed(
  payload: RawApiPayload = {},
): Promise<CommentFeedContract> {
  const comicId = requireApiPayloadString(payload, "comicId", "作品 ID");
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const response = await getBookComments({ ...payload, id: comicId, page });
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  const comments = Array.isArray(raw.comments)
    ? raw.comments
    : Array.isArray(nested.comments)
      ? nested.comments
      : [];
  const commentData = Array.isArray(raw.comments) ? raw : nested;
  const domainGroup =
    BASE_GROUPS.find((group) => response.endpoint.startsWith(group.api)) ??
    (await getDomainGroup());
  const items = comments
    .map((item) => buildCommentItem(item, domainGroup.img))
    .filter((item): item is CommentItem => item !== null);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "commentFeed",
    },
    data: {
      topItems: [],
      items,
      paging: {
        hasReachedMax: toBoolean(commentData.over, items.length === 0),
      },
      replyMode: "lazy",
      canComment: {
        comic: false,
        reply: false,
      },
    },
  };
}

async function loadCommentReplies(
  payload: RawApiPayload = {},
): Promise<CommentRepliesContract> {
  const comicId = requireApiPayloadString(payload, "comicId", "作品 ID");
  const commentId = requireApiPayloadString(payload, "commentId", "评论 ID");
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const response = await getBookCommentReplies({
    ...payload,
    id: comicId,
    cid: commentId,
    page,
  });
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  const replies = Array.isArray(raw.replies)
    ? raw.replies
    : Array.isArray(nested.replies)
      ? nested.replies
      : [];
  const replyData = Array.isArray(raw.replies) ? raw : nested;
  const domainGroup =
    BASE_GROUPS.find((group) => response.endpoint.startsWith(group.api)) ??
    (await getDomainGroup());
  const items = replies
    .map((item) => buildCommentItem(item, domainGroup.img))
    .filter((item): item is CommentItem => item !== null);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "commentReplies",
    },
    data: {
      commentId,
      items,
      paging: {
        hasReachedMax: toBoolean(replyData.over, items.length === 0),
      },
    },
  };
}

async function getReadLeaderboard(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/readLeaderboard`;
  const response = await noyApi.post(
    endpoint,
    createFormBody(
      { ...payload, page: payload.page ?? 1, type: payload.type ?? "day" },
      ["page", "type"],
    ),
    { headers: FORM_HEADERS },
  );
  return createApiResult("阅读榜", "POST", endpoint, response);
}

async function getFavoriteLeaderboard(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/favLeaderboard`;
  const response = await noyApi.post(
    endpoint,
    createFormBody(
      { ...payload, page: payload.page ?? 1, type: payload.type ?? "day" },
      ["page", "type"],
    ),
    { headers: FORM_HEADERS },
  );
  return createApiResult("收藏榜", "POST", endpoint, response);
}

async function getProportionLeaderboard(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/proportion`;
  const response = await noyApi.post(
    endpoint,
    createFormBody({ ...payload, page: payload.page ?? 1 }, ["page"]),
    { headers: FORM_HEADERS },
  );
  return createApiResult("高质量榜", "POST", endpoint, response);
}

async function getHome(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/home`;
  const response = await noyApi.post(
    endpoint,
    createFormBody(payload, ["v", "stream_all"]),
    { headers: FORM_HEADERS },
  );
  return createApiResult("首页", "POST", endpoint, response);
}

async function getTagList(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/bigtaglist`;
  const response = await noyApi.post(endpoint, createFormBody(payload, []), {
    headers: FORM_HEADERS,
  });
  return createApiResult("分类标签列表", "POST", endpoint, response);
}

async function getLatestBooks(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/b1/booklist`;
  const response = await noyApi.post(
    endpoint,
    createFormBody(
      {
        ...payload,
        page: payload.page ?? 1,
        sort: payload.sort ?? "",
        finished: payload.finished ?? "",
      },
      ["page", "sort", "finished"],
    ),
    { headers: FORM_HEADERS },
  );
  return createApiResult("最新漫画", "POST", endpoint, response);
}

async function getRandomBook(payload: RawApiPayload = {}) {
  const base = await getDomainGroup();
  const endpoint = `${base.api}/api/v4/book/random`;
  const response = await noyApi.post(endpoint);
  return createApiResult("随机漫画", "POST", endpoint, response);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function buildTagSearchChip(
  label: unknown,
  keyword: unknown,
  raw: unknown = {},
): FunctionPageChipItem | null {
  const chipLabel = String(label ?? "").trim();
  const searchKeyword = String(keyword ?? "").trim();
  if (!chipLabel || !searchKeyword) return null;

  return {
    label: chipLabel,
    action: {
      type: "openSearch",
      payload: {
        source: PLUGIN_ID,
        keyword: searchKeyword,
        extern: { mode: "tag" },
      },
    },
    raw: toStringMap(raw),
  };
}

function buildFunctionPage(
  title: string,
  items: FunctionPageChipItem[],
): FunctionPageContract {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "page",
      title,
      body: {
        type: "list",
        children: [{ type: "chip-list", key: "items" }],
      },
    },
    data: {
      items,
      hasReachedMax: true,
    },
  };
}

function buildNavigationPage(
  title: string,
  items: FunctionPageActionGridItem[],
): FunctionPageContract {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "page",
      title,
      body: {
        type: "list",
        children: [{ type: "action-grid", key: "items" }],
      },
    },
    data: {
      items,
      hasReachedMax: true,
    },
  };
}

async function getFunctionPage(
  payload: RawApiPayload = {},
): Promise<FunctionPageContract> {
  const extern = toStringMap(payload.extern);
  const id = String(payload.id ?? extern.id ?? "").trim();

  if (id === "categories") {
    const response = await getTagList(payload);
    const raw = toStringMap(response.data);
    const categoryItems = Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw.info)
        ? raw.info
        : [];
    const responseBase =
      BASE_GROUPS.find((group) => response.endpoint.startsWith(group.api)) ??
      (await getDomainGroup());
    const items = categoryItems
      .map((value): FunctionPageActionGridItem | null => {
        const category = toStringMap(value);
        const tag = String(category.tag ?? category.name ?? "").trim();
        const search = toStringList(category.search);
        const coverId = String(category.cover ?? "").trim();
        const keyword = search.length > 0 ? search.join(" ") : tag;
        if (!tag || !keyword) return null;

        return {
          title: tag,
          cover: {
            url:
              coverId && coverId !== "0"
                ? `${responseBase.img}/${coverId}/m1.webp`
                : NOT_FOUND_IMAGE_URL,
            path: coverId
              ? `comic/${coverId}/cover.webp`
              : PLACEHOLDER_IMAGE_PATH,
            extern: {},
          },
          action: {
            type: "openSearch",
            payload: {
              source: PLUGIN_ID,
              keyword,
              extern: { mode: "tag" },
            },
          },
          raw: category,
        } as FunctionPageActionGridItem;
      })
      .filter((item): item is FunctionPageActionGridItem => item !== null);

    return buildNavigationPage("分类", items);
  }

  if (id === "tagRecommendations") {
    const response = await getHome({
      ...payload,
      v: payload.v ?? "1",
      stream_all: payload.stream_all ?? "1",
    });
    const raw = toStringMap(response.data);
    const nested = toStringMap(raw.data);
    const tags = toStringList(raw.tags ?? nested.tags);
    const items = tags
      .map((tag) => buildTagSearchChip(tag, tag, { tag }))
      .filter((item): item is FunctionPageChipItem => item !== null);

    return buildFunctionPage("标签推荐", items);
  }

  throw new Error(`不支持的功能页面：${id || "未指定"}`);
}

type RankingSource = "read" | "favorite" | "proportion";

function readRankingValue(
  item: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null) return item[key];
  }
  return undefined;
}

function buildRankingItem(
  value: unknown,
  index: number,
  baseImg: string,
  options: { ranked?: boolean } = {},
) {
  const item = toStringMap(value);
  const comicId = String(
    readRankingValue(item, "Bid", "bid", "id", "book_id") ?? "",
  ).trim();
  if (!comicId) return null;

  const title =
    String(
      readRankingValue(item, "Bookname", "bookname", "name", "title") ?? "",
    ).trim() || `漫画 ${comicId}`;
  const author = String(
    readRankingValue(item, "Author", "author") ?? "",
  ).trim();
  const status = Number(readRankingValue(item, "Status", "status"));
  const adult = Number(readRankingValue(item, "Adult", "adult"));
  const views = toNumber(readRankingValue(item, "Views", "views"));
  const favorites = toNumber(readRankingValue(item, "Favorites", "favorites"));
  const rating = toNumber(
    readRankingValue(item, "RatingSUM", "rating_sum", "rating"),
  );
  const isFinished = status === 0;
  const statusText = isFinished ? "短篇" : "连载中";
  const path = `comic/${comicId}/cover.webp`;
  const tags = String(readRankingValue(item, "Ptag", "ptag", "tags") ?? "")
    .split(/\s+/g)
    .map((tag) => tag.trim())
    .filter(Boolean);

  return {
    source: PLUGIN_ID,
    id: comicId,
    title,
    subtitle: [
      options.ranked === false ? "" : `第${index + 1}名`,
      author,
      adult === 1 ? "R18" : "",
      statusText,
      views > 0 ? `${views} 阅读` : "",
      rating > 0 ? `评分 ${(rating / 2).toFixed(1)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    finished: isFinished,
    likesCount: favorites,
    viewsCount: views,
    updatedAt: formatUnixSeconds(readRankingValue(item, "Time", "time")),
    cover: {
      id: comicId,
      url: `${baseImg}/${comicId}/m1.webp`,
      path,
      name: `${comicId}.webp`,
      extern: { path },
    },
    metadata: [
      createMetadataActionList("author", "作者", author ? [author] : []),
      createBasicMetadata("status", "状态", [statusText]),
      createMetadataActionList("tags", "标签", tags),
    ].filter((metadata) => {
      const value = toStringMap(metadata).value;
      return Array.isArray(value) && value.length > 0;
    }),
    raw: item,
    extern: { comicId },
  };
}

async function getLatestData(
  payload: RawApiPayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const sort = String(payload.sort ?? extern.sort ?? "");
  const finished = String(payload.finished ?? extern.finished ?? "");
  const randomValue = payload.random ?? extern.random ?? false;
  const random =
    randomValue === true || String(randomValue).toLowerCase() === "true";
  const response = random
    ? await getRandomBook(payload)
    : await getLatestBooks({ page, sort, finished });
  const responseBase =
    BASE_GROUPS.find((group) => response.endpoint.startsWith(group.api)) ??
    (await getDomainGroup());
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  const rawItems = Array.isArray(raw.info)
    ? raw.info
    : Array.isArray(nested.info)
      ? nested.info
      : Array.isArray(raw.data)
        ? raw.data
        : [];
  const items = rawItems
    .map((item, index) =>
      buildRankingItem(item, index, responseBase.img, { ranked: false }),
    )
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const total = toNumber(raw.len ?? nested.len, rawItems.length);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return {
    source: PLUGIN_ID,
    extern: random ? { random: true } : { sort, finished, random: false },
    scheme: {
      version: "1.0.0",
      type: "latestFeed",
      source: PLUGIN_ID,
    },
    data: {
      items,
      hasReachedMax: random || page >= pageCount || rawItems.length < pageSize,
    },
  };
}

async function getRankingData(
  payload: RawApiPayload = {},
): Promise<ComicPagedListContract> {
  const extern = toStringMap(payload.extern);
  const leaderboardValue = String(
    payload.leaderboard ?? extern.leaderboard ?? "read",
  );
  const leaderboard: RankingSource =
    leaderboardValue === "favorite" || leaderboardValue === "proportion"
      ? leaderboardValue
      : "read";
  const rankTypeValue = String(payload.rankType ?? extern.rankType ?? "day");
  const rankType = ["day", "week", "moon"].includes(rankTypeValue)
    ? rankTypeValue
    : "day";
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const domainGroup = await getDomainGroup();

  let response: RawApiResult;
  if (leaderboard === "favorite") {
    response = await getFavoriteLeaderboard({ page, type: rankType });
  } else if (leaderboard === "proportion") {
    response = await getProportionLeaderboard({ page });
  } else {
    response = await getReadLeaderboard({ page, type: rankType });
  }

  const responseBase =
    BASE_GROUPS.find((group) => response.endpoint.startsWith(group.api)) ??
    domainGroup;
  const raw = toStringMap(response.data);
  const nested = toStringMap(raw.data);
  const rawItems = Array.isArray(raw.info)
    ? raw.info
    : Array.isArray(nested.info)
      ? nested.info
      : Array.isArray(raw.data)
        ? raw.data
        : [];
  const items = rawItems
    .map((item, index) => buildRankingItem(item, index, responseBase.img))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const total = toNumber(raw.len ?? nested.len, rawItems.length);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return {
    source: PLUGIN_ID,
    extern: { leaderboard, rankType },
    scheme: {
      version: "1.0.0",
      type: "rankingFeed",
      source: PLUGIN_ID,
    },
    data: {
      items,
      hasReachedMax: page >= pageCount || rawItems.length < pageSize,
    },
  };
}

async function getRankingFilterBundle(
  _payload: RawApiPayload = {},
): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      fields: [
        {
          key: "ranking",
          kind: "choice",
          label: "榜单与排名模式",
          options: [
            {
              label: "阅读榜",
              value: "read",
              result: { extern: { leaderboard: "read", rankType: "day" } },
              children: [
                {
                  label: "日榜",
                  value: "read-day",
                  result: {
                    extern: { leaderboard: "read", rankType: "day" },
                  },
                },
                {
                  label: "周榜",
                  value: "read-week",
                  result: {
                    extern: { leaderboard: "read", rankType: "week" },
                  },
                },
                {
                  label: "月榜",
                  value: "read-moon",
                  result: {
                    extern: { leaderboard: "read", rankType: "moon" },
                  },
                },
              ],
            },
            {
              label: "收藏榜",
              value: "favorite",
              result: {
                extern: { leaderboard: "favorite", rankType: "day" },
              },
              children: [
                {
                  label: "日榜",
                  value: "favorite-day",
                  result: {
                    extern: { leaderboard: "favorite", rankType: "day" },
                  },
                },
                {
                  label: "周榜",
                  value: "favorite-week",
                  result: {
                    extern: { leaderboard: "favorite", rankType: "week" },
                  },
                },
                {
                  label: "月榜",
                  value: "favorite-moon",
                  result: {
                    extern: { leaderboard: "favorite", rankType: "moon" },
                  },
                },
              ],
            },
            {
              label: "高质量榜",
              value: "proportion",
              result: { extern: { leaderboard: "proportion" } },
            },
          ],
        },
      ],
    },
    data: {
      values: {
        ranking: "read-day",
      },
    },
  };
}

async function getLatestFilterBundle(
  _payload: RawApiPayload = {},
): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "latestFilter",
      title: "筛选最新",
      fields: [
        {
          key: "sort",
          kind: "choice",
          label: "排序",
          options: [
            {
              label: "最新上传",
              value: "",
              result: { extern: { sort: "" } },
            },
            {
              label: "阅读数",
              value: "views",
              result: { extern: { sort: "views" } },
            },
            {
              label: "收藏数",
              value: "favorites",
              result: { extern: { sort: "favorites" } },
            },
            {
              label: "评分",
              value: "rating",
              result: { extern: { sort: "rating" } },
            },
            {
              label: "上传时间",
              value: "upload",
              result: { extern: { sort: "upload" } },
            },
            {
              label: "随机",
              value: "random",
              result: { extern: { sort: "", random: true } },
            },
          ],
        },
        {
          key: "finished",
          kind: "choice",
          label: "完结状态",
          options: [
            {
              label: "全部",
              value: "",
              result: { extern: { finished: "" } },
            },
            {
              label: "连载中",
              value: "false",
              result: { extern: { finished: "false" } },
            },
            {
              label: "已完结",
              value: "true",
              result: { extern: { finished: "true" } },
            },
          ],
        },
      ],
    },
    data: {
      values: {
        sort: "",
        finished: "",
        random: false,
      },
    },
  };
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
      version: "1.0.0" as const,
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
      canShowUserInfo: true,
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
        void ensureTodaySignedIn().catch((error) =>
          console.warn("[noy.init] background sign-in stopped", error),
        );
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

async function getInfo(): Promise<ReturnType<typeof buildPluginInfo>> {
  return buildPluginInfo();
}

export default {
  // 初始化插件并尝试恢复已保存的登录状态。
  init,
  // 返回插件名称、版本和功能元信息。
  getInfo,
  // 保存用户名并重新登录。
  setAccountAndLogin,
  // 保存密码并重新登录。
  setPasswordAndLogin,
  // 切换 API 线路并清理旧线路的 Cookie。
  setDomainGroup,
  // 设置搜索时的年龄限制。
  setAllowAdult,
  // 获取高级搜索表单定义。
  getAdvancedSearchScheme,
  // 按关键词和高级筛选条件搜索漫画。
  searchComic,
  // 获取漫画详情、章节和收藏状态。
  getComicDetail,
  // 根据章节信息生成阅读页面列表。
  getChapter,
  // 获取阅读快照及当前章节信息。
  getReadSnapshot,
  // 下载漫画图片并返回二进制数据。
  fetchImageBytes,
  // 执行每日签到。
  signIn,
  // 获取签到记录。
  getSignInRecord,
  // 获取设置页显示的用户信息卡片。
  getUserInfoBundle,
  // 切换漫画的收藏状态。
  toggleFavorite,
  // 获取格式化后的云端收藏漫画列表。
  getFavoriteData,
  // 获取云端收藏分类筛选器。
  getCloudFavoriteFilterBundle,
  // 获取云端收藏页面定义。
  getCloudFavoriteSceneBundle,
  // 获取格式化后的漫画评论列表。
  getCommentFeed,
  // 获取指定评论的回复列表。
  loadCommentReplies,
  // 获取格式化后的最新漫画列表（包含最新中的随机模式）。
  getLatestData,
  // 获取插件功能页和导航页定义。
  getFunctionPage,
  // 获取格式化后的排行榜列表。
  getRankingData,
  // 获取排行榜筛选器定义。
  getRankingFilterBundle,
  // 获取最新漫画筛选器定义。
  getLatestFilterBundle,
  // 获取插件设置页面定义及当前设置值。
  getSettingsBundle,
};
