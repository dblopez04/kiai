import { describe, expect, it } from "vitest";
import { checkPrivateRequest, isPrivateHost } from "../src/http/private.ts";
import { csvCell, CSV_COLUMNS } from "../src/scores/csv.ts";
import { clockRate, isLazerScore, MOD_CATALOG, MOD_CATEGORIES, modLabel, modSettingLabels, normalizeMods, STANDARD_MODS } from "../src/scores/mods.ts";
import { BeatmapFetchError, calculatePp, createPpCalculator, performanceArgs } from "../src/scores/pp.ts";
import { DEFAULT_FILTERS, filtersToParams, parseScoreFilters, searchWords } from "../src/scores/query.ts";
import { beatmapRow, isPassed, scoreRow, wantsLocalPp } from "../src/scores/rows.ts";
import { osuFile, score } from "./helpers/fake-osu.ts";

describe("mods", () => {
  it("normalizes API mods, bare acronyms and JSON strings, keeping settings", () => {
    const mods = [{ acronym: "DT", settings: { speed_change: 1.2, adjust_pitch: true } }, { acronym: "BL" }];
    expect(normalizeMods(JSON.stringify(mods))).toEqual(mods);
    expect(normalizeMods(["hd", "bad acronym!", 3, null])).toEqual([{ acronym: "HD" }]);
    expect(normalizeMods("not json")).toEqual([]);
  });

  it("derives constant playback rates, and null for variable-rate mods", () => {
    expect(clockRate([{ acronym: "DT", settings: { speed_change: 1.2 } }])).toBe(1.2);
    expect(clockRate(["NC"])).toBe(1.5);
    expect(clockRate(["DC"])).toBe(0.75);
    expect(clockRate([{ acronym: "HT", settings: { speed_change: 0.9 } }])).toBe(0.9);
    expect(clockRate(["HD"])).toBe(1);
    expect(clockRate(["WU"])).toBeNull();
    expect(clockRate(["AS", "DT"])).toBeNull();
  });

  it("labels mods and their settings", () => {
    expect(modLabel({ acronym: "DT", settings: { speed_change: 1.2 } })).toBe("DT 1.2×");
    expect(modLabel({ acronym: "WU" })).toBe("WU 1→1.5×");
    expect(modSettingLabels({ acronym: "DA", settings: { approach_rate: 9.5, extended_limits: true } })).toEqual(["AR9.5", "extended limits: on"]);
    expect(modSettingLabels({ acronym: "DT", settings: { speed_change: 1.2 } })).toEqual([]);
  });

  it("decides stable vs lazer from build metadata first", () => {
    expect(isLazerScore({ build_id: 123, legacy_score_id: null })).toBe(true);
    expect(isLazerScore({ legacy_score_id: 42 })).toBe(false);
    expect(isLazerScore({ mods: ["CL"], statistics: { great: 1 } })).toBe(false);
    expect(isLazerScore({ build_id: 123, mods: ["CL"] })).toBe(true);
    expect(isLazerScore({ statistics: { slider_tail_hit: 3 } })).toBe(true);
  });

  it("has the standard catalog grouped in six categories, without other-mode mods", () => {
    expect(STANDARD_MODS.every((mod) => mod.modes.includes(0))).toBe(true);
    for (const acronym of ["1K", "10K", "FI", "CO", "SW", "FF"]) expect(STANDARD_MODS.some((mod) => mod.acronym === acronym)).toBe(false);
    for (const category of MOD_CATEGORIES) expect(STANDARD_MODS.some((mod) => mod.type === category.type)).toBe(true);
    for (const acronym of ["BL", "DA", "DC", "WU", "WD", "AS", "MR", "AC"]) expect(MOD_CATALOG.some((mod) => mod.acronym === acronym)).toBe(true);
  });
});

