const dimensions = (item: HTMLImageElement | HTMLVideoElement) => item instanceof HTMLVideoElement
    ? [item.videoWidth, item.videoHeight] as const : [item.naturalWidth, item.naturalHeight] as const;

/** Capture the displayed media locally; no full-resolution media leaves the player. */
export async function capturePreview(element: HTMLElement, image?: HTMLImageElement, video?: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 800 / Math.max(innerWidth, innerHeight));
  canvas.width = Math.round(innerWidth * scale);
  canvas.height = Math.round(innerHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(scale, scale);
  context.fillStyle = '#111'; context.fillRect(0, 0, innerWidth, innerHeight);
  const source = video && !video.hidden && video.readyState >= 2 ? video : image;
  if (!source) return null;
  if (element.querySelector('.slide-backdrop')) {
    const backdrop = image ?? source;
    const [w, h] = dimensions(backdrop);
    const cover = Math.max(innerWidth / w, innerHeight / h) * 1.08;
    context.save(); context.filter = 'blur(24px) brightness(.65)';
    context.drawImage(backdrop, (innerWidth - w * cover) / 2, (innerHeight - h * cover) / 2, w * cover, h * cover);
    context.restore();
  }
  for (const item of [image, video]) {
    if (!item || item.hidden) continue;
    const rect = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    const [w, h] = dimensions(item);
    if (!w || !h) continue;
    const fit = style.objectFit === 'cover' ? Math.max(rect.width / w, rect.height / h) : Math.min(rect.width / w, rect.height / h);
    context.save();
    context.globalAlpha = Number(style.opacity);
    // Respect the video's clean-aperture wrapper as well as the viewport.
    const parent = item.parentElement!;
    if (getComputedStyle(parent).overflow === 'hidden') {
      const clip = parent.getBoundingClientRect(); context.beginPath(); context.rect(clip.x, clip.y, clip.width, clip.height); context.clip();
    }
    context.drawImage(item, rect.x + (rect.width - w * fit) / 2, rect.y + (rect.height - h * fit) / 2, w * fit, h * fit);
    context.restore();
  }
  // Captions are simple text and icons. Reuse their measured layout and typography.
  for (const caption of element.querySelectorAll<HTMLElement>('.frame-caption')) {
    if (caption.hidden) continue;
    const box = caption.getBoundingClientRect();
    context.fillStyle = 'rgba(20, 24, 22, .5)';
    context.beginPath(); context.roundRect(box.x, box.y, box.width, box.height, 6); context.fill();
    for (const text of caption.querySelectorAll<HTMLElement>('.location-city, .location-state, .location-country, .date-label, time')) {
      if (!text.textContent || !text.getBoundingClientRect().height) continue;
      const bounds = text.getBoundingClientRect(); const style = getComputedStyle(text);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.fillStyle = style.color; context.textBaseline = 'middle';
      context.fillText(text.textContent, bounds.x, bounds.y + bounds.height / 2);
    }
  }
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .78));
}
