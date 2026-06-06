import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js";
import { createElementBounds } from "../utils/create-element-bounds.js";
import { isElementConnected } from "../utils/is-element-connected.js";
import { getTagName } from "../utils/get-tag-name.js";
import type { OverlayBounds } from "../types.js";

interface ElementListItem {
  id: string;
  element: Element;
  label: string;
  description: string;
  kind: "component" | "interactive" | "region" | "content" | "container";
  score: number;
}

interface ElementListPanelProps {
  active?: boolean;
}

type MinimalReactGrabAPI = {
  copyElement?: (elements: Element | Element[]) => Promise<boolean>;
  getDisplayName?: (element: Element) => string | null;
};

const MAX_ITEMS = 80;
const TEXT_PREVIEW_MAX = 72;
const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary"]);
const REGION_TAGS = new Set(["header", "nav", "main", "section", "article", "aside", "footer", "form"]);
const LOW_VALUE_TAGS = new Set([
  "html",
  "body",
  "script",
  "style",
  "link",
  "meta",
  "title",
  "noscript",
  "template",
  "svg",
  "path",
  "defs",
  "g",
  "use",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

const getReactGrabAPI = (): MinimalReactGrabAPI | undefined =>
  (window as typeof window & { __REACT_GRAB__?: MinimalReactGrabAPI }).__REACT_GRAB__;

const clampText = (value: string, max = TEXT_PREVIEW_MAX): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
};

const getElementText = (element: Element): string => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.placeholder || element.value || element.name || element.id || "";
  }
  if (element instanceof HTMLSelectElement) {
    return element.name || element.id || "select";
  }
  const aria = element.getAttribute("aria-label") || element.getAttribute("title") || "";
  if (aria) return aria;
  return element instanceof HTMLElement ? element.innerText || element.textContent || "" : element.textContent || "";
};

const getElementRole = (element: Element): string | null => {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "a") return "link";
  if (tagName === "button") return "button";
  if (tagName === "input") return (element as HTMLInputElement).type || "input";
  if (REGION_TAGS.has(tagName)) return tagName;
  return null;
};

const isVisibleElement = (element: Element): boolean => {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
  if (element.closest("[data-react-grab]")) return false;
  if (!isElementConnected(element)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > window.innerHeight * 3) return false;

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }
  return true;
};

const classifyElement = (
  element: Element,
  componentName: string | null,
): ElementListItem["kind"] => {
  const tagName = element.tagName.toLowerCase();
  const role = getElementRole(element);
  if (componentName) return "component";
  if (INTERACTIVE_TAGS.has(tagName) || role === "button" || role === "link") return "interactive";
  if (REGION_TAGS.has(tagName) || role === "region" || role === "navigation") return "region";
  const text = clampText(getElementText(element));
  if (text.length > 0) return "content";
  return "container";
};

const scoreElement = (element: Element, componentName: string | null): number => {
  const tagName = element.tagName.toLowerCase();
  const role = getElementRole(element);
  const text = clampText(getElementText(element));
  const rect = element.getBoundingClientRect();
  let score = 0;

  if (componentName) score += 80;
  if (INTERACTIVE_TAGS.has(tagName)) score += 60;
  if (REGION_TAGS.has(tagName)) score += 45;
  if (role) score += 20;
  if (text) score += Math.min(28, text.length / 2);
  if (element.id) score += 12;
  if (element.getAttribute("data-testid")) score += 12;
  if (rect.width >= 40 && rect.height >= 24) score += 8;
  if (tagName === "div" || tagName === "span") score -= 12;
  if (tagName === "span" && !componentName) score -= 16;
  if (rect.width < 20 || rect.height < 16) score -= 30;

  return score;
};

