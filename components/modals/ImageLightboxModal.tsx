'use client';

import { useEffect, useState } from 'react';
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react';

export interface LightboxImageItem {
  data: string;
  name: string;
}

/** The opened image; `gallery` holds every image of the same message (owner, 2 Oct 2026). */
export interface LightboxImage extends LightboxImageItem {
  gallery?: LightboxImageItem[];
  index?: number;
}

interface ImageLightboxModalProps {
  lightboxImage: LightboxImage | null;
  onClose: () => void;
}

export function ImageLightboxModal({ lightboxImage, onClose }: ImageLightboxModalProps) {
  const gallery = lightboxImage?.gallery && lightboxImage.gallery.length > 0
    ? lightboxImage.gallery
    : lightboxImage ? [lightboxImage] : [];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(lightboxImage?.index ?? 0);
  }, [lightboxImage]);

  const count = gallery.length;
  const step = (delta: number) => setIndex(i => (i + delta + count) % count);

  useEffect(() => {
    if (!lightboxImage || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); setIndex(i => (i + 1) % count); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex(i => (i - 1 + count) % count); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxImage, count]);

  if (!lightboxImage) return null;
  const current = gallery[Math.min(index, count - 1)] ?? lightboxImage;
  const navButton = 'absolute top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white/70 hover:text-white transition-colors';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between w-full px-2 pb-2">
          <span className="text-xs text-white/50 truncate max-w-[60%]">
            {count > 1 && <span className="text-white/70 mr-2">{index + 1} / {count}</span>}
            {current.name}
          </span>
          <div className="flex items-center gap-2">
            <a
              href={current.data}
              download={current.name}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              title="Download"
              onClick={e => e.stopPropagation()}
            >
              <Download className="w-4 h-4" />
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="relative">
          <img
            src={current.data}
            alt={current.name}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl cursor-default"
          />
          {count > 1 && (
            <>
              <button className={`${navButton} left-2`} onClick={() => step(-1)} title="Previous image (←)" aria-label="Previous image">
                <ChevronLeft className="w-6 h-6" />
              </button>
              <button className={`${navButton} right-2`} onClick={() => step(1)} title="Next image (→)" aria-label="Next image">
                <ChevronRight className="w-6 h-6" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
