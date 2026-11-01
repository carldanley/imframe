import { playbackAperture, type VideoAperture } from '../shared/video-aperture.js';
import type { FrameSettings } from '../shared/model.js';

/** Fit the clean picture, then clip off the camera's encoded padding before pan/zoom. */
export function frameVideo(video: HTMLVideoElement, foreground: HTMLElement, metadata: VideoAperture | null, fit: FrameSettings['fit']): () => void {
  const crop = playbackAperture(metadata, video.videoWidth, video.videoHeight);
  if (!crop) return () => {};
  const aperture = document.createElement('div');
  aperture.className = 'video-aperture';
  foreground.append(aperture);
  aperture.append(video);
  const resize = () => {
    const w = foreground.clientWidth, h = foreground.clientHeight;
    const scale = (fit === 'cover' ? Math.max : Math.min)(w / crop.width, h / crop.height);
    Object.assign(aperture.style, {
      width: `${crop.width * scale}px`, height: `${crop.height * scale}px`,
      left: `${(w - crop.width * scale) / 2}px`, top: `${(h - crop.height * scale) / 2}px`,
    });
    Object.assign(video.style, {
      inset: 'auto', objectFit: 'fill',
      width: `${crop.sourceWidth * scale}px`, height: `${crop.sourceHeight * scale}px`,
      left: `${-crop.x * scale}px`, top: `${-crop.y * scale}px`,
    });
  };
  resize(); // Establish the crop before this preloaded slide can become visible.
  const observer = new ResizeObserver(resize);
  observer.observe(foreground);
  return () => observer.disconnect();
}
