// Hash routing helpers shared by the shell and pages.
export type PageId = "overview" | "live" | "explorer" | "mppt" | "energy" | "all" | "diagnostics" | "settings";

export function go(page: PageId, q?: Record<string, string>) {
  location.hash = `#/${page}${q ? "?" + new URLSearchParams(q).toString() : ""}`;
}
/** Opens the graph explorer with these channel ids preselected. */
export function openInExplorer(ids: string[], range?: string) {
  go("explorer", { s: ids.join(","), ...(range ? { r: range } : {}) });
}
