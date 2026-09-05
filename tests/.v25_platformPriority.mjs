// src/core/platformPriority.ts
var PLATFORM_PRIORITY = ["kuwo", "migu", "netease", "qishui", "kugou", "qq", "bilibili"];
var DISPLAY_PRIORITY = ["qishui", "kuwo", "migu", "netease", "qq", "kugou", "bilibili"];
var PLATFORM_DISPLAY_NAMES = {
  qishui: "\u6C7D\u6C34\u97F3\u4E50",
  kuwo: "\u9177\u6211\u97F3\u4E50",
  migu: "\u54AA\u5495\u97F3\u4E50",
  netease: "\u7F51\u6613\u4E91\u97F3\u4E50",
  qq: "QQ\u97F3\u4E50",
  kugou: "\u9177\u72D7\u97F3\u4E50",
  bilibili: "\u54D4\u54E9\u54D4\u54E9"
};
var PLATFORM_SHORT_NAMES = {
  qishui: "qi",
  kuwo: "kw",
  migu: "mg",
  netease: "wy",
  qq: "qq",
  kugou: "kg",
  bilibili: "bl"
};
var PLATFORM_ABBREVS = PLATFORM_SHORT_NAMES;
var PLATFORM_COLORS = {
  kuwo: "bg-blue-600",
  migu: "bg-amber-700",
  netease: "bg-red-600",
  kugou: "bg-cyan-600",
  qq: "bg-green-600",
  qishui: "bg-purple-600",
  bilibili: "bg-pink-600"
};
function getPriorityRank(sourceId) {
  const idx = PLATFORM_PRIORITY.indexOf(sourceId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
function getDisplayRank(sourceId) {
  const idx = DISPLAY_PRIORITY.indexOf(sourceId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
function isKnownPlatform(sourceId) {
  return PLATFORM_PRIORITY.indexOf(sourceId) !== -1;
}
function pickBestSource(sourceIds) {
  if (sourceIds.length === 0)
    return void 0;
  const sorted = [...sourceIds].sort((a, b) => getPriorityRank(a) - getPriorityRank(b));
  return sorted[0];
}
function sortByPriority(items) {
  return [...items].sort((a, b) => getPriorityRank(a.sourceId) - getPriorityRank(b.sourceId));
}
function sortByDisplayPriority(items) {
  return [...items].sort((a, b) => getDisplayRank(a.sourceId) - getDisplayRank(b.sourceId));
}
function buildFallbackChain(primarySourceId, availableSourceIds) {
  if (primarySourceId === "local")
    return [];
  const candidates = /* @__PURE__ */ new Set();
  if (primarySourceId && primarySourceId !== "local") {
    candidates.add(primarySourceId);
  }
  for (const id of availableSourceIds) {
    if (id && id !== "local") {
      candidates.add(id);
    }
  }
  for (const id of [...candidates]) {
    if (!isKnownPlatform(id))
      candidates.delete(id);
  }
  const ranked = [...candidates].sort((a, b) => getPriorityRank(a) - getPriorityRank(b));
  return ranked;
}
export {
  DISPLAY_PRIORITY,
  PLATFORM_ABBREVS,
  PLATFORM_COLORS,
  PLATFORM_DISPLAY_NAMES,
  PLATFORM_PRIORITY,
  PLATFORM_SHORT_NAMES,
  buildFallbackChain,
  getDisplayRank,
  getPriorityRank,
  isKnownPlatform,
  pickBestSource,
  sortByDisplayPriority,
  sortByPriority
};
