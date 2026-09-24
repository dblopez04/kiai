import { describe, expect, it } from "vitest";
import { pageNumbers, pager } from "../src/http/views.ts";

describe("pageNumbers", () => {
  it("lists every page when there are few", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(1, 7)).toEqual([1, 2, 3, null, 7]);
  });

  it("keeps the first and last page with gaps around the current one", () => {
    expect(pageNumbers(1, 42)).toEqual([1, 2, 3, null, 42]);
    expect(pageNumbers(10, 42)).toEqual([1, null, 8, 9, 10, 11, 12, null, 42]);
    expect(pageNumbers(42, 42)).toEqual([1, null, 40, 41, 42]);
  });

  it("shows a single skipped page instead of an ellipsis", () => {
    expect(pageNumbers(5, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, null, 10]);
    expect(pageNumbers(6, 10)).toEqual([1, null, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("pager", () => {
  const link = (p: number) => `/?page=${p}`;

  it("renders nothing for a single page", () => {
    expect(pager({ page: 1, total_pages: 1 }, link)).toBe("");
  });

  it("links each page button and marks the current one", async () => {
    const out = String(await pager({ page: 10, total_pages: 42 }, link));
    expect(out).toContain('href="/?page=9" rel="prev"');
    expect(out).toContain('href="/?page=11" rel="next"');
    expect(out).toContain('href="/?page=1">1</a>');
    expect(out).toContain('href="/?page=42">42</a>');
    expect(out).toContain('aria-current="page">10</span>');
    expect(out).not.toContain('href="/?page=10"');
  });

  it("disables Prev on the first page", async () => {
    const out = String(await pager({ page: 1, total_pages: 3 }, link));
    expect(out).toContain('<span class="button disabled">‹ Prev</span>');
    expect(out).toContain('href="/?page=2" rel="next"');
  });
});
