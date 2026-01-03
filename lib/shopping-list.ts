export type QuantityEntry = {
  id: string;
  quantityText: string;
  amountValue: number | null;
  measureText: string;
  sourceRecipeId?: string;
  sourceRecipeTitle?: string;
};

export type ShoppingListRecord = {
  label: string;
  entries: QuantityEntry[];
  order: number;
  crossedOffAt?: number | null;
};

export type ShoppingListState = Record<string, ShoppingListRecord>;

export type ShoppingListItem = {
  id: string;
  storageKey: string;
  label: string;
  unitSummary: string;
  occurrences: number;
  sources: string[];
  order: number;
  ownerId: string;
  ownerLabel: string;
  isSelf: boolean;
  crossedOffAt?: number | null;
};

export type IncomingIngredient = {
  value: string;
  recipeId?: string;
  recipeTitle?: string;
};

export type ParsedIngredient = {
  label: string;
  normalizedLabel: string;
  quantityText: string;
  amountValue: number | null;
  measureText: string;
};

type MeasureDefinition = {
  canonical: string;
  plural?: string;
  aliases: string[];
};

type MeasureInfo = {
  canonical: string;
  plural: string;
};

const MEASURE_DEFINITIONS: MeasureDefinition[] = [
  { canonical: "bag", aliases: ["bag", "bags"] },
  { canonical: "bottle", aliases: ["bottle", "bottles"] },
  { canonical: "bunch", aliases: ["bunch", "bunches"] },
  { canonical: "can", aliases: ["can", "cans"] },
  { canonical: "clove", plural: "cloves", aliases: ["clove", "cloves"] },
  { canonical: "cup", aliases: ["cup", "cups"] },
  { canonical: "dash", aliases: ["dash", "dashes"] },
  { canonical: "ear", plural: "ears", aliases: ["ear", "ears"] },
  { canonical: "gram", plural: "grams", aliases: ["gram", "grams", "g"] },
  { canonical: "handful", aliases: ["handful", "handfuls"] },
  { canonical: "head", aliases: ["head", "heads"] },
  { canonical: "kilogram", plural: "kilograms", aliases: ["kilogram", "kilograms", "kg"] },
  { canonical: "pound", plural: "pounds", aliases: ["pound", "pounds", "lb", "lbs"] },
  { canonical: "liter", plural: "liters", aliases: ["liter", "liters", "l"] },
  {
    canonical: "milliliter",
    plural: "milliliters",
    aliases: ["milliliter", "milliliters", "ml"],
  },
  { canonical: "ounce", plural: "ounces", aliases: ["ounce", "ounces", "oz"] },
  { canonical: "package", aliases: ["package", "packages"] },
  { canonical: "pack", aliases: ["pack", "packs"] },
  { canonical: "pinch", aliases: ["pinch", "pinches"] },
  { canonical: "pint", aliases: ["pint", "pints"] },
  { canonical: "quart", aliases: ["quart", "quarts"] },
  { canonical: "slice", aliases: ["slice", "slices"] },
  { canonical: "sprig", aliases: ["sprig", "sprigs"] },
  { canonical: "stick", aliases: ["stick", "sticks"] },
  {
    canonical: "tablespoon",
    plural: "tablespoons",
    aliases: ["tablespoon", "tablespoons", "tbsp", "tbsps"],
  },
  {
    canonical: "teaspoon",
    plural: "teaspoons",
    aliases: ["teaspoon", "teaspoons", "tsp", "tsps"],
  },
];

export const MEASURE_OPTIONS = MEASURE_DEFINITIONS.map(
  ({ canonical, plural }) => ({
    value: canonical,
    label: plural ?? `${canonical}s`,
  })
);

const MEASURE_LOOKUP: Record<string, MeasureInfo> = {};

const IRREGULAR_PLURALS: Record<string, string> = {
  men: "man",
  women: "woman",
  children: "child",
  teeth: "tooth",
  feet: "foot",
  geese: "goose",
  mice: "mouse",
  lice: "louse",
  knives: "knife",
  wives: "wife",
  lives: "life",
  leaves: "leaf",
  loaves: "loaf",
  halves: "half",
  wolves: "wolf",
  calves: "calf",
  shelves: "shelf",
  thieves: "thief",
  tomatoes: "tomato",
  potatoes: "potato",
  heroes: "hero",
  echoes: "echo",
  buffaloes: "buffalo",
  mosquitoes: "mosquito",
  indices: "index",
  matrices: "matrix",
  fungi: "fungus",
  cacti: "cactus",
  nuclei: "nucleus",
};

const UNCOUNTABLE_TOKENS = new Set([
  "fish",
  "sheep",
  "deer",
  "money",
  "rice",
  "bread",
  "water",
  "salt",
  "sugar",
  "flour",
]);

MEASURE_DEFINITIONS.forEach(({ canonical, plural, aliases }) => {
  const info: MeasureInfo = { canonical, plural: plural ?? `${canonical}s` };
  aliases.forEach((alias) => {
    MEASURE_LOOKUP[alias.toLowerCase()] = info;
  });
});

const UNICODE_FRACTIONS: Record<string, number> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

export const MEASURE_WORDS = new Set(Object.keys(MEASURE_LOOKUP));

