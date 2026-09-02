import axios, {
  AxiosHeaders,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { cache, pluginConfig } from "breeze-plugin-kit";

declare module "axios" {
  interface AxiosRequestConfig {
    skipAuthRetry?: boolean;
    authRetried?: boolean;
  }
}

export type BaseApiGroup = {
  api: string;
  img: string;
};

export type RawApiPayload = {
  extern?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RawApiResult = {
  source: string;
  method: "GET" | "POST";
  endpoint: string;
  status: number;
  data: unknown;
};

const AUTH_COOKIES_CONFIG_KEY = "auth.cookies";
export const DOMAIN_GROUP_CONFIG_KEY = "network.domainGroup";
const ALLOW_ADULT_CONFIG_KEY = "search.allowAdult";
export const BASE_GROUPS: BaseApiGroup[] = [
  { api: "https://api.noymanga.com", img: "https://img.noymanga.com" },
  { api: "https://api.noyteam.online", img: "https://img.noyteam.online" },
  { api: "https://api.noy.asia", img: "https://img.noy.asia" },
];
const DEFAULT_DOMAIN_GROUP_INDEX = 0;

let cookieStore = new Map<string, string>();
let cookieStoreLoaded = false;
let autoLoginHandler: ((reason: string) => Promise<unknown>) | null = null;

function decodeConfigString(raw: unknown, fallback = "") {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "object") {
    const map = raw as Record<string, unknown>;
    if (map.ok === true && "value" in map) {
      return decodeConfigString(map.value, fallback);
    }
    return fallback;
  }
  const text = String(raw);
  if (!text.trim()) return fallback;
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
    // Use the raw text when the host stores a plain string.
  }
  return text;
}

async function loadConfigString(key: string, fallback: string) {
  const raw = await pluginConfig.load(key, fallback);
  return decodeConfigString(raw, fallback);
}

export function setAutoLoginHandler(
  handler: (reason: string) => Promise<unknown>,
) {
  autoLoginHandler = handler;
}

export async function getDomainGroup(): Promise<BaseApiGroup> {
  try {
    const raw = await loadConfigString(
      DOMAIN_GROUP_CONFIG_KEY,
      String(DEFAULT_DOMAIN_GROUP_INDEX),
    );
    const index = Number(raw);
    return BASE_GROUPS[
      Number.isInteger(index) && index >= 0 && index < BASE_GROUPS.length
        ? index
        : DEFAULT_DOMAIN_GROUP_INDEX
    ];
  } catch {
    return BASE_GROUPS[DEFAULT_DOMAIN_GROUP_INDEX];
  }
}

export async function clearStoredCookies() {
  cookieStore.clear();
  cookieStoreLoaded = false;
  await saveCookieStore();
}

async function loadCookieStore() {
  if (cookieStoreLoaded) return;
  try {
    const raw = await pluginConfig.load(AUTH_COOKIES_CONFIG_KEY, "{}");
    const obj = JSON.parse(String(raw ?? "{}"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string" && key) cookieStore.set(key, value);
      }
    }
  } catch {
    // Ignore malformed or unavailable cookie storage.
  }
  cookieStoreLoaded = true;
}

export async function saveCookieStore() {
  const obj: Record<string, string> = {};
  for (const [key, value] of cookieStore.entries()) obj[key] = value;
  await pluginConfig.save(AUTH_COOKIES_CONFIG_KEY, JSON.stringify(obj));
}

function getCookieHeader() {
  if (cookieStore.size === 0) return "";
  return [...cookieStore.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function getDefaultHeadersSync() {
  const headers: Record<string, string> = {
    "User-Agent": "NoyAcg/3.0",
    "allow-adult": String(cache.getSync(ALLOW_ADULT_CONFIG_KEY, "both")),
    Accept: "application/json, text/plain, */*",
  };
  const cookie = getCookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function headersToRecord(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  const source = headers as {
    toJSON?: () => unknown;
    [key: string]: unknown;
  };
  const json =
    typeof source.toJSON === "function" ? source.toJSON() : headers;
  if (!json || typeof json !== "object") return {};
  return Object.entries(json).reduce<Record<string, string>>(
    (result, [key, value]) => {
      if (typeof value === "string") result[key] = value;
      return result;
    },
    {},
  );
}

function getHeaderValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== "object") return "";
  const source = headers as {
    get?: (key: string) => unknown;
    [key: string]: unknown;
  };
  const direct =
    typeof source.get === "function" ? source.get(name) : undefined;
  if (direct !== undefined && direct !== null) return String(direct);
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === lowerName,
  );
  return entry?.[1] === undefined || entry?.[1] === null
    ? ""
    : String(entry[1]);
}

function getSetCookieHeaders(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];
  const source = headers as {
    get?: (name: string) => unknown;
    getSetCookie?: () => unknown;
    [key: string]: unknown;
  };
  const fromGetSetCookie =
    typeof source.getSetCookie === "function"
      ? source.getSetCookie()
      : undefined;
  const value =
    fromGetSetCookie ??
    (typeof source.get === "function" ? source.get("set-cookie") : undefined) ??
    source["set-cookie"] ??
    source["Set-Cookie"];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function updateCookiesFromHeaders(headers: unknown) {
  for (const header of getSetCookieHeaders(headers)) {
    const first = header.split(";")[0];
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (name) cookieStore.set(name, value);
  }
}

export function getResponseJson(data: unknown): Record<string, unknown> | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (typeof data !== "string" || !data.trim()) return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isLoginResponse(response: AxiosResponse<unknown>) {
  const contentType = getHeaderValue(response.headers, "content-type");
  return (
    (contentType.includes("json") || getResponseJson(response.data) !== null) &&
    getResponseJson(response.data)?.status === "login"
  );
}

function removeCookieHeader(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== "cookie"),
  );
}

export const noyApi = axios.create({
  validateStatus: () => true,
});

noyApi.interceptors.request.use(async (config) => {
  await loadCookieStore();
  config.headers = AxiosHeaders.from({
    ...getDefaultHeadersSync(),
    ...headersToRecord(config.headers),
  });
  return config;
});

noyApi.interceptors.response.use(async (response) => {
  updateCookiesFromHeaders(response.headers);
  const config = response.config;
  const url = String(config.url ?? "");
  if (
    !config.skipAuthRetry &&
    !config.authRetried &&
    !url.includes("/api/login") &&
    isLoginResponse(response)
  ) {
    if (!autoLoginHandler) return response;
    await autoLoginHandler("api");
    const retryConfig: AxiosRequestConfig = {
      ...config,
      headers: removeCookieHeader(headersToRecord(config.headers)),
      authRetried: true,
    };
    return noyApi.request(retryConfig);
  }
  return response;
});

function appendFormValue(form: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  form.set(
    key,
    Array.isArray(value)
      ? value.map((item) => String(item ?? "")).join(",")
      : String(value),
  );
}

export function getApiPayloadString(
  payload: RawApiPayload,
  key: string,
  fallback = "",
) {
  const value = payload[key];
  return value === undefined || value === null ? fallback : String(value);
}

export function requireApiPayloadString(
  payload: RawApiPayload,
  key: string,
  label = key,
) {
  const value = getApiPayloadString(payload, key).trim();
  if (!value) throw new Error(`${label} 不能为空`);
  return value;
}