describe("rows", () => {
  it("drops failed plays", () => {
    expect(isPassed(score(1))).toBe(true);
    expect(isPassed(score(1, { passed: false }))).toBe(false);
    expect(isPassed(score(1, { rank: "F" }))).toBe(false);
  });

  it("maps lazer statistics to hit counts and marks live scores as linkable", () => {
    const row = scoreRow(score(7, { statistics: { great: 300, ok: 5, meh: 2, miss: 1, slider_tail_hit: 50 }, is_perfect_combo: true }), 9, 7, { pp: 1, source: "osu" });
    expect(row).toMatchObject({ count300: 300, count100: 5, count50: 2, countmiss: 1, perfect: true, score_link_status: "available", is_lazer: true });
    expect(scoreRow(score(7, { type: "score_best_osu" }), 9, 7, { pp: 1, source: "osu" }).score_link_status).toBe("unknown");
  });

  it("builds beatmap rows from compact or full payloads", () => {
    expect(beatmapRow({ id: 5, mode: "taiko" }, { id: 50, title: "T" })).toMatchObject({ id: 5, beatmapset_id: 50, mode_int: 1, title: "T", ar: null });
    expect(beatmapRow({ id: 5 })).toBeNull();
  });

  it("uses local PP when osu! has none or the map isn't ranked", () => {
    expect(wantsLocalPp(null, "ranked")).toBe(true);
    expect(wantsLocalPp(100, "ranked")).toBe(false);
    expect(wantsLocalPp(100, "approved")).toBe(false);
    expect(wantsLocalPp(100, "loved")).toBe(true);
    expect(wantsLocalPp(100, "graveyard")).toBe(true);
    expect(wantsLocalPp(100, null)).toBe(false);
  });
});

describe("local PP", () => {
  it("passes full mod settings and lazer tick statistics to rosu-pp", () => {
    const args = performanceArgs({ beatmapId: 1, mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }], isLazer: true, statistics: { great: 20, large_tick_hit: 5, small_tick_hit: 4, slider_tail_hit: 3 } });
    expect(args).toMatchObject({ clockRate: 1.2, lazer: true, n300: 20, largeTickHits: 5, smallTickHits: 4, sliderEndHits: 3 });
    expect(performanceArgs({ beatmapId: 1, isLazer: false }).sliderEndHits).toBeNull();
  });

  it("calculates real PP, and a custom DT rate changes it", () => {
    const base = { beatmapId: 1, accuracy: 0.98, maxCombo: 40, statistics: { great: 39, ok: 1 }, isLazer: false };
    const nomod = calculatePp(osuFile(), base);
    const dt = calculatePp(osuFile(), { ...base, mods: ["DT"] });
    const dt12 = calculatePp(osuFile(), { ...base, mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] });
    expect(nomod).toBeGreaterThan(0);
    expect(dt).toBeGreaterThan(nomod!);
    expect(dt12).toBeGreaterThan(nomod!);
    expect(dt12).toBeLessThan(dt!);
    expect(calculatePp(osuFile(), { ...base, mods: ["WU"] })).toBeNull();
  });

  it("downloads each map once, gives null for missing maps, and only throws in strict mode", async () => {
    const downloads: number[] = [];
    let fail = false;
    const calc = createPpCalculator(async (id) => {
      downloads.push(id);
      if (fail) throw new Error("HTTP 503");
      return id === 404 ? null : osuFile();
    });
    const input = { beatmapId: 1, accuracy: 1, maxCombo: 40, statistics: { great: 40 } };
    expect(await calc(input)).toBeGreaterThan(0);
    expect(await calc(input)).toBeGreaterThan(0);
    expect(downloads).toEqual([1]);
    expect(await calc({ ...input, beatmapId: 404 })).toBeNull();
    fail = true;
    expect(await calc({ ...input, beatmapId: 2 })).toBeNull();
    await expect(calc({ ...input, beatmapId: 3 }, { strict: true })).rejects.toBeInstanceOf(BeatmapFetchError);
    expect(await calc({ ...input, beatmapId: 4, mods: ["WD"] })).toBeNull();
  });
});

