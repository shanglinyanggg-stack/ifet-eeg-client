import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { downsampleTimedValues, smoothAutoScale, type TimedValue } from '../domain/dsp';

export interface WaveformSeries {
  label: string;
  color: string;
  values: TimedValue[];
  scale?: number;
}

export interface SideLabel {
  text: string;
  color: string;
  sub?: string;
}

type CanvasPoint = {
  x: number;
  y: number;
};

interface WaveformCanvasProps {
  title: string;
  series: WaveformSeries[];
  height?: number | string;
  fill?: boolean;
  emptyText?: string;
  /** 频带行模式：左侧固定标签 + 右侧波形，不渲染顶部 header */
  sideLabel?: SideLabel;
  /** 组合图标注位置：legend 顶部图例 / right 曲线末端右侧直接标注 */
  labelAlign?: 'legend' | 'right';
  /** 网格样式：lines 实线网格 / dots 点阵网格（更轻的视觉效果） */
  gridStyle?: 'lines' | 'dots';
}

export function WaveformCanvas({
  title,
  series,
  height = 220,
  fill = false,
  emptyText = '等待数据',
  sideLabel,
  labelAlign = 'legend',
  gridStyle = 'lines'
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 用 ref 持有最新的 series，rAF 节流重绘，避免每个样本触发一次全量绘制
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const labelAlignRef = useRef(labelAlign);
  labelAlignRef.current = labelAlign;
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const drawRef = useRef<() => void>(() => undefined);
  const autoScaleRef = useRef(new Map<string, number>());
  const gridStyleRef = useRef(gridStyle);
  gridStyleRef.current = gridStyle;
  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawRef.current();
    });
  }, []);

  const latestValues = series
    .map((item) => {
      const latest = item.values[item.values.length - 1];
      return latest ? `${item.label} ${formatValue(latest.value)}` : null;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join('  ');

  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

      const current = seriesRef.current;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
      const targetHeight = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const chartBg = readCssVar(canvas, '--chart-bg', '#07111f');
      const chartGrid = readCssVar(canvas, '--chart-grid', 'rgba(148, 179, 190, 0.16)');
      const chartGridStrong = readCssVar(canvas, '--chart-grid-strong', chartGrid);
      const chartAxis = readCssVar(canvas, '--chart-axis', chartGrid);
      const textMuted = readCssVar(canvas, '--text-muted', '#94a3b8');
      const textMain = readCssVar(canvas, '--text-main', '#cbd5e1');

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      // 背景渐变
      const bgGrad = ctx.createLinearGradient(0, 0, 0, rect.height);
      bgGrad.addColorStop(0, 'rgba(255,255,255,0.018)');
      bgGrad.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = chartBg;
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, rect.width, rect.height);

      drawGrid(ctx, rect.width, rect.height, chartGrid, chartGridStrong, chartAxis, gridStyleRef.current);

      const visibleSeries = current.filter((item) => item.values.length > 1);
      if (visibleSeries.length === 0) {
        ctx.fillStyle = textMuted;
        ctx.font = '12.5px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emptyText, rect.width / 2, rect.height / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
        return;
      }

      let minTime = Number.POSITIVE_INFINITY;
      let maxTime = Number.NEGATIVE_INFINITY;
      for (const item of visibleSeries) {
        for (const v of item.values) {
          if (v.timestamp < minTime) minTime = v.timestamp;
          if (v.timestamp > maxTime) maxTime = v.timestamp;
        }
      }
      const timeSpan = Math.max(1, maxTime - minTime);

      // 浅色主题下关闭辉光：浅色背景上的彩色柔边会显脏
      const lightScheme = getComputedStyle(canvas).colorScheme === 'light';
      const glow = !reducedMotionRef.current && !lightScheme;
      const seriesMeta: Array<{ label: string; color: string; lastY: number }> = [];
      const pointLimit = resolveCanvasPointLimit(rect.width);
      for (const item of visibleSeries) {
        const drawValues = downsampleTimedValues(item.values, pointLimit);
        let maxAbs = item.scale;
        if (typeof maxAbs !== 'number' || maxAbs <= 0) {
          maxAbs = 1;
          for (const v of item.values) {
            const abs = Math.abs(v.value);
            if (abs > maxAbs) maxAbs = abs;
          }
          maxAbs *= 1.15;
          maxAbs = smoothAutoScale(autoScaleRef.current.get(item.label), maxAbs);
          autoScaleRef.current.set(item.label, maxAbs);
        } else {
          autoScaleRef.current.delete(item.label);
        }
        const strokeColor = resolveCanvasColor(canvas, item.color);
        const points = drawValues.map((point) => ({
          x: ((point.timestamp - minTime) / timeSpan) * rect.width,
          y: rect.height / 2 - (point.value / maxAbs) * (rect.height * 0.42)
        }));
        const lastY = points[points.length - 1]?.y ?? rect.height / 2;

        drawWaveformShadowFill(ctx, points, rect.height, strokeColor);

        if (glow) {
          ctx.save();
          ctx.shadowColor = strokeColor;
          ctx.shadowBlur = 8;
        }
        ctx.beginPath();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        drawPolyline(ctx, points);
        ctx.stroke();
        if (glow) {
          ctx.restore();
        }
        seriesMeta.push({ label: item.label, color: strokeColor, lastY });
      }

      if (labelAlignRef.current === 'right') {
        drawRightLabels(ctx, rect.width, rect.height, seriesMeta, textMain, chartBg);
      } else {
        drawLegend(ctx, seriesMeta, textMain);
      }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedMotionRef.current = !!mql?.matches;
    const updateReduced = (e: MediaQueryListEvent) => { reducedMotionRef.current = e.matches; };
    mql?.addEventListener?.('change', updateReduced);

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleDraw()) : null;
    resizeObserver?.observe(canvas);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      resizeObserver?.disconnect();
      mql?.removeEventListener?.('change', updateReduced);
    };
  }, [scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  });

  if (sideLabel) {
    const latest = series[0]?.values[series[0].values.length - 1];
    return (
      <section className="panel waveform-panel side-label-panel" aria-label={title}>
        <div
          className="side-label"
          style={{ '--side-color': sideLabel.color } as CSSProperties}
        >
          <span className="side-label-symbol">{sideLabel.text}</span>
          {sideLabel.sub && <span className="side-label-sub">{sideLabel.sub}</span>}
          {latest && <span className="side-label-value">{formatValue(latest.value)}</span>}
        </div>
        <canvas ref={canvasRef} />
      </section>
    );
  }

  return (
    <section className={fill ? 'panel waveform-panel fill-panel' : 'panel waveform-panel'} aria-label={title}>
      <div className="panel-header">
        <h2>{title}</h2>
        {latestValues && <span className="panel-meta">{latestValues}</span>}
      </div>
      <canvas ref={canvasRef} style={fill ? undefined : { height }} />
    </section>
  );
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
  strongColor: string,
  axisColor: string,
  style: 'lines' | 'dots' = 'lines'
) {
  if (style === 'dots') {
    drawDotGrid(ctx, width, height, color, axisColor);
    return;
  }
  // 次网格（10 等分，更暗）
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i += 1) {
    if (i % 2 === 0) continue;
    const y = (height / 10) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  // 主网格（5 等分，较亮）
  ctx.strokeStyle = strongColor;
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  // 竖向次网格
  ctx.strokeStyle = color;
  for (let i = 1; i < 8; i += 1) {
    if (i % 4 === 0) continue;
    const x = (width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  // 中线（最亮）
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
}

// 点阵网格：更轻量的现代感，纯波形模式使用
function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
  axisColor: string
) {
  const spacing = Math.max(22, Math.min(34, Math.round(height / 5)));
  ctx.fillStyle = color;
  for (let y = spacing; y < height; y += spacing) {
    for (let x = spacing; x < width; x += spacing) {
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
  }
  // 中线保留一条细实线作基准
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  seriesMeta: Array<{ label: string; color: string }>,
  textMain: string
) {
  ctx.font = '11.5px system-ui';
  ctx.textBaseline = 'middle';
  let legendX = 12;
  const legendY = 18;
  for (const item of seriesMeta) {
    ctx.fillStyle = item.color;
    roundRect(ctx, legendX, legendY - 4, 12, 8, 2);
    ctx.fill();
    ctx.fillStyle = textMain;
    ctx.fillText(item.label, legendX + 16, legendY);
    legendX += Math.max(72, item.label.length * 8 + 32);
  }
  ctx.textBaseline = 'alphabetic';
}

// 组合图右侧直接标注：在每条曲线末端右侧绘制色点 + 名称，避免用户来回看图例。
// 末端 y 来自曲线最后一个点，相邻标签过近时向下错开避免重叠。
function drawRightLabels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seriesMeta: Array<{ label: string; color: string; lastY: number }>,
  textMain: string,
  chartBg: string
) {
  ctx.font = '11.5px system-ui';
  ctx.textBaseline = 'middle';

  const sorted = [...seriesMeta].sort((a, b) => a.lastY - b.lastY);
  const minGap = 15;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].lastY - sorted[i - 1].lastY < minGap) {
      sorted[i].lastY = sorted[i - 1].lastY + minGap;
    }
  }
  for (const item of sorted) {
    const y = Math.max(10, Math.min(height - 10, item.lastY));
    const text = item.label;
    const textWidth = ctx.measureText(text).width;
    const pillW = textWidth + 22;
    const pillH = 16;
    const x = width - pillW - 8;
    const pillY = y - pillH / 2;

    ctx.fillStyle = chartBg;
    ctx.globalAlpha = 0.72;
    roundRect(ctx, x, pillY, pillW, pillH, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1;
    roundRect(ctx, x, pillY, pillW, pillH, 4);
    ctx.stroke();

    ctx.fillStyle = item.color;
    roundRect(ctx, x + 6, y - 3, 8, 6, 2);
    ctx.fill();

    ctx.fillStyle = textMain;
    ctx.fillText(text, x + 18, y);
  }
  ctx.textBaseline = 'alphabetic';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWaveformShadowFill(
  ctx: CanvasRenderingContext2D,
  points: CanvasPoint[],
  height: number,
  strokeColor: string
) {
  if (points.length < 2) return;

  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, withAlpha(strokeColor, 0.14));
  fill.addColorStop(0.5, withAlpha(strokeColor, 0.075));
  fill.addColorStop(1, withAlpha(strokeColor, 0.025));

  ctx.save();
  ctx.beginPath();
  drawPolyline(ctx, points);
  ctx.lineTo(points[points.length - 1].x, height);
  ctx.lineTo(points[0].x, height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

function drawPolyline(ctx: CanvasRenderingContext2D, points: CanvasPoint[]) {
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
}

function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  const hex = trimmed.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3
      ? hex[1].split('').map((char) => char + char).join('')
      : hex[1];
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgb = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const channels = rgb[1].split(',').map((channel) => channel.trim());
    if (channels.length >= 3) {
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
    }
  }

  return trimmed;
}

function readCssVar(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function resolveCanvasColor(element: HTMLElement, value: string): string {
  if (!value.startsWith('var(')) return value;
  const variableName = value.slice(4, -1).trim();
  return readCssVar(element, variableName, '#38bdf8');
}

function resolveCanvasPointLimit(width: number): number {
  return Math.max(120, Math.min(900, Math.floor(width)));
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
