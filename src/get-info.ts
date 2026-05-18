import { PLUGIN_ID } from "./common";

export function buildPluginInfo() {
  return {
    name: "NoyAcg",
    uuid: PLUGIN_ID,
    iconUrl: "https://img.noy.asia/favicon.ico",
    creator: {
      name: "",
      describe: "",
    },
    describe: "NoyAcg / NoyManga 漫画插件",
    version: "0.1.0",
    home: "https://noy.asia",
    updateUrl: "",
    function: [],
  };
}

export function buildManifestInfo() {
  return buildPluginInfo();
}