describe("filters", () => {
  it("parses query parameters leniently and round-trips them", () => {
    const params = new URLSearchParams(
      "q=  camellia ghost &sort=pp&order=asc&page=3&page_size=999&rank=ss,s,zz&mods=dt,hd&mods_optional=cl&mods_excluded=fl&mods_exact=true&best_only=true&status=Ranked,loved&min_pp=100&max_rate=1.5&perfect=false&date_from=2026-01-01",
    );
    const f = parseScoreFilters(params);
    expect(f).toMatchObject({
      q: "camellia ghost", sort: "pp", order: "asc", page: 3, pageSize: 200, rank: ["SS", "S"], mods: ["DT", "HD"],
      modsOptional: ["CL"], modsExcluded: ["FL"], modsExact: true, bestOnly: true, status: ["ranked", "loved"],
      minPp: 100, maxRate: 1.5, perfect: false, dateFrom: "2026-01-01",
    });
    expect(parseScoreFilters(filtersToParams(f))).toEqual(f);
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe("");
    expect(parseScoreFilters(new URLSearchParams("sort=hacked;drop&page=-1&min_pp=abc"))).toEqual(DEFAULT_FILTERS);
  });

  it("strips LIKE wildcards and punctuation from search words", () => {
    expect(searchWords("100% _pure_ Blue-Zenith!")).toEqual(["100", "pure", "Blue-Zenith"]);
  });
});

describe("CSV cells", () => {
  it("quotes everything, neutralizes formulas, keeps numbers and Unicode", () => {
    expect(csvCell('日本, "title"\nnext')).toBe('"日本, ""title""\nnext"');
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell(" @cmd")).toBe(`"' @cmd"`);
    expect(csvCell(-2)).toBe('"-2"');
    expect(csvCell(null)).toBe('""');
    expect(CSV_COLUMNS).toContain("mods_json");
    expect(CSV_COLUMNS).toContain("pp_source");
  });
});

describe("private guard", () => {
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

  it("allows IPs, localhost, single-label names and private suffixes", () => {
    for (const host of ["localhost:8080", "127.0.0.1:8080", "192.168.1.20:8080", "[::1]:8080", "homelab", "homelab:8080", "lab.local", "box.home.arpa", "box.tail1234.ts.net", "LAB.LAN."]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("refuses public hostnames unless listed in PRIVATE_HOSTS", () => {
    expect(isPrivateHost("scores.example.com")).toBe(false);
    expect(isPrivateHost("scores.example.com:8080", ["scores.example.com"])).toBe(true);
    expect(isPrivateHost(undefined)).toBe(false);
    expect(isPrivateHost("")).toBe(false);
  });

  it("refuses tunnelled requests, other sites' writes and opaque origins", () => {
    expect(checkPrivateRequest("GET", headers({ host: "localhost:8080" }), [])).toEqual({ ok: true });
    expect(checkPrivateRequest("GET", headers({ host: "localhost:8080", "cf-connecting-ip": "1.2.3.4" }), []).ok).toBe(false);
    expect(checkPrivateRequest("GET", headers({ host: "replays.example.com" }), []).ok).toBe(false);
    expect(checkPrivateRequest("POST", headers({ host: "localhost:8080", origin: "http://localhost:8080" }), [])).toEqual({ ok: true });
    expect(checkPrivateRequest("POST", headers({ host: "localhost:8080", origin: "https://evil.example" }), []).ok).toBe(false);
    expect(checkPrivateRequest("POST", headers({ host: "localhost:8080", origin: "null" }), []).ok).toBe(false);
    // Scripts like curl send no Origin at all.
    expect(checkPrivateRequest("POST", headers({ host: "localhost:8080" }), [])).toEqual({ ok: true });
  });
});
