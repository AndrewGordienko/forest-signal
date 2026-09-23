import { readFileSync } from "node:fs";
import { analyzeGrid } from "../src/staticAnalysis.ts";

type Case = {
  input: {
    site: string;
    start: number;
    end: number;
    confidence: number;
    polygon: object | null;
  };
  summary: {
    meanChange: number;
    areaHa: number;
    siteDirection: string;
    classAreaHa: { gain: number; loss: number; uncertain: number };
  };
};
const root = new URL("../public/demo-data/", import.meta.url);
const cases = JSON.parse(
  readFileSync(new URL("parity.json", root), "utf8"),
) as Case[];
for (const test of cases) {
  const grid = JSON.parse(
    readFileSync(new URL(test.input.site + ".json", root), "utf8"),
  );
  const actual = analyzeGrid(grid, test.input).summary;
  const expected = test.summary;
  if (actual.siteDirection !== expected.siteDirection)
    throw Error(test.input.site + ": site verdict mismatch");
  for (const key of ["meanChange", "areaHa"] as const)
    if (Math.abs(actual[key] - expected[key]) > 0.12)
      throw Error(
        test.input.site +
          ": " +
          key +
          " mismatch: " +
          actual[key] +
          " vs " +
          expected[key],
      );
  for (const key of ["gain", "loss", "uncertain"] as const)
    if (Math.abs(actual.classAreaHa[key] - expected.classAreaHa[key]) > 0.2)
      throw Error(
        test.input.site +
          ": " +
          key +
          " area mismatch: " +
          actual.classAreaHa[key] +
          " vs " +
          expected.classAreaHa[key],
      );
}
console.log(
  "Static preview matches Python raster summaries for " +
    cases.length +
    " cases.",
);
