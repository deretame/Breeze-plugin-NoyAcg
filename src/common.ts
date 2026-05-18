export const PLUGIN_ID = "babe7021-2df8-4abc-bba8-00bbfd7a0f75";
export const NOT_FOUND_IMAGE_URL = "";
export const PLACEHOLDER_IMAGE_PATH = "placeholder/image-404.png";

export function toStringMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function createActionItem(
  name: unknown,
  onTap: Record<string, unknown> = {},
  extern: Record<string, unknown> = {},
) {
  return {
    name: String(name ?? ""),
    onTap,
    extern,
  };
}

export function createImage(
  input: {
    id?: unknown;
    url?: unknown;
    name?: unknown;
    path?: unknown;
    extern?: Record<string, unknown>;
  } = {},
) {
  return {
    id: String(input.id ?? ""),
    url: String(input.url ?? "").trim() || NOT_FOUND_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || PLACEHOLDER_IMAGE_PATH,
    extern: input.extern ?? {},
  };
}

export function createMetadataActionList(
  type: string,
  name: string,
  values: unknown,
  mapItem?: (value: string) => ReturnType<typeof createActionItem>,
) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const normalized = list
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0)
    .map((item) => (mapItem ? mapItem(item) : createActionItem(item)));

  return {
    type,
    name,
    value: normalized,
  };
}

export function createBasicMetadata(
  type: string,
  name: string,
  values: unknown,
) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  return {
    type,
    name,
    value: list.map((item) => String(item ?? "").trim()).filter(Boolean),
  };
}

export function createComicItem(id: string, title: string) {
  const path = `comic/${id}/cover.png`;
  return {
    source: PLUGIN_ID,
    id,
    title,
    subtitle: "这是一个占位漫画条目",
    finished: false,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: "2026-01-01 00:00",
    cover: {
      id,
      url: NOT_FOUND_IMAGE_URL,
      path,
      name: "",
      extern: { path },
    },
    metadata: [
      createBasicMetadata("author", "作者", ["example-author"]),
      createBasicMetadata("categories", "分类", []),
      createBasicMetadata("tags", "标签", ["example", "placeholder"]),
      createBasicMetadata("works", "作品", []),
      createBasicMetadata("actors", "角色", []),
    ],
    raw: {
      id,
      name: title,
      author: "example-author",
      description: "placeholder",
      image: NOT_FOUND_IMAGE_URL,
      category: {
        id: "",
        title: "",
      },
      category_sub: {
        id: null,
        title: null,
      },
      liked: false,
      is_favorite: false,
      update_at: 0,
      likes: 0,
      totalViews: 0,
      tags: ["example", "placeholder"],
      works: [],
      actors: [],
      related_list: [],
    },
    extern: {},
  };
}

export function createPaging(page = 1, total = 1) {
  return {
    page,
    pages: Math.max(1, total),
    total,
    hasReachedMax: true,
  };
}

type FieldKind =
  | "text"
  | "password"
  | "switch"
  | "select"
  | "choice"
  | "multiChoice";

type BaseField = {
  key: string;
  kind: FieldKind;
  label: string;
  fnPath?: string;
  persist?: boolean;
};

type OptionField = BaseField & {
  kind: "select" | "choice" | "multiChoice";
  options?: Array<{ label: string; value: unknown }>;
};

type PlainField = BaseField & {
  kind: "text" | "password" | "switch";
};

type SettingsField = OptionField | PlainField;

export type SettingsBundleContract = {
  source: string;
  scheme: {
    version: "1.0.0";
    type: "settings";
    sections: Array<{
      id: string;
      title: string;
      fields: SettingsField[];
    }>;
  };
  data: {
    canShowUserInfo: boolean;
    values: Record<string, unknown>;
  };
};

type CapabilityAction = {
  key?: string;
  title: string;
  fnPath: string;
};

export type CapabilitiesBundleContract = {
  source: string;
  scheme: {
    version: "1.0.0";
    type: "capabilities";
    actions: CapabilityAction[];
  };
  data: Record<string, unknown>;
};
