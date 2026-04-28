import React, { useMemo } from 'react';
import type { CanvasNode, HeatmapData } from '../state/types';

interface Props {
  nodes: Map<string, CanvasNode>;
  heatmap: HeatmapData;
  panX: number;
  panY: number;
  zoom: number;
}

const MAX_RADIUS = 90;
const MIN_RADIUS = 30;

export default function HeatmapOverlay({ nodes, heatmap, panX, panY, zoom }: Props) {
  const spots = useMemo(() => {
    let maxCount = 0;
    for (const v of heatmap.values()) maxCount = Math.max(maxCount, v);
    if (maxCount === 0) return [];

    return Array.from(heatmap.entries())
      .map(([nodeId, count]) => {
        const node = nodes.get(nodeId);
        if (!node || node.kind === 'edge') return null;
        const cx = (node.x + node.w / 2) * zoom + panX;
        const cy = (node.y + node.h / 2) * zoom + panY;
        const intensity = count / maxCount;
        const r = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * intensity;
        return { cx, cy, r, intensity, count };
      })
      .filter(Boolean) as Array<{ cx: number; cy: number; r: number; intensity: number; count: number }>;
  }, [nodes, heatmap, panX, panY, zoom]);

  if (!spots.length) return null;

  return (
    <svg
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 80 }}
      width="100%" height="100%"
    >
      <defs>
        {spots.map((s, i) => (
          <radialGradient key={i} id={`heat-${i}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#f97316" stopOpacity={0.55 * s.intensity} />
            <stop offset="50%"  stopColor="#ef4444" stopOpacity={0.28 * s.intensity} />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {spots.map((s, i) => (
        <g key={i}>
          <circle cx={s.cx} cy={s.cy} r={s.r} fill={`url(#heat-${i})`} />
          {s.count > 2 && (
            <text x={s.cx} y={s.cy + 4} textAnchor="middle" fontSize={10}
              fill="#ef4444" opacity={0.8} fontWeight={700}>
              {s.count}✎
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