const makeElementItem = (element: Element, index: number): ElementListItem | null => {
  const tagName = element.tagName.toLowerCase();
  if (LOW_VALUE_TAGS.has(tagName)) return null;
  if (!isVisibleElement(element)) return null;

  const api = getReactGrabAPI();
  const componentName = api?.getDisplayName?.(element) ?? null;
  const textPreview = clampText(getElementText(element));
  const role = getElementRole(element);
  const kind = classifyElement(element, componentName);
  const score = scoreElement(element, componentName);

  if (score < 12) return null;

  const primaryLabel = componentName || textPreview || role || tagName;
  const label = componentName && textPreview ? `${componentName} · ${textPreview}` : primaryLabel;
  const descriptionParts = [role || tagName];
  if (element.id) descriptionParts.push(`#${element.id}`);
  if (element.getAttribute("data-testid")) {
    descriptionParts.push(`[${element.getAttribute("data-testid")}]`);
  }

  return {
    id: `${tagName}-${index}`,
    element,
    label,
    description: descriptionParts.join(" · "),
    kind,
    score,
  };
};

const buildElementList = (): ElementListItem[] => {
  if (!document.body) return [];
  const rawElements = Array.from(document.body.querySelectorAll("*"));
  const items = rawElements.map(makeElementItem).filter((item): item is ElementListItem => item !== null);
  const seen = new Set<string>();

  return items
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const rect = item.element.getBoundingClientRect();
      const signature = `${item.label}|${Math.round(rect.x / 4)}|${Math.round(rect.y / 4)}|${Math.round(rect.width / 4)}|${Math.round(rect.height / 4)}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    })
    .slice(0, MAX_ITEMS);
};

const matchesQuery = (item: ElementListItem, query: string): boolean => {
  if (!query) return true;
  const haystack = [item.label, item.description, item.kind, item.element.getAttribute("class") || ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
};

const kindLabel = (kind: ElementListItem["kind"]): string => {
  if (kind === "interactive") return "Action";
  if (kind === "component") return "Component";
  if (kind === "region") return "Region";
  if (kind === "content") return "Content";
  return "Container";
};

export const ElementListPanel: Component<ElementListPanelProps> = (props) => {
  const [items, setItems] = createSignal<ElementListItem[]>([]);
  const [query, setQuery] = createSignal("");
  const [selectedElement, setSelectedElement] = createSignal<Element | null>(null);
  const [selectedBounds, setSelectedBounds] = createSignal<OverlayBounds | null>(null);
  const [isCopying, setIsCopying] = createSignal(false);

  const refresh = () => {
    if (!props.active) return;
    setItems(buildElementList());
  };

  const filteredItems = createMemo(() => items().filter((item) => matchesQuery(item, query())));

  const updateSelectedBounds = () => {
    const element = selectedElement();
    if (!element || !isElementConnected(element)) {
      setSelectedElement(null);
      setSelectedBounds(null);
      return;
    }
    setSelectedBounds(createElementBounds(element));
  };

  const selectElement = (element: Element) => {
    setSelectedElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    updateSelectedBounds();
    window.setTimeout(updateSelectedBounds, 250);
  };

  const copySelectedElement = async () => {
    const element = selectedElement();
    const copyElement = getReactGrabAPI()?.copyElement;
    if (!element || !copyElement) return;
    setIsCopying(true);
    try {
      await copyElement(element);
    } finally {
      setIsCopying(false);
    }
  };

  createEffect(() => {
    if (!props.active) {
      setItems([]);
      setSelectedElement(null);
      setSelectedBounds(null);
      return;
    }
    refresh();
    const refreshTimer = window.setTimeout(refresh, 300);
    const onViewportChange = () => updateSelectedBounds();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    onCleanup(() => {
      window.clearTimeout(refreshTimer);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    });
  });

  return (
    <Show when={props.active}>
      <Show when={selectedBounds()}>
        {(bounds) => (
          <div
            style={{
              position: "fixed",
              left: `${bounds().x}px`,
              top: `${bounds().y}px`,
              width: `${bounds().width}px`,
              height: `${bounds().height}px`,
              "border-radius": bounds().borderRadius,
              border: "2px dashed #22c55e",
              "box-shadow": "0 0 0 99999px rgba(0, 0, 0, 0.04)",
              "pointer-events": "none",
              "z-index": 2147483645,
            }}
          />
        )}
      </Show>
      <aside
        data-react-grab-ignore-events
        style={{
          position: "fixed",
          top: "72px",
          right: "16px",
          width: "320px",
          "max-height": "min(680px, calc(100vh - 96px))",
          display: "flex",
          "flex-direction": "column",
          gap: "10px",
          padding: "12px",
          color: "white",
          background: "rgba(15, 23, 42, 0.94)",
          "backdrop-filter": "blur(16px)",
          border: "1px solid rgba(148, 163, 184, 0.28)",
          "border-radius": "16px",
          "box-shadow": "0 18px 48px rgba(15, 23, 42, 0.36)",
          "pointer-events": "auto",
          "z-index": 2147483646,
          "font-family": "Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
          <div>
            <div style={{ "font-size": "13px", "font-weight": 700 }}>Elements</div>
            <div style={{ "font-size": "11px", color: "rgba(226,232,240,0.72)" }}>
              Search and click to highlight
            </div>
          </div>
          <button
            type="button"
            onClick={refresh}
            style={{
              border: "1px solid rgba(148, 163, 184, 0.32)",
              background: "rgba(30, 41, 59, 0.82)",
              color: "white",
              padding: "6px 8px",
              "border-radius": "10px",
              cursor: "pointer",
              "font-size": "11px",
            }}
          >
            Refresh
          </button>
        </div>
        <input
          data-react-grab-input
          value={query()}
          placeholder="Search text, tag, class, component..."
          onInput={(event) => setQuery(event.currentTarget.value)}
          style={{
            width: "100%",
            "box-sizing": "border-box",
            padding: "9px 10px",
            border: "1px solid rgba(148, 163, 184, 0.34)",
            "border-radius": "10px",
            background: "rgba(15, 23, 42, 0.88)",
            color: "white",
            outline: "none",
            "font-size": "12px",
          }}
        />
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            disabled={!selectedElement() || isCopying()}
            onClick={() => void copySelectedElement()}
            style={{
              flex: 1,
              border: "1px solid rgba(34, 197, 94, 0.42)",
              background: selectedElement() ? "rgba(22, 163, 74, 0.28)" : "rgba(71, 85, 105, 0.42)",
              color: "white",
              padding: "8px 10px",
              "border-radius": "10px",
              cursor: selectedElement() ? "pointer" : "not-allowed",
              "font-size": "12px",
              "font-weight": 700,
            }}
          >
            {isCopying() ? "Copying..." : "Copy selected"}
          </button>
        </div>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
            overflow: "auto",
            "padding-right": "2px",
          }}
        >
          <Show
            when={filteredItems().length > 0}
            fallback={
              <div style={{ padding: "20px 8px", "text-align": "center", color: "rgba(226,232,240,0.64)", "font-size": "12px" }}>
                No matching elements
              </div>
            }
          >
            <For each={filteredItems()}>
              {(item) => {
                const isSelected = createMemo(() => selectedElement() === item.element);
                return (
                  <button
                    type="button"
                    onClick={() => selectElement(item.element)}
                    onMouseEnter={() => setSelectedBounds(createElementBounds(item.element))}
                    style={{
                      display: "block",
                      width: "100%",
                      "text-align": "left",
                      padding: "9px 10px",
                      border: isSelected()
                        ? "1px solid rgba(34, 197, 94, 0.9)"
                        : "1px solid rgba(148, 163, 184, 0.18)",
                      background: isSelected() ? "rgba(34, 197, 94, 0.18)" : "rgba(30, 41, 59, 0.62)",
                      color: "white",
                      "border-radius": "12px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
                      <span style={{ "font-size": "12px", "font-weight": 700, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                        {item.label}
                      </span>
                      <span style={{ "font-size": "10px", color: "rgba(187,247,208,0.82)", "flex-shrink": 0 }}>
                        {kindLabel(item.kind)}
                      </span>
                    </div>
                    <div style={{ "margin-top": "4px", "font-size": "11px", color: "rgba(226,232,240,0.62)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                      {item.description}
                    </div>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </aside>
    </Show>
  );
};
