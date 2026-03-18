import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MapPin, FileJson, Table } from "lucide-react";
import type { AddressResponse } from "../../shared/types";
import { AddressMap } from "../AddressMap";

export function AddressDetail({ address }: { address: AddressResponse }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="font-mono text-xs">{address.pid}</Badge>
          {address.precedence && (
            <Badge variant={address.precedence === "primary" ? "default" : "outline"}>
              {address.precedence}
            </Badge>
          )}
          {address.lpid && (
            <Badge variant="outline" className="font-mono text-xs">Lot/DP: {address.lpid}</Badge>
          )}
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{address.sla}</h2>
        {address.ssla && (
          <p className="text-sm text-muted-foreground">{address.ssla}</p>
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
                <CardTitle className="text-sm font-medium text-muted-foreground">Address</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {address.mla.map((line, i) => (
                  <p key={i} className="text-sm font-medium">{line}</p>
                ))}
                {address.smla && (
                  <div className="pt-2 mt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Short form</p>
                    {address.smla.map((line, i) => (
                      <p key={i} className="text-sm">{line}</p>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Location</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {address.geocoding.geocodes.map((g, i) => (
                  <div key={i} className="grid grid-cols-[80px_1fr] gap-1">
                    <span className="text-muted-foreground">Latitude</span>
                    <span className="font-mono">{g.latitude}</span>
                    <span className="text-muted-foreground">Longitude</span>
                    <span className="font-mono">{g.longitude}</span>
                    <span className="text-muted-foreground">Type</span>
                    <span>{g.type.name}</span>
                  </div>
                ))}
                <div className="grid grid-cols-[80px_1fr] gap-1 pt-1 border-t">
                  <span className="text-muted-foreground">Level</span>
                  <span>{address.geocoding.level.name}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Street</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                  {address.structured.number && (
                    <>
                      <span className="text-muted-foreground">Number</span>
                      <span>
                        {[address.structured.number.prefix, address.structured.number.number, address.structured.number.suffix].filter(Boolean).join("")}
                        {address.structured.number.last && (
                          <span> - {[address.structured.number.last.prefix, address.structured.number.last.number, address.structured.number.last.suffix].filter(Boolean).join("")}</span>
                        )}
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground">Name</span>
                  <span>{address.structured.street.name}</span>
                  {address.structured.street.type && (
                    <>
                      <span className="text-muted-foreground">Type</span>
                      <span>{address.structured.street.type.code} ({address.structured.street.type.name})</span>
                    </>
                  )}
                  {address.structured.street.suffix && (
                    <>
                      <span className="text-muted-foreground">Suffix</span>
                      <span>{address.structured.street.suffix.name} ({address.structured.street.suffix.code})</span>
                    </>
                  )}
                  {address.structured.street.class && (
                    <>
                      <span className="text-muted-foreground">Class</span>
                      <span>{address.structured.street.class.name}</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Locality & State</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Locality</span>
                  <span>{address.structured.locality.name}</span>
                  {address.structured.locality.class && (
                    <>
                      <span className="text-muted-foreground">Class</span>
                      <span>{address.structured.locality.class.name}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Postcode</span>
                  <span>{address.structured.postcode ?? "\u2014"}</span>
                  <span className="text-muted-foreground">State</span>
                  <span>{address.structured.state.name} ({address.structured.state.abbreviation})</span>
                  <span className="text-muted-foreground">Confidence</span>
                  <span>{address.structured.confidence}</span>
                </div>
              </CardContent>
            </Card>

            {(address.structured.flat || address.structured.level || address.structured.buildingName || address.structured.lotNumber) && (
              <Card className="sm:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Additional Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 text-sm">
                    {address.structured.buildingName && (
                      <>
                        <span className="text-muted-foreground">Building</span>
                        <span>{address.structured.buildingName}</span>
                      </>
                    )}
                    {address.structured.flat && (
                      <>
                        <span className="text-muted-foreground">Flat/Unit</span>
                        <span>
                          {address.structured.flat.type.name}{" "}
                          {[address.structured.flat.prefix, address.structured.flat.number, address.structured.flat.suffix].filter(v => v != null).join("")}
                        </span>
                      </>
                    )}
                    {address.structured.level && (
                      <>
                        <span className="text-muted-foreground">Level</span>
                        <span>
                          {address.structured.level.type.name}{" "}
                          {[address.structured.level.prefix, address.structured.level.number, address.structured.level.suffix].filter(v => v != null).join("")}
                        </span>
                      </>
                    )}
                    {address.structured.lotNumber && (
                      <>
                        <span className="text-muted-foreground">Lot</span>
                        <span>
                          {[address.structured.lotNumber.prefix, address.structured.lotNumber.number, address.structured.lotNumber.suffix].filter(Boolean).join("")}
                        </span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {address.overlays && Object.keys(address.overlays).length > 0 && (
              <Card className="sm:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Overlays</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {Object.entries(address.overlays).map(([key, overlay]) => (
                    <div key={key}>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">{overlay.label}</p>
                      <div className="grid grid-cols-[1fr_2fr] gap-x-2 gap-y-1 text-sm">
                        {Object.entries(overlay.properties).map(([prop, value]) => (
                          <React.Fragment key={prop}>
                            <span className="text-muted-foreground truncate" title={prop}>{prop}</span>
                            <span className="font-mono text-xs break-all">{String(value)}</span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="map" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-hidden rounded-lg">
              <AddressMap
                latitude={address.geocoding.geocodes[0]?.latitude}
                longitude={address.geocoding.geocodes[0]?.longitude}
                label={address.sla}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="json" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <pre className="text-xs font-mono bg-muted p-4 rounded-lg overflow-auto max-h-[600px] whitespace-pre-wrap break-all">
                {JSON.stringify(address, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
