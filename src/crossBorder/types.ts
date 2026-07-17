export interface Route {
  country: string;
  crossing: [number, number]; // [lng, lat] on the border
  neighbor: [number, number]; // [lng, lat] in neighboring country
  control:  [number, number]; // [lng, lat] quadratic Bézier control point
}
