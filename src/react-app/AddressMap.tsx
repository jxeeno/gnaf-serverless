import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix default marker icon paths (Leaflet + bundlers issue)
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface AddressMapProps {
  latitude?: number;
  longitude?: number;
  label?: string;
}

export function AddressMap({ latitude, longitude, label }: AddressMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!latitude || !longitude) return;

    // If map already exists, update view and marker
    if (mapRef.current) {
      mapRef.current.setView([latitude, longitude], 16);
      mapRef.current.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          mapRef.current!.removeLayer(layer);
        }
      });
      const marker = L.marker([latitude, longitude]).addTo(mapRef.current);
      if (label) marker.bindPopup(label).openPopup();
      return;
    }

    const map = L.map(containerRef.current).setView([latitude, longitude], 16);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const marker = L.marker([latitude, longitude]).addTo(map);
    if (label) marker.bindPopup(label).openPopup();

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude, label]);

  if (!latitude || !longitude) {
    return (
      <div className="flex items-center justify-center h-[400px] text-sm text-muted-foreground">
        No geocode available
      </div>
    );
  }

  return <div ref={containerRef} className="h-[400px] w-full" />;
}
