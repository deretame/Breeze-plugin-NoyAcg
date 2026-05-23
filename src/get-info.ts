import { PLUGIN_ID } from "./common";

export function buildPluginInfo() {
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
    version: "0.0.2",
    home: "https://github.com/deretame/Breeze-plugin-NoyAcg",
    updateUrl:
      "https://api.github.com/repos/deretame/Breeze-plugin-NoyAcg/releases/latest",
    npmName: "breeze-plugin-noy-acg",
    function: [],
  };
}

export function buildManifestInfo() {
  return buildPluginInfo();
}
