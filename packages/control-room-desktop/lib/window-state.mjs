import { readFileSync, writeFileSync } from 'node:fs';

/** Restore into a connected monitor's work area, including after DPI/display changes. */
export function restoreWindowState(raw, areas) {
  const saved = raw || {};
  const area = areas.find((a) => saved.x >= a.x && saved.x < a.x + a.width - 100 &&
    saved.y >= a.y && saved.y < a.y + a.height - 60) || areas[0];
  const size = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) && value > 0 ? value : fallback));
  const width = size(saved.width, 1360, 900, area.width);
  const height = size(saved.height, 900, 600, area.height);
  const x = Number.isFinite(saved.x) ? saved.x : area.x + (area.width - width) / 2;
  const y = Number.isFinite(saved.y) ? saved.y : area.y + (area.height - height) / 2;
  return { bounds: { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height },
  maximized: saved.maximized === true,
  zoomLevel: Number.isFinite(saved.zoomLevel) && saved.zoomLevel >= -3 && saved.zoomLevel <= 5 ? saved.zoomLevel : 0 };
}

export function loadWindowState(file, areas) {
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  return restoreWindowState(saved, areas);
}

export function saveWindowState(file, window) {
  writeFileSync(file, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized(),
    zoomLevel: window.webContents.getZoomLevel() }), 'utf8');
}
