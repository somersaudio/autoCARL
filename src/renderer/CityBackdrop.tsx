import { useEffect, useState } from 'react';
import type { CityPhoto } from '../shared/types';
import Starfield from './Starfield';
import { photoSrc, placeKey, setShownCityPhoto, shownCityPhoto } from './city-view';

// "City View": a photo of the city the current gig is in, behind everything,
// under a navy veil so the cards and the header read on top of it.
//
// `city` is undefined while the bookings are still loading; the photo from
// last time stays up meanwhile. null means there's no gig to show (or no one
// is logged in), and a city without a photo is the same: the starfield stands
// in, and the photo is forgotten, so neither the next launch nor the credit in
// Settings brings back a city the user has left. A new photo is fully decoded
// before it fades in over the old one, so a slow connection never shows a
// half-drawn picture.

// `fresh` fades in; the photo painted at launch is just there.
type Layer = { photo: CityPhoto; src: string; fresh: boolean };

const FADE_MS = 900;

export default function CityBackdrop({ city, state }: { city: string | null | undefined; state: string }) {
  const [layers, setLayers] = useState<Layer[]>(() => {
    const last = shownCityPhoto();
    return last ? [{ photo: last.photo, src: last.src, fresh: false }] : [];
  });

  useEffect(() => {
    if (city === undefined) return;
    const none = () => {
      setLayers([]);
      setShownCityPhoto(null);
    };
    const lookup = window.api.cityPhoto;
    if (city === null || !lookup) { none(); return; }
    const key = placeKey(city, state);
    // A lookup that fails for the city already on screen leaves it up.
    const keepOrNone = () => { if (shownCityPhoto()?.key !== key) none(); };
    let alive = true;
    let settle: ReturnType<typeof setTimeout> | undefined;
    void lookup.forPlace(city, state).then(async (photo) => {
      if (!alive) return;
      if (!photo) { keepOrNone(); return; }
      const src = photoSrc(photo);
      try {
        const img = new Image();
        img.src = src;
        await img.decode();
      } catch {
        if (alive) keepOrNone();
        return;
      }
      if (!alive) return;
      setShownCityPhoto({ key, photo, src });
      setLayers((prev) => {
        const top = prev[prev.length - 1];
        return top?.src === src ? prev : [...prev.slice(-1), { photo, src, fresh: true }];
      });
      settle = setTimeout(() => setLayers((prev) => prev.slice(-1)), FADE_MS);
    });
    return () => { alive = false; clearTimeout(settle); };
  }, [city, state]);

  if (layers.length === 0) return <Starfield />;
  return (
    <div className="backdrop-canvas city-backdrop" aria-hidden="true">
      {layers.map((l) => (
        <img
          key={l.src}
          className={`city-photo${l.fresh ? ' is-fresh' : ''}`}
          src={l.src}
          alt=""
          draggable={false}
          style={{ objectPosition: `${l.photo.focus}% 50%` }}
        />
      ))}
      <div className="city-veil" />
    </div>
  );
}