export const normalizeLabel = (value: string) => {
  const collapsed = value.trim().toLowerCase();
  if (!collapsed) {
    return "";
  }
  const tokens = collapsed.split(/\s+/).map((token) => singularizeToken(token));
  return tokens.join(" ");
};

export function parseIngredient(rawValue: string): ParsedIngredient {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {
      label: "",
      normalizedLabel: "",
      quantityText: "",
      amountValue: null,
      measureText: "",
    };
  }

  const tokens = trimmed.split(/\s+/);
  const quantityTokens: string[] = [];
  let amountValue: number | null = null;
  let numericTokensConsumed = 0;

  while (tokens.length) {
    const numericValue = parseNumericToken(tokens[0]);
    if (numericValue === null) {
      break;
    }
    amountValue = (amountValue ?? 0) + numericValue;
    quantityTokens.push(tokens.shift()!);
    numericTokensConsumed += 1;
  }

  if (amountValue !== null) {
    while (tokens.length) {
      const lower = tokens[0].toLowerCase();
      if (MEASURE_WORDS.has(lower)) {
        quantityTokens.push(tokens.shift()!);
        continue;
      }
      break;
    }

    while (tokens.length && tokens[0].toLowerCase() === "of") {
      tokens.shift();
    }
  }

  const labelRaw = tokens.join(" ").trim() || trimmed;
  const label = formatLabel(labelRaw);
  const quantityText = quantityTokens.join(" ").trim();
  const measureTextRaw = quantityTokens
    .slice(numericTokensConsumed)
    .join(" ")
    .trim();
  const measureText = normalizeMeasureText(measureTextRaw) || measureTextRaw;

  return {
    label,
    normalizedLabel: normalizeLabel(label),
    quantityText,
    amountValue,
    measureText,
  };
}

export function summarizeEntries(entries: QuantityEntry[]): string {
  if (!entries.length) return "—";
  const measuredEntries = entries.filter((entry) => entry.amountValue !== null);
  const firstMeasure = normalizeMeasureText(
    measuredEntries[0]?.measureText || ""
  );
  const canAggregate =
    measuredEntries.length === entries.length &&
    measuredEntries.every(
      (entry) => normalizeMeasureText(entry.measureText) === firstMeasure
    );

  if (canAggregate) {
    const total = measuredEntries.reduce(
      (sum, entry) => sum + (entry.amountValue ?? 0),
      0
    );
    return formatQuantity(total, firstMeasure);
  }

  return entries.map((entry) => entry.quantityText || "As listed").join(" + ");
}

export function collectSourceTitles(
  entries: Array<{ sourceRecipeTitle?: string | null }>
): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => entry.sourceRecipeTitle?.trim())
        .filter((title): title is string => Boolean(title))
    )
  );
}

export function normalizeMeasureText(value: string) {
  if (!value) return "";
  return value
    .split(/\s+/)
    .map(
      (token) => MEASURE_LOOKUP[token.toLowerCase()]?.canonical ?? token.toLowerCase()
    )
    .join(" ")
    .trim();
}

export function getMeasureDisplay(value: string, quantity: number) {
  if (!value) return "";
  const info = MEASURE_LOOKUP[value.toLowerCase()];
  if (!info) {
    const needsPlural = Math.abs(quantity - 1) > 1e-9;
    if (!needsPlural) return value;
    return value.endsWith("s") ? value : `${value}s`;
  }
  const needsPlural = Math.abs(quantity - 1) > 1e-9;
  return needsPlural ? info.plural : info.canonical;
}

function formatLabel(value: string) {
  return value
    .split(/\s+/)
    .map((segment) =>
      segment ? segment[0].toUpperCase() + segment.slice(1) : ""
    )
    .join(" ")
    .trim();
}

function singularizeToken(token: string) {
  if (!token) {
    return token;
  }
  if (!/^[a-z]+$/.test(token)) {
    return token;
  }
  if (UNCOUNTABLE_TOKENS.has(token)) {
    return token;
  }
  if (IRREGULAR_PLURALS[token]) {
    return IRREGULAR_PLURALS[token];
  }
  if (token.endsWith("ies") && token.length > 3) {
    return token.slice(0, -3) + "y";
  }
  if (token.endsWith("ves") && token.length > 3) {
    return token.slice(0, -3) + "f";
  }
  if (/(ches|shes|sses|xes|zes)$/.test(token) && token.length > 3) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function parseNumericToken(token: string): number | null {
  if (UNICODE_FRACTIONS[token]) {
    return UNICODE_FRACTIONS[token];
  }
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  if (/^\d+\.\d+$/.test(token)) {
    return Number(token);
  }
  if (/^\d+\/\d+$/.test(token)) {
    const [numerator, denominator] = token.split("/").map(Number);
    if (!denominator) return null;
    return numerator / denominator;
  }
  return null;
}

export function formatQuantity(value: number, measureText: string) {
  const rounded = Number(value.toFixed(2));
  const base = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/\.0+$/, "");
  if (!measureText) {
    return base;
  }
  const displayMeasure = getMeasureDisplay(measureText, rounded);
  return `${base} ${displayMeasure}`.trim();
}