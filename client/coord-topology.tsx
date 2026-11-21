import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";

import type { CoordBoardDetail, SubCard } from "../shared/radar";
import { statusLabelForLocale, useRadarI18n } from "./i18n";
import { shortModelName, statusColor } from "./radar-card";

type CoordWave = CoordBoardDetail["waves"][number];

interface NodePoint {
  x: number;
  y: number;
}

interface WebWheelEventLike {
  deltaY: number;
  ctrlKey: boolean;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface WebPointerEventLike {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  target: {
    closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null;
  } | null;
}

interface WebMouseEventLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface WebDomElementLike {
  getBoundingClientRect: () => { left: number; top: number };
  setAttribute?: (name: string, value: string) => void;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  addEventListener: (type: string, listener: (e: never) => void, options?: boolean | { passive?: boolean }) => void;
  removeEventListener: (type: string, listener: (e: never) => void, options?: boolean | { passive?: boolean }) => void;
}

function bindWebAttrRef(attrs: Record<string, string | undefined>) {
  if (Platform.OS !== "web") return undefined;
  return (node: unknown) => {
    const el = node as { setAttribute?: (name: string, value: string) => void } | null;
    if (!el || typeof el.setAttribute !== "function") return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) el.setAttribute(k, v);
    }
  };
}

const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

function getUpstreamIds(subcard: SubCard): string[] {
  const ids = new Set<string>(subcard.refCards);
  if (subcard.waitMode === "board" && subcard.waitBoard) {
    for (const target of subcard.waitBoard.targets) {
      ids.add(target.cardId);
    }
  }
  return Array.from(ids);
}

function subcardToneColor(subcard: SubCard, theme: PluginTheme): string {
  const { colors } = theme;
  if (subcard.canceled) return colors.foregroundMuted;
  if (subcard.status === "archived") return colors.statusSuccess;
  return statusColor(subcard.status, theme);
}

/**
 * Orders nodes within each wave by the average Y index of their upstream dependencies
 * so dependency edges cross as little as possible when auto-layout runs.
 */
function orderWavesBarycenter(waves: CoordWave[], subcards: SubCard[]): CoordWave[] {
  const subMap = new Map(subcards.map((s) => [s.id, s]));
  const rowIndexMap = new Map<string, number>();

  return waves.map((waveCol, colIdx) => {
    const ids = [...waveCol.subcardIds];
    if (colIdx > 0 && ids.length > 1) {
      ids.sort((a, b) => {
        const score = (id: string): number => {
          const sub = subMap.get(id);
          if (!sub) return Number.MAX_SAFE_INTEGER;
          const ups = getUpstreamIds(sub)
            .map((upId) => rowIndexMap.get(upId))
            .filter((idx): idx is number => idx !== undefined);
          if (ups.length === 0) return Number.MAX_SAFE_INTEGER;
          return ups.reduce((sum, idx) => sum + idx, 0) / ups.length;
        };
        const sa = score(a);
        const sb = score(b);
        if (sa !== sb) return sa - sb;
        return a.localeCompare(b, undefined, { numeric: true });
      });
    }
    ids.forEach((id, idx) => rowIndexMap.set(id, idx));
    return { ...waveCol, subcardIds: ids };
  });
}

interface TransformState {
  scale: number;
  x: number;
  y: number;
}

interface TopologyCanvasProps {
  waves: CoordWave[];
  subcards: SubCard[];
  customPositions: Record<string, NodePoint>;
  autoLayoutSignal: number;
  selectedSubcard: SubCard | null;
  selectedUpstreamSet: Set<string>;
  selectedDownstreamSet: Set<string>;
  compact: boolean;
  theme: PluginTheme;
  viewportHeight?: number;
  fillHeight?: boolean;
  expanded: boolean;
  onMoveNode: (id: string, point: NodePoint) => void;
  onAutoLayout: () => void;
  onToggleExpand?: () => void;
  onSelectNode: (id: string) => void;
}

function ToolbarIconButton({
  icon,
  label,
  title,
  theme,
  active,
  onPress,
}: {
  icon?: string;
  label?: string;
  title?: string;
  theme: PluginTheme;
  active?: boolean;
  onPress: () => void;
}) {
  const { colors } = theme;
  return (
    <Pressable
      ref={bindWebAttrRef({ title })}
      accessibilityRole="button"
      accessibilityLabel={title ?? label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: label ? 8 : 6,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.surface2 : colors.surface0,
        ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : {}),
      }}
    >
      {icon ? <Icon name={icon} size={13} color={active ? colors.accent : colors.foreground} /> : null}
      {label ? (
        <Text
          style={{
            color: active ? colors.accent : colors.foreground,
            fontSize: 11.5,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

function InteractiveTopologyCanvas({
  waves,
  subcards,
  customPositions,
  autoLayoutSignal,
  selectedSubcard,
  selectedUpstreamSet,
  selectedDownstreamSet,
  compact,
  theme,
  viewportHeight,
  fillHeight = false,
  expanded,
  onMoveNode,
  onAutoLayout,
  onToggleExpand,
  onSelectNode,
}: TopologyCanvasProps) {
  const { t, isZh } = useRadarI18n();
  const { colors } = theme;

  const nodeW = compact ? 186 : 214;
  const nodeH = 88;
  const colGap = compact ? 52 : 68;
  const rowGap = 16;
  const padX = 24;
  const padY = 20;
  const headerH = 28;

  const hasCustomPositions = Object.keys(customPositions).length > 0;

  const layout = useMemo(() => {
    const orderedWaves = orderWavesBarycenter(waves, subcards);
    const maxRows = Math.max(1, ...orderedWaves.map((w) => w.subcardIds.length));
    const baseW = padX * 2 + orderedWaves.length * nodeW + Math.max(0, orderedWaves.length - 1) * colGap;
    const baseH = padY * 2 + headerH + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap;

    const posMap = new Map<string, { x: number; y: number; wave: number }>();
    orderedWaves.forEach((waveCol, colIdx) => {
      const colX = padX + colIdx * (nodeW + colGap);
      waveCol.subcardIds.forEach((sid, rowIdx) => {
        const custom = customPositions[sid];
        posMap.set(sid, {
          x: custom ? custom.x : colX,
          y: custom ? custom.y : padY + headerH + rowIdx * (nodeH + rowGap),
          wave: waveCol.wave,
        });
      });
    });

    // Compute dynamic bounding box so dragged nodes & SVG edges never get clipped
    let minX = 0;
    let minY = 0;
    let maxX = baseW;
    let maxY = baseH;
    for (const pos of posMap.values()) {
      minX = Math.min(minX, pos.x - padX);
      minY = Math.min(minY, pos.y - padY);
      maxX = Math.max(maxX, pos.x + nodeW + padX);
      maxY = Math.max(maxY, pos.y + nodeH + padY);
    }

    interface EdgeItem {
      key: string;
      d: string;
      x1: number;
      y1: number;
      kind: "up" | "down" | "default";
      dashed: boolean;
    }
    const edges: EdgeItem[] = [];
    for (const sub of subcards) {
      const to = posMap.get(sub.id);
      if (!to) continue;
      const watchSet = new Set(
        sub.waitMode === "board" && sub.waitBoard
          ? sub.waitBoard.targets.map((wt) => wt.cardId)
          : [],
      );
      for (const upId of getUpstreamIds(sub)) {
        const from = posMap.get(upId);
        if (!from) continue;
        let d: string;
        let x1: number;
        let y1: number;
        if (from.x + nodeW <= to.x + 12) {
          x1 = from.x + nodeW;
          y1 = from.y + nodeH / 2;
          const x2 = to.x - 5;
          const y2 = to.y + nodeH / 2;
          const dx = Math.max(26, (x2 - x1) * 0.5);
          d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        } else if (Math.abs(from.x - to.x) < nodeW * 0.6) {
          x1 = from.x + nodeW;
          y1 = from.y + nodeH / 2;
          const x2 = to.x + nodeW + 4;
          const y2 = to.y + nodeH / 2;
          const arc = 26;
          d = `M ${x1} ${y1} C ${x1 + arc} ${y1}, ${x2 + arc} ${y2}, ${x2} ${y2}`;
        } else {
          x1 = from.x;
          y1 = from.y + nodeH / 2;
          const x2 = to.x + nodeW + 5;
          const y2 = to.y + nodeH / 2;
          const midY = Math.min(y1, y2) - 34;
          d = `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${midY}, ${x2} ${y2}`;
        }
        const kind: EdgeItem["kind"] =
          selectedSubcard?.id === sub.id
            ? "up"
            : selectedSubcard?.id === upId
              ? "down"
              : "default";
        edges.push({
          key: `${upId}->${sub.id}`,
          d,
          x1,
          y1,
          kind,
          dashed: watchSet.has(upId) && !sub.refCards.includes(upId),
        });
      }
    }

    const sortedEdges = [
      ...edges.filter((e) => e.kind === "default"),
      ...edges.filter((e) => e.kind !== "default"),
    ];

    return {
      orderedWaves,
      baseW,
      baseH,
      bounds: {
        minX,
        minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      posMap,
      sortedEdges,
    };
  }, [waves, subcards, customPositions, nodeW, colGap, selectedSubcard?.id]);

  const [viewport, setViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<TransformState>({ scale: 1, x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<"none" | "canvas" | "node">("none");

  const transformRef = useRef(transform);
  transformRef.current = transform;

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const posMapRef = useRef(layout.posMap);
  posMapRef.current = layout.posMap;

  const onMoveNodeRef = useRef(onMoveNode);
  onMoveNodeRef.current = onMoveNode;

  const hasAutoFittedRef = useRef(false);
  const suppressNextPressRef = useRef(false);
  const containerDomRef = useRef<unknown>(null);

  const computeFitTransform = useCallback(
    (vp: { width: number; height: number }): TransformState => {
      if (vp.width <= 0 || vp.height <= 0) return { scale: 1, x: 0, y: 0 };
      const margin = 24;
      const availW = Math.max(120, vp.width - margin * 2);
      const availH = Math.max(120, vp.height - margin * 2);
      const { minX, minY, width, height } = layout.bounds;
      const fitScale = clampScale(Math.min(availW / width, availH / height, 1));
      const x = Math.round((vp.width - width * fitScale) / 2 - minX * fitScale);
      const y = Math.round((vp.height - height * fitScale) / 2 - minY * fitScale);
      return { scale: fitScale, x, y };
    },
    [layout.bounds],
  );

  const handleFitView = useCallback(() => {
    setTransform(computeFitTransform(viewportRef.current));
  }, [computeFitTransform]);

  const handleResetView = useCallback(() => {
    const vp = viewportRef.current;
    if (vp.width <= 0 || vp.height <= 0) {
      setTransform({ scale: 1, x: 0, y: 0 });
      return;
    }
    const { minX, minY, width, height } = layout.bounds;
    const x = Math.round((vp.width - width) / 2 - minX);
    const y = Math.round((vp.height - height) / 2 - minY);
    setTransform({ scale: 1, x: Math.max(16 - minX, x), y: Math.max(16 - minY, y) });
  }, [layout.bounds]);

  const zoomAtCenter = useCallback((factor: number) => {
    const vp = viewportRef.current;
    const cx = vp.width > 0 ? vp.width / 2 : 300;
    const cy = vp.height > 0 ? vp.height / 2 : 200;
    setTransform((prev) => {
      const nextScale = clampScale(prev.scale * factor);
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      };
    });
  }, []);

  // Auto-fit once when viewport is first measured
  useEffect(() => {
    if (viewport.width > 0 && viewport.height > 0 && !hasAutoFittedRef.current) {
      hasAutoFittedRef.current = true;
      setTransform(computeFitTransform(viewport));
    }
  }, [viewport, computeFitTransform]);

  // Re-fit when user triggers Auto Layout
  const lastAutoSignalRef = useRef(autoLayoutSignal);
  useEffect(() => {
    if (autoLayoutSignal !== lastAutoSignalRef.current) {
      lastAutoSignalRef.current = autoLayoutSignal;
      if (viewportRef.current.width > 0 && viewportRef.current.height > 0) {
        setTransform(computeFitTransform(viewportRef.current));
      }
    }
  }, [autoLayoutSignal, computeFitTransform]);

  // Web wheel zoom & pointer pan / node drag
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = containerDomRef.current as WebDomElementLike | null;
    if (!el || typeof el.addEventListener !== "function") return;

    const handleWheel = (e: WebWheelEventLike) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const clampedDelta = Math.max(-120, Math.min(120, e.deltaY));
      const intensity = e.ctrlKey ? 0.012 : 0.0022;
      const factor = Math.exp(-clampedDelta * intensity);

      setTransform((prev) => {
        const nextScale = clampScale(prev.scale * factor);
        const ratio = nextScale / prev.scale;
        return {
          scale: nextScale,
          x: px - (px - prev.x) * ratio,
          y: py - (py - prev.y) * ratio,
        };
      });
    };

    let dragState:
      | {
          kind: "canvas";
          pointerId: number;
          startX: number;
          startY: number;
          originX: number;
          originY: number;
          moved: boolean;
        }
      | {
          kind: "node";
          nodeId: string;
          pointerId: number;
          startX: number;
          startY: number;
          originNodeX: number;
          originNodeY: number;
          moved: boolean;
        }
      | null = null;

    const win = globalThis as unknown as {
      addEventListener?: (type: string, listener: (e: never) => void, options?: boolean) => void;
      removeEventListener?: (type: string, listener: (e: never) => void, options?: boolean) => void;
    };

    const handlePointerDown = (e: WebPointerEventLike) => {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.target?.closest?.("[data-topo-controls='true']")) return;

      const nodeHit = e.button === 0 ? e.target?.closest?.("[data-topo-node]") : null;
      const nodeId = nodeHit?.getAttribute?.("data-topo-node") ?? null;
      const nodePos = nodeId ? posMapRef.current.get(nodeId) : null;

      if (nodeId && nodePos) {
        dragState = {
          kind: "node",
          nodeId,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originNodeX: nodePos.x,
          originNodeY: nodePos.y,
          moved: false,
        };
      } else {
        dragState = {
          kind: "canvas",
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          originX: transformRef.current.x,
          originY: transformRef.current.y,
          moved: false,
        };
      }
    };

    const handlePointerMove = (e: WebPointerEventLike) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) > 4) {
        dragState.moved = true;
        setDragMode(dragState.kind);
      }
      if (dragState.moved) {
        if (dragState.kind === "node") {
          const scale = transformRef.current.scale || 1;
          const nextX = Math.round(dragState.originNodeX + dx / scale);
          const nextY = Math.round(dragState.originNodeY + dy / scale);
          onMoveNodeRef.current(dragState.nodeId, { x: nextX, y: nextY });
        } else {
          const nextX = dragState.originX + dx;
          const nextY = dragState.originY + dy;
          setTransform((prev) => ({
            ...prev,
            x: nextX,
            y: nextY,
          }));
        }
      }
    };

    const finishDrag = (e: WebPointerEventLike) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      if (dragState.moved) {
        suppressNextPressRef.current = true;
        setTimeout(() => {
          suppressNextPressRef.current = false;
        }, 80);
      }
      dragState = null;
      setDragMode("none");
    };

    const handleClickCapture = (e: WebMouseEventLike) => {
      if (suppressNextPressRef.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextPressRef.current = false;
      }
    };

    el.addEventListener("wheel", handleWheel as (e: never) => void, { passive: false });
    el.addEventListener("pointerdown", handlePointerDown as (e: never) => void);
    win.addEventListener?.("pointermove", handlePointerMove as (e: never) => void);
    win.addEventListener?.("pointerup", finishDrag as (e: never) => void);
    win.addEventListener?.("pointercancel", finishDrag as (e: never) => void);
    el.addEventListener("click", handleClickCapture as (e: never) => void, true);

    return () => {
      el.removeEventListener("wheel", handleWheel as (e: never) => void);
      el.removeEventListener("pointerdown", handlePointerDown as (e: never) => void);
      win.removeEventListener?.("pointermove", handlePointerMove as (e: never) => void);
      win.removeEventListener?.("pointerup", finishDrag as (e: never) => void);
      win.removeEventListener?.("pointercancel", finishDrag as (e: never) => void);
      el.removeEventListener("click", handleClickCapture as (e: never) => void, true);
    };
  }, []);

  // Native PanResponder fallback for iOS/Android
  const nativePanOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panResponder = useMemo(
    () =>
      Platform.OS === "web"
        ? null
        : PanResponder.create({
            onMoveShouldSetPanResponder: (_, gesture) =>
              Math.hypot(gesture.dx, gesture.dy) > 5,
            onPanResponderGrant: () => {
              nativePanOriginRef.current = {
                x: transformRef.current.x,
                y: transformRef.current.y,
              };
              setDragMode("canvas");
            },
            onPanResponderMove: (_, gesture) => {
              const nextX = nativePanOriginRef.current.x + gesture.dx;
              const nextY = nativePanOriginRef.current.y + gesture.dy;
              setTransform((prev) => ({
                ...prev,
                x: nextX,
                y: nextY,
              }));
            },
            onPanResponderRelease: () => setDragMode("none"),
            onPanResponderTerminate: () => setDragMode("none"),
          }),
    [],
  );

  const scalePercent = `${Math.round(transform.scale * 100)}%`;

  const webGridBackground =
    Platform.OS === "web"
      ? ({
          backgroundImage: `radial-gradient(${colors.border} 1px, transparent 1px)`,
          backgroundSize: `${Math.max(12, 22 * transform.scale)}px ${Math.max(12, 22 * transform.scale)}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
          cursor: dragMode !== "none" ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",
        } as object)
      : undefined;

  return (
    <View
      ref={(node) => {
        containerDomRef.current = node;
      }}
      {...(panResponder ? panResponder.panHandlers : {})}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setViewport((prev) =>
          Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
            ? prev
            : { width, height },
        );
      }}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        ...(fillHeight ? { flex: 1, minHeight: 280 } : { height: viewportHeight ?? (compact ? 380 : 520) }),
        ...(webGridBackground ?? {}),
      }}
    >
      {/* Transformed Canvas Layer */}
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: layout.baseW,
          height: layout.baseH,
          transformOrigin: "0 0",
          transform: [
            { translateX: transform.x },
            { translateY: transform.y },
            { scale: transform.scale },
          ],
        }}
      >
        {Platform.OS === "web"
          ? createElement(
              "svg",
              {
                width: layout.bounds.width,
                height: layout.bounds.height,
                viewBox: `${layout.bounds.minX} ${layout.bounds.minY} ${layout.bounds.width} ${layout.bounds.height}`,
                style: {
                  position: "absolute",
                  top: layout.bounds.minY,
                  left: layout.bounds.minX,
                  pointerEvents: "none",
                  overflow: "visible",
                },
              },
              createElement(
                "defs",
                null,
                createElement(
                  "marker",
                  {
                    id: expanded ? "coord-arrow-default-lg" : "coord-arrow-default",
                    markerWidth: 7,
                    markerHeight: 7,
                    refX: 5,
                    refY: 3.5,
                    orient: "auto",
                  },
                  createElement("polygon", { points: "0 0, 7 3.5, 0 7", fill: colors.border }),
                ),
                createElement(
                  "marker",
                  {
                    id: expanded ? "coord-arrow-up-lg" : "coord-arrow-up",
                    markerWidth: 7,
                    markerHeight: 7,
                    refX: 5,
                    refY: 3.5,
                    orient: "auto",
                  },
                  createElement("polygon", { points: "0 0, 7 3.5, 0 7", fill: colors.statusSuccess }),
                ),
                createElement(
                  "marker",
                  {
                    id: expanded ? "coord-arrow-down-lg" : "coord-arrow-down",
                    markerWidth: 7,
                    markerHeight: 7,
                    refX: 5,
                    refY: 3.5,
                    orient: "auto",
                  },
                  createElement("polygon", { points: "0 0, 7 3.5, 0 7", fill: colors.statusWarning }),
                ),
              ),
              ...layout.sortedEdges.map((edge) => {
                const stroke =
                  edge.kind === "up"
                    ? colors.statusSuccess
                    : edge.kind === "down"
                      ? colors.statusWarning
                      : colors.border;
                const opacity = edge.kind === "default" ? (selectedSubcard ? 0.45 : 0.85) : 1;
                const markerSuffix = expanded ? "-lg" : "";
                const markerId =
                  edge.kind === "up"
                    ? `url(#coord-arrow-up${markerSuffix})`
                    : edge.kind === "down"
                      ? `url(#coord-arrow-down${markerSuffix})`
                      : `url(#coord-arrow-default${markerSuffix})`;
                return createElement(
                  "g",
                  { key: edge.key, opacity },
                  createElement("path", {
                    d: edge.d,
                    fill: "none",
                    stroke,
                    strokeWidth: edge.kind === "default" ? 1.5 : 2.2,
                    strokeDasharray: edge.dashed ? "4 3" : undefined,
                    markerEnd: markerId,
                  }),
                  createElement("circle", {
                    cx: edge.x1,
                    cy: edge.y1,
                    r: edge.kind === "default" ? 2.5 : 3,
                    fill: stroke,
                  }),
                );
              }),
            )
          : null}

        {/* Wave Column Headers */}
        {layout.orderedWaves.map((waveCol, colIdx) => (
          <View
            key={`wh-${waveCol.wave}`}
            style={{
              position: "absolute",
              left: padX + colIdx * (nodeW + colGap),
              top: padY,
              width: nodeW,
              height: headerH - 4,
              justifyContent: "center",
              opacity: hasCustomPositions ? 0.35 : 1,
            }}
          >
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
              {t("coord.waveLabel", { wave: waveCol.wave })} ({waveCol.subcardIds.length})
            </Text>
          </View>
        ))}

        {/* Interactive SubCard Nodes */}
        {subcards.map((sub) => {
          const pos = layout.posMap.get(sub.id);
          if (!pos) return null;
          const sid = sub.id;
          const isSelected = selectedSubcard?.id === sid;
          const isUpstream = selectedUpstreamSet.has(sid);
          const isDownstream = selectedDownstreamSet.has(sid);
          const nodeBorder = isSelected
            ? colors.accent
            : isUpstream
              ? colors.statusSuccess
              : isDownstream
                ? colors.statusWarning
                : colors.border;
          const tone = subcardToneColor(sub, theme);
          return (
            <Pressable
              key={sid}
              ref={bindWebAttrRef({ "data-topo-node": sid })}
              accessibilityRole="button"
              onPress={() => {
                if (suppressNextPressRef.current) return;
                onSelectNode(sid);
              }}
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: nodeW,
                height: nodeH,
                padding: 9,
                borderRadius: 8,
                borderWidth: isSelected || isUpstream || isDownstream ? 1.5 : 1,
                borderColor: nodeBorder,
                backgroundColor: isSelected ? colors.surface2 : colors.surface0,
                justifyContent: "space-between",
                ...(Platform.OS === "web" ? ({ cursor: dragMode === "node" ? "grabbing" : "grab" } as object) : {}),
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone }} />
                  <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>{sub.id}</Text>
                  {isUpstream ? (
                    <View style={{ paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surface1 }}>
                      <Text style={{ color: colors.statusSuccess, fontSize: 9.5, fontWeight: "700" }}>
                        {t("coord.upstreamBadge")}
                      </Text>
                    </View>
                  ) : isDownstream ? (
                    <View style={{ paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surface1 }}>
                      <Text style={{ color: colors.statusWarning, fontSize: 9.5, fontWeight: "700" }}>
                        {t("coord.downstreamBadge")}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={{ color: tone, fontSize: 10.5, fontWeight: "600" }}>
                  {sub.canceled ? (isZh ? "已取消" : "Canceled") : statusLabelForLocale(sub.status, isZh)}
                </Text>
              </View>
              <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "500", lineHeight: 16 }} numberOfLines={2}>
                {sub.title}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, flex: 1 }} numberOfLines={1}>
                  {sub.isolation === "worktree" ? t("coord.isolationWorktree") : t("coord.isolationReadonly")}
                  {sub.selectedModel ? ` · ${shortModelName(sub.selectedModel)}` : ""}
                  {sub.gitBranch ? ` · ${sub.gitBranch}` : ""}
                </Text>
                {sub.artifacts.length > 0 ? (
                  <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: "600" }}>
                    {sub.artifacts.length}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Bottom-left Interaction Hint */}
      {Platform.OS === "web" && !compact ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 12,
            bottom: 10,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: colors.surface0,
            borderWidth: 1,
            borderColor: colors.border,
            opacity: 0.88,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("coord.topoHint")}</Text>
        </View>
      ) : null}

      {/* Bottom-right Zoom, Auto Layout & Window Controls */}
      <View
        ref={bindWebAttrRef({ "data-topo-controls": "true" })}
        style={{
          position: "absolute",
          right: 12,
          bottom: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          padding: 4,
          borderRadius: 8,
          backgroundColor: colors.surface0,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <ToolbarIconButton
          icon="LayoutGrid"
          label={compact ? undefined : t("coord.topoAutoLayout")}
          title={t("coord.topoAutoLayout")}
          theme={theme}
          active={hasCustomPositions}
          onPress={onAutoLayout}
        />
        <ToolbarIconButton
          icon="Minus"
          title={t("coord.topoZoomOut")}
          theme={theme}
          onPress={() => zoomAtCenter(1 / 1.2)}
        />
        <ToolbarIconButton
          label={scalePercent}
          title={t("coord.topoReset")}
          theme={theme}
          onPress={handleResetView}
        />
        <ToolbarIconButton
          icon="Plus"
          title={t("coord.topoZoomIn")}
          theme={theme}
          onPress={() => zoomAtCenter(1.2)}
        />
        <ToolbarIconButton
          icon="Maximize"
          label={compact ? undefined : t("coord.topoFit")}
          title={t("coord.topoFit")}
          theme={theme}
          onPress={handleFitView}
        />
        {onToggleExpand ? (
          <ToolbarIconButton
            icon={expanded ? "Minimize2" : "Maximize2"}
            label={compact ? undefined : expanded ? t("coord.topoCollapse") : t("coord.topoExpand")}
            title={expanded ? t("coord.topoCollapse") : t("coord.topoExpand")}
            theme={theme}
            active={expanded}
            onPress={onToggleExpand}
          />
        ) : null}
      </View>
    </View>
  );
}

export function TopologyLegend({ theme }: { theme: PluginTheme }) {
  const { t } = useRadarI18n();
  const { colors } = theme;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 10, height: 10, borderRadius: 3, borderWidth: 1.5, borderColor: colors.accent }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>{t("coord.legendSelected")}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 10, height: 10, borderRadius: 3, borderWidth: 1.5, borderColor: colors.statusSuccess }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>{t("coord.legendUpstream")}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <View style={{ width: 10, height: 10, borderRadius: 3, borderWidth: 1.5, borderColor: colors.statusWarning }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>{t("coord.legendDownstream")}</Text>
      </View>
    </View>
  );
}

export interface CoordTopologySectionProps {
  title: string;
  waves: CoordWave[];
  subcards: SubCard[];
  selectedSubcard: SubCard | null;
  selectedUpstreamSet: Set<string>;
  selectedDownstreamSet: Set<string>;
  compact: boolean;
  theme: PluginTheme;
  onSelectNode: (id: string) => void;
  renderInspector: (subcard: SubCard) => ReactNode;
}

export function CoordTopologySection({
  title,
  waves,
  subcards,
  selectedSubcard,
  selectedUpstreamSet,
  selectedDownstreamSet,
  compact,
  theme,
  onSelectNode,
  renderInspector,
}: CoordTopologySectionProps) {
  const { t } = useRadarI18n();
  const { colors } = theme;
  const [expanded, setExpanded] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [customPositions, setCustomPositions] = useState<Record<string, NodePoint>>({});
  const [autoLayoutSignal, setAutoLayoutSignal] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "web" || !expanded) return;
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: { key?: string }) => void) => void;
      removeEventListener?: (type: string, fn: (e: { key?: string }) => void) => void;
    };
    const onKeyDown = (e: { key?: string }) => {
      if (e.key === "Escape") {
        setExpanded(false);
      }
    };
    win.addEventListener?.("keydown", onKeyDown);
    return () => win.removeEventListener?.("keydown", onKeyDown);
  }, [expanded]);

  const handleSelectNode = useCallback(
    (id: string) => {
      onSelectNode(id);
      setInspectorVisible(true);
    },
    [onSelectNode],
  );

  const handleMoveNode = useCallback((id: string, point: NodePoint) => {
    setCustomPositions((prev) => ({ ...prev, [id]: point }));
  }, []);

  const handleAutoLayout = useCallback(() => {
    setCustomPositions({});
    setAutoLayoutSignal((n) => n + 1);
  }, []);

  const expandedBody = (
    <View style={{ flex: 1, flexDirection: compact ? "column" : "row", gap: 12, padding: 12 }}>
      <InteractiveTopologyCanvas
        waves={waves}
        subcards={subcards}
        customPositions={customPositions}
        autoLayoutSignal={autoLayoutSignal}
        selectedSubcard={selectedSubcard}
        selectedUpstreamSet={selectedUpstreamSet}
        selectedDownstreamSet={selectedDownstreamSet}
        compact={compact}
        theme={theme}
        fillHeight
        expanded
        onMoveNode={handleMoveNode}
        onAutoLayout={handleAutoLayout}
        onToggleExpand={() => setExpanded(false)}
        onSelectNode={handleSelectNode}
      />
      {selectedSubcard && inspectorVisible ? (
        <View
          style={{
            width: compact ? "100%" : 360,
            maxHeight: compact ? "42%" : undefined,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "700" }} numberOfLines={1}>
              {selectedSubcard.id}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setInspectorVisible(false)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 6,
                paddingVertical: 3,
                borderRadius: 6,
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : {}),
              }}
            >
              <Icon name="X" size={13} color={colors.foregroundMuted} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("coord.topoHideInspector")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
            {renderInspector(selectedSubcard)}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ gap: 12 }}>
      {/* Legend + Quick Actions */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <TopologyLegend theme={theme} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <ToolbarIconButton
            icon="LayoutGrid"
            label={t("coord.topoAutoLayout")}
            title={t("coord.topoAutoLayout")}
            theme={theme}
            active={Object.keys(customPositions).length > 0}
            onPress={handleAutoLayout}
          />
          <ToolbarIconButton
            icon="Maximize2"
            label={t("coord.topoExpand")}
            title={t("coord.topoExpand")}
            theme={theme}
            onPress={() => setExpanded(true)}
          />
        </View>
      </View>

      {/* Inline Interactive Canvas */}
      <InteractiveTopologyCanvas
        waves={waves}
        subcards={subcards}
        customPositions={customPositions}
        autoLayoutSignal={autoLayoutSignal}
        selectedSubcard={selectedSubcard}
        selectedUpstreamSet={selectedUpstreamSet}
        selectedDownstreamSet={selectedDownstreamSet}
        compact={compact}
        theme={theme}
        expanded={false}
        onMoveNode={handleMoveNode}
        onAutoLayout={handleAutoLayout}
        onToggleExpand={() => setExpanded(true)}
        onSelectNode={handleSelectNode}
      />

      {/* Inline Selected Node Inspector */}
      {selectedSubcard ? (
        <View
          style={{
            padding: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
            gap: 10,
          }}
        >
          {renderInspector(selectedSubcard)}
        </View>
      ) : (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12.5 }}>{t("coord.inspectorEmpty")}</Text>
      )}

      {/* Large Window Overlay */}
      {expanded ? (
        Platform.OS === "web" ? (
          <View
            style={{
              position: "fixed" as unknown as "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9999,
              backgroundColor: "rgba(0, 0, 0, 0.62)",
              padding: compact ? 8 : 18,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <View
              style={{
                width: "100%",
                height: "100%",
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
                overflow: "hidden",
              }}
            >
              {/* Large Window Header */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 10,
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                  backgroundColor: colors.surface0,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 180 }}>
                  <Icon name="GitBranch" size={16} color={colors.accent} />
                  <Text style={{ color: colors.foreground, fontSize: 14.5, fontWeight: "700" }} numberOfLines={1}>
                    {title} · {t("coord.topoModalTitle")}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  {!compact ? <TopologyLegend theme={theme} /> : null}
                  <ToolbarIconButton
                    icon="X"
                    label={t("coord.topoCollapse")}
                    theme={theme}
                    onPress={() => setExpanded(false)}
                  />
                </View>
              </View>
              {expandedBody}
            </View>
          </View>
        ) : (
          <Modal
            title={`${title} · ${t("coord.topoModalTitle")}`}
            open={expanded}
            onOpenChange={(next) => {
              if (!next) setExpanded(false);
            }}
          >
            <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 0 }}>
              {expandedBody}
            </Modal.Content>
          </Modal>
        )
      ) : null}
    </View>
  );
}
