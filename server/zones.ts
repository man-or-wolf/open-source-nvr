// Polygons are lists of normalised [x, y] points (0-1, origin top-left)
export type Point = [number, number]
export type Polygon = Point[]

export interface Zone {
    name: string;
    points: Polygon;
    // labels that count in this zone, empty/undefined = any tracked object
    objects?: string[];
}

export function pointInPolygon(x: number, y: number, poly: Polygon): boolean {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i] as Point, [xj, yj] = poly[j] as Point
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside
        }
    }
    return inside
}

export function validPolygon(p: any): p is Polygon {
    return Array.isArray(p) && p.length >= 3 && p.length <= 200 &&
        p.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every((n: any) => typeof n === 'number' && n >= 0 && n <= 1))
}

// 1 = inside any of the polygons. Rasterised once per config change, so per-frame checks are a lookup.
export function rasterise(polys: Polygon[] | undefined, w: number, h: number): Uint8Array {
    const m = new Uint8Array(w * h)
    for (const poly of polys || []) {
        if (!validPolygon(poly)) continue
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (!m[y * w + x] && pointInPolygon((x + 0.5) / w, (y + 0.5) / h, poly)) m[y * w + x] = 1
            }
        }
    }
    return m
}

// Zones an object (box = [x1,y1,x2,y2]) is in, using the bottom-centre of the box (where it touches the ground).
export function zonesFor(label: string, box: number[], zones: Zone[] | undefined): string[] {
    const x = ((box[0] as number) + (box[2] as number)) / 2, y = box[3] as number
    return (zones || [])
        .filter(z => validPolygon(z.points) && (!z.objects || z.objects.length === 0 || z.objects.includes(label)) && pointInPolygon(x, y, z.points))
        .map(z => z.name)
}
