/// <reference types="jest" />

import {
  collectSourceTitles,
  formatQuantity,
  getMeasureDisplay,
  normalizeMeasureText,
  parseIngredient,
  summarizeEntries,
  type QuantityEntry,
} from "@/lib/shopping-list";

const buildEntry = (overrides: Partial<QuantityEntry>): QuantityEntry => ({
  id: overrides.id ?? `entry-${Math.random()}`,
  quantityText: overrides.quantityText ?? "",
  amountValue: overrides.amountValue ?? null,
  measureText: overrides.measureText ?? "",
  sourceRecipeId: overrides.sourceRecipeId,
  sourceRecipeTitle: overrides.sourceRecipeTitle,
});

describe("parseIngredient", () => {
  it("parses quantity, measure, and label", () => {
    const parsed = parseIngredient("2 1/2 cups of flour");
    expect(parsed).toEqual(
      expect.objectContaining({
        label: "Flour",
        normalizedLabel: "flour",
        quantityText: "2 1/2 cups",
        amountValue: 2.5,
        measureText: "cup",
      })
    );
  });

  it("returns empty fields for blank input", () => {
    const parsed = parseIngredient("   ");
    expect(parsed).toEqual({
      label: "",
      normalizedLabel: "",
      quantityText: "",
      amountValue: null,
      measureText: "",
    });
  });
});

describe("summarizeEntries", () => {
  it("aggregates compatible measured entries", () => {
    const entries: QuantityEntry[] = [
      buildEntry({ amountValue: 1, measureText: "cup", quantityText: "1 cup" }),
      buildEntry({ amountValue: 2, measureText: "cups", quantityText: "2 cups" }),
    ];

    expect(summarizeEntries(entries)).toBe("3 cups");
  });

  it("falls back to concatenating quantity text for mixed entries", () => {
    const entries: QuantityEntry[] = [
      buildEntry({ quantityText: "As listed" }),
      buildEntry({ amountValue: 0.5, measureText: "cup", quantityText: "1/2 cup" }),
    ];

    expect(summarizeEntries(entries)).toBe("As listed + 1/2 cup");
  });
});

describe("collectSourceTitles", () => {
  it("returns unique non-empty titles", () => {
    const titles = collectSourceTitles([
      { sourceRecipeTitle: "Soup" },
      { sourceRecipeTitle: "  Soup  " },
      { sourceRecipeTitle: "Salad" },
      { sourceRecipeTitle: undefined },
    ]);

    expect(titles).toEqual(["Soup", "Salad"]);
  });
});

describe("normalizeMeasureText", () => {
  it("converts aliases to canonical measure names", () => {
    expect(normalizeMeasureText("Tablespoons")).toBe("tablespoon");
    expect(normalizeMeasureText("TBSP")).toBe("tablespoon");
    expect(normalizeMeasureText("ml")).toBe("milliliter");
  });
});

describe("getMeasureDisplay", () => {
  it("pluralizes canonical measures based on quantity", () => {
    expect(getMeasureDisplay("cup", 1)).toBe("cup");
    expect(getMeasureDisplay("cup", 2)).toBe("cups");
  });

  it("pluralizes unknown measures by appending 's'", () => {
    expect(getMeasureDisplay("pinchful", 2)).toBe("pinchfuls");
  });
});

describe("formatQuantity", () => {
  it("formats numeric quantities without trailing zeros", () => {
    expect(formatQuantity(2.5, "cup")).toBe("2.5 cups");
  });

  it("omits measure text when missing", () => {
    expect(formatQuantity(3, "")).toBe("3");
  });
});
