import type { InfoContract } from "breeze-plugin-kit";
import { PLUGIN_ID } from "./common";

export function buildPluginInfo(): InfoContract {
  return {
    name: "NoyAcg",
    uuid: PLUGIN_ID,
    iconUrl:
      "https://raw.githubusercontent.com/deretame/Breeze-plugin-NoyAcg/main/assets/ic_launcher_foreground.webp",
    creator: {
      name: "",
      describe: "",
    },
    describe: "NoyAcg 插件",
    version: "0.0.5",
    home: "https://github.com/deretame/Breeze-plugin-NoyAcg",
    updateUrl:
      "https://api.github.com/repos/deretame/Breeze-plugin-NoyAcg/releases/latest",
    npmName: "breeze-plugin-noy-acg",
    function: [
      {
        id: "ranking",
        title: "排行榜",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "排行榜",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getRankingData",
                  core: {},
                  extern: {
                    leaderboard: "read",
                    rankType: "day",
                  },
                },
              },
              filter: {
                fnPath: "getRankingFilterBundle",
                extern: {
                  ranking: "read-day",
                },
              },
            },
          },
        },
      },
      {
        id: "categories",
        title: "分类",
        action: {
          type: "openPluginFunction",
          payload: {
            id: "categories",
            title: "分类",
            presentation: "page",
          },
        },
      },
      {
        id: "latest",
        title: "最新",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "最新",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getLatestData",
                  core: {},
                  extern: {
                    sort: "",
                    finished: "",
                    random: false,
                  },
                },
              },
              filter: {
                fnPath: "getLatestFilterBundle",
                core: {},
                extern: {},
              },
            },
          },
        },
      },
      {
        id: "cloudFavorite",
        title: "云端收藏",
        action: {
          type: "openCloudFavorite",
          payload: {
            title: "云端收藏",
          },
        },
      },
      {
        id: "tagRecommendations",
        title: "标签推荐",
        action: {
          type: "openPluginFunction",
          payload: {
            id: "tagRecommendations",
            title: "标签推荐",
            presentation: "dialog",
          },
        },
      },
    ],
  };
}

export function buildManifestInfo(): InfoContract {
  return buildPluginInfo();
}
