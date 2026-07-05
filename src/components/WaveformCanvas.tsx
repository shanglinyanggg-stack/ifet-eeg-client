import { useEffect, useRef } from 'react';
import type { TimedValue } from '../domain/dsp';

export interface WaveformSeries {
  label: string;
  color: string;
  values: TimedValue[];
  scale?: number;
}

interface WaveformCanvasProps {
  title: string;
  series: WaveformSeries[];
  height?: number | string;
  fill?: boolean;
  emptyText?: string;
}

export function WaveformCanvas({ title, series, height = 220, fill = false, emptyText = '等待数据' }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 用 ref 持有最新的 series，rAF 节流重绘，避免每个样本触发一次全量绘制
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const rafRef = useRef<number | null>(null);

  const latestValues = series
    .map((item) => {
      const latest = item.values[item.values.length - 1];
      return latest ? `${item.label} ${formatValue(latest.value)}` : null;
    })
    .filter(Boolean)
    .slice(0, 3)
    .join('  ');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const current = seriesRef.current;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
      const targetHeight = Math.max(1, Math.floor(rect.height * dpr));
      // 仅在尺寸变化时重设，避免每帧清零 transform
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const chartBg = readCssVar(canvas, '--chart-bg', '#07111f');
      const chartGrid = readCssVar(canvas, '--chart-grid', 'rgba(148, 163, 184, 0.16)');
      const chartAxis = readCssVar(canvas, '--chart-axis', chartGrid);
      const textMuted = readCssVar(canvas, '--text-muted', '#94a3b8');
      const textMain = readCssVar(canvas, '--text-main', '#cbd5e1');

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = chartBg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      drawGrid(ctx, rect.width, rect.height, chartGrid, chartAxis);

      const visibleSeries = current.filter((item) => item.values.length > 1);
      if (visibleSeries.length === 0) {
        ctx.fillStyle = textMuted;
        ctx.font = '13px system-ui';
        ctx.fillText(emptyText, 16, 28);
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

      for (const item of visibleSeries) {
        let maxAbs = item.scale;
        if (typeof maxAbs !== 'number' || maxAbs <= 0) {
          maxAbs = 1;
          for (const v of item.values) {
            const abs = Math.abs(v.value);
            if (abs > maxAbs) maxAbs = abs;
          }
          maxAbs *= 1.15;
        }
        ctx.beginPath();
        ctx.strokeStyle = resolveCanvasColor(canvas, item.color);
        ctx.lineWidth = 1.6;

        item.values.forEach((point, index) => {
          const x = ((point.timestamp - minTime) / timeSpan) * rect.width;
          const y = rect.height / 2 - (point.value / maxAbs) * (rect.height * 0.42);
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
      }

      ctx.fillStyle = textMain;
      ctx.font = '12px system-ui';
      let legendX = 12;
      for (const item of visibleSeries) {
        ctx.fillStyle = resolveCanvasColor(canvas, item.color);
        ctx.fillRect(legendX, 12, 8, 8);
        ctx.fillStyle = textMain;
        ctx.fillText(item.label, legendX + 12, 20);
        legendX += Math.max(72, item.label.length * 8 + 28);
      }
    };

    const scheduleDraw = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    };

    // 立即画一帧，并对后续 series 变化用 rAF 合并
    scheduleDraw();

    // 监听容器尺寸变化，避免缩放后画面错位
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleDraw()) : null;
    resizeObserver?.observe(canvas);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      resizeObserver?.disconnect();
    };
  }, [emptyText]);

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

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, color: string, axisColor: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i += 1) {
    const x = (width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function readCssVar(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function resolveCanvasColor(element: HTMLElement, value: string): string {
  if (!value.startsWith('var(')) return value;
  const variableName = value.slice(4, -1).trim();
  return readCssVar(element, variableName, '#38bdf8');
}

function formatValue(value: number): string {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
