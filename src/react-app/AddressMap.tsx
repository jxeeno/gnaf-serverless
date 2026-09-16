import { useEffect, useRef } from "react";
import { Map as MapLibreMap, Marker, Popup, NavigationControl, ScaleControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/** OpenFreeMap serves the Liberty style and its tiles free, with no API key. */
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const ZOOM = 17;

interface AddressMapProps {
  latitude?: number;
  longitude?: number;
  label?: string;
}

/**
 * The marker is drawn rather than imaged: a signal-yellow dot on an ink ring,
 * with a ping radiating out of it, matching the plates around the map.
 */
function createMarkerElement(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "position:relative;width:20px;height:20px";
  el.innerHTML = `
    <span style="position:absolute;inset:0;border-radius:50%;background:#f5c400;border:3px solid #20241f"></span>
    <span style="position:absolute;inset:-12px;border-radius:50%;border:2px solid rgba(245,196,0,0.8);animation:ping 2s ease-out infinite"></span>
  `;
  return el;
}

export function AddressMap({ latitude, longitude, label }: AddressMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (latitude == null || longitude == null) return;

    // Re-centre an existing map rather than tearing down the GL context, which
    // is expensive and flashes the tiles on every navigation.
    if (mapRef.current) {
      mapRef.current.setCenter([longitude, latitude]);
      markerRef.current?.setLngLat([longitude, latitude]);
      if (label) markerRef.current?.setPopup(new Popup({ offset: 16 }).setText(label));
      return;
    }

    const map = new MapLibreMap({
      container: containerRef.current,
      style: STYLE_URL,
      center: [longitude, latitude],
      zoom: ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    const marker = new Marker({ element: createMarkerElement() })
      .setLngLat([longitude, latitude])
      .addTo(map);
    if (label) marker.setPopup(new Popup({ offset: 16 }).setText(label));
    markerRef.current = marker;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude, label]);

  if (latitude == null || longitude == null) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center bg-[#e9e6dc] text-[13px] font-semibold text-ink-mute">
        No geocode for this address
      </div>
    );
  }

  return <div ref={containerRef} className="h-full min-h-[300px] w-full" />;
}
