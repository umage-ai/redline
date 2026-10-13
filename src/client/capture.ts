// Screenshots for notes. Default: render the DOM to a canvas (modern-screenshot),
// recreating document and inner-container scroll positions. Optional "tab capture"
// uses getDisplayMedia on the current tab: pixel-perfect (WebGL, maps, video) but
// Chrome asks once per page load.

import { domToCanvas } from 'modern-screenshot';

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;

export function tabCaptureActive() { return !!stream?.active; }

export async function startTabCapture(): Promise<boolean> {
  if (stream?.active) return true;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 5 },
      audio: false,
      // Chrome-only hints: offer this tab first, don't ask to pick a window.
      preferCurrentTab: true, selfBrowserSurface: 'include',
    } as DisplayMediaStreamOptions);
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => { stream = null; video = null; });
    return true;
  } catch { stream = null; return false; }
}

export function stopTabCapture() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null; video = null;
}

const frames = (n: number) => new Promise<void>(r => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

async function grabTab(host: HTMLElement): Promise<HTMLCanvasElement> {
  const prev = host.style.visibility;
  host.style.visibility = 'hidden';
  await frames(3);
  await new Promise(r => setTimeout(r, 120));   // let the capture pipeline catch a clean frame
  const v = video!;
  const c = document.createElement('canvas');
  c.width = innerWidth; c.height = innerHeight;
  c.getContext('2d')!.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, 0, 0, c.width, c.height);
  host.style.visibility = prev;
  return c;
}

const SHIFT = 'data-redline-shift';

async function renderDom(host: HTMLElement): Promise<HTMLCanvasElement> {
  // Mark children of every scrolled container (and of <body> for the page scroll)
  // so their clones can be translated by the scroll offset.
  const marked: Element[] = [];
  const mark = (parent: Element, dx: number, dy: number) => {
    for (const c of Array.from(parent.children)) {
      if (c === host || getComputedStyle(c).position === 'fixed') continue;
      c.setAttribute(SHIFT, `${dx},${dy}`);
      marked.push(c);
    }
  };
  if (scrollX || scrollY) mark(document.body, scrollX, scrollY);
  const all = document.body.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if ((el.scrollTop || el.scrollLeft) && el !== document.body) mark(el, el.scrollLeft, el.scrollTop);
  }
  const bg = getComputedStyle(document.body).backgroundColor;
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  try {
    return await domToCanvas(document.documentElement, {
      width: innerWidth,
      height: innerHeight,
      scale: Math.min(devicePixelRatio || 1, 2),
      backgroundColor: !/rgba\(0, 0, 0, 0\)|transparent/.test(htmlBg) ? htmlBg : !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : '#ffffff',
      filter: n => n !== host,
      timeout: 4000,
      style: { overflow: 'hidden' },
      onCloneEachNode: (n: Node) => {
        if (!(n instanceof Element)) return;
        const s = n.getAttribute(SHIFT);
        if (!s) return;
        const [dx, dy] = s.split(',').map(Number);
        (n as HTMLElement).style.translate = `${-dx}px ${-dy}px`;
        n.removeAttribute(SHIFT);
      },
    });
  } finally {
    for (const el of marked) el.removeAttribute(SHIFT);
  }
}

export interface Mark { box?: [number, number, number, number]; sketch?: SVGSVGElement | null; crop?: boolean }

/**
 * Screenshot of the viewport with the target outlined in red (and a sketch drawn
 * on top), cropped around the target unless crop is false. Returns a PNG data URL.
 */
export async function screenshot(host: HTMLElement, mark: Mark): Promise<string | undefined> {
  let shot: HTMLCanvasElement;
  try { shot = tabCaptureActive() ? await grabTab(host) : await renderDom(host); }
  catch (e) { console.warn('[redline] screenshot failed', e); return undefined; }

  const k = shot.width / innerWidth;
  const out = document.createElement('canvas');
  let [sx, sy, sw, sh] = [0, 0, innerWidth, innerHeight];
  if (mark.box && mark.crop !== false) {
    const [x, y, w, h] = mark.box;
    const pad = 160;
    sx = Math.max(0, x - pad); sy = Math.max(0, y - pad);
    sw = Math.min(innerWidth, x + w + pad) - sx; sh = Math.min(innerHeight, y + h + pad) - sy;
    // Keep some context for small targets.
    if (sw < 640) { const grow = Math.min(640, innerWidth) - sw; sx = Math.max(0, Math.min(sx - grow / 2, innerWidth - sw - grow)); sw += grow; }
    if (sh < 360) { const grow = Math.min(360, innerHeight) - sh; sy = Math.max(0, Math.min(sy - grow / 2, innerHeight - sh - grow)); sh += grow; }
  }
  out.width = Math.round(sw * k); out.height = Math.round(sh * k);
  const g = out.getContext('2d')!;
  g.drawImage(shot, sx * k, sy * k, sw * k, sh * k, 0, 0, out.width, out.height);
  g.scale(k, k);
  g.translate(-sx, -sy);

  if (mark.box) {
    const [x, y, w, h] = mark.box;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.strokeRect(x - 4, y - 4, w + 8, h + 8);
    g.strokeStyle = '#ff2d55';
    g.lineWidth = 2;
    g.strokeRect(x - 3, y - 3, w + 6, h + 6);
  }
  if (mark.sketch) {
    const xml = new XMLSerializer().serializeToString(mark.sketch);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    await img.decode().catch(() => undefined);
    g.drawImage(img, 0, 0, innerWidth, innerHeight);
  }
  return out.toDataURL('image/png');
}
