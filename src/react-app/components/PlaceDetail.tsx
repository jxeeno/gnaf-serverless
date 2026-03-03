import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MapPin, FileJson, Table, ExternalLink } from "lucide-react";
import { AddressMap } from "../AddressMap";

export interface PlaceResponse {
  id: string;
  name: string;
  categories: {
    primary: string;
    alternate: string[];
  };
  address?: {
    freeform?: string;
    locality?: string;
    region?: string;
    postcode?: string;
    country?: string;
  };
  location: {
    latitude: number;
    longitude: number;
  };
  confidence: number;
  contact?: {
    phone?: string;
    website?: string;
  };
  brand?: string;
}

export function PlaceDetail({ place }: { place: PlaceResponse }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="text-xs">{place.categories.primary}</Badge>
          {place.categories.alternate.map((cat) => (
            <Badge key={cat} variant="outline" className="text-xs">{cat}</Badge>
          ))}
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{place.name}</h2>
        {place.address?.freeform && (
          <p className="text-sm text-muted-foreground">
            {[place.address.freeform, place.address.locality, place.address.region, place.address.postcode].filter(Boolean).join(", ")}
          </p>
        )}
      </div>

      <Tabs defaultValue="details" className="w-full">
        <TabsList className="w-full grid grid-cols-3">
          <TabsTrigger value="details" className="gap-1.5"><Table className="h-3.5 w-3.5" /> Details</TabsTrigger>
          <TabsTrigger value="map" className="gap-1.5"><MapPin className="h-3.5 w-3.5" /> Map</TabsTrigger>
          <TabsTrigger value="json" className="gap-1.5"><FileJson className="h-3.5 w-3.5" /> JSON</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Place</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{place.name}</span>
                  {place.brand && (
                    <>
                      <span className="text-muted-foreground">Brand</span>
                      <span>{place.brand}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Category</span>
                  <span>{place.categories.primary}</span>
                  <span className="text-muted-foreground">Confidence</span>
                  <span>{place.confidence}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Location</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">Latitude</span>
                  <span className="font-mono">{place.location.latitude}</span>
                  <span className="text-muted-foreground">Longitude</span>
                  <span className="font-mono">{place.location.longitude}</span>
                </div>
              </CardContent>
            </Card>

            {place.address && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Address</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                    {place.address.freeform && (
                      <>
                        <span className="text-muted-foreground">Address</span>
                        <span>{place.address.freeform}</span>
                      </>
                    )}
                    {place.address.locality && (
                      <>
                        <span className="text-muted-foreground">Locality</span>
                        <span>{place.address.locality}</span>
                      </>
                    )}
                    {place.address.region && (
                      <>
                        <span className="text-muted-foreground">Region</span>
                        <span>{place.address.region}</span>
                      </>
                    )}
                    {place.address.postcode && (
                      <>
                        <span className="text-muted-foreground">Postcode</span>
                        <span>{place.address.postcode}</span>
                      </>
                    )}
                    {place.address.country && (
                      <>
                        <span className="text-muted-foreground">Country</span>
                        <span>{place.address.country}</span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {(place.contact?.phone || place.contact?.website) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Contact</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                    {place.contact.phone && (
                      <>
                        <span className="text-muted-foreground">Phone</span>
                        <a href={`tel:${place.contact.phone}`} className="text-primary hover:underline">
                          {place.contact.phone}
                        </a>
                      </>
                    )}
                    {place.contact.website && (
                      <>
                        <span className="text-muted-foreground">Website</span>
                        <a
                          href={place.contact.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1 truncate"
                        >
                          {place.contact.website.replace(/^https?:\/\/(www\.)?/, "")}
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="map" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-hidden rounded-lg">
              <AddressMap
                latitude={place.location.latitude}
                longitude={place.location.longitude}
                label={place.name}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <pre className="text-xs font-mono bg-muted p-4 rounded-lg overflow-auto max-h-[600px] whitespace-pre-wrap break-all">
                {JSON.stringify(place, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
