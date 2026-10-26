/**
 * TMDB has no "mood" field, so a mood is a curated bundle of TMDB keyword
 * fragments: a movie matches if any of its keywords contains any fragment.
 * Tune the lists here; no re-import is needed. `excludeGenres` drops genres
 * that contradict the mood.
 */
export interface MoodDefinition {
  description: string;
  keywords: readonly string[];
  excludeGenres?: readonly string[];
}

const MOOD_TABLE = {
  "feel-good": {
    description: "warm, uplifting, leaves you smiling",
    keywords: ["feel good", "feel-good", "heartwarming", "uplifting", "inspir", "wholesome", "friendship", "happy ending", "optimis"],
    excludeGenres: ["Horror", "War"],
  },
  funny: {
    description: "laugh-out-loud, satirical or absurd",
    keywords: ["comedy", "humor", "satire", "parody", "spoof", "slapstick", "absurd", "farce", "dark comedy"],
  },
  romantic: {
    description: "love stories and relationships",
    keywords: ["romance", "falling in love", "love triangle", "first love", "love at first sight", "wedding", "long-distance relationship", "unrequited love"],
  },
  emotional: {
    description: "moving, tearjerking, bittersweet",
    keywords: ["grief", "tearjerker", "tragedy", "loss of loved one", "coming of age", "sacrifice", "redemption", "terminal illness", "bittersweet"],
  },
  tense: {
    description: "edge-of-your-seat suspense",
    keywords: ["suspense", "tension", "hostage", "heist", "survival", "cat and mouse", "manhunt", "kidnapping", "race against time", "conspiracy"],
  },
  dark: {
    description: "bleak, gritty or disturbing",
    keywords: ["dark", "disturbing", "brutal", "gritty", "bleak", "nihilis", "serial killer", "psychological", "revenge", "violence"],
    excludeGenres: ["Family", "Animation"],
  },
  "mind-bending": {
    description: "twists, puzzles and reality-warping plots",
    keywords: ["mind-bend", "mindbend", "twist", "nonlinear", "non-linear", "time loop", "time travel", "dream", "unreliable narrator", "parallel universe", "surreal", "simulation"],
  },
  "thought-provoking": {
    description: "ideas, moral questions, social commentary",
    keywords: ["philosoph", "social commentary", "existential", "moral dilemma", "dystopia", "artificial intelligence", "corruption", "class", "political"],
  },
  epic: {
    description: "sweeping scale, big battles and sagas",
    keywords: ["epic", "battle", "kingdom", "medieval", "saga", "ancient", "empire", "rebellion", "quest"],
  },
  cozy: {
    description: "gentle, low-stakes, comfort viewing",
    keywords: ["small town", "slice of life", "road trip", "cooking", "food", "village", "family dinner", "cosy", "cozy"],
    excludeGenres: ["Horror", "Thriller", "War"],
  },
} as const satisfies Record<string, MoodDefinition>;

export type MoodName = keyof typeof MOOD_TABLE;
export const MOODS: Record<MoodName, MoodDefinition> = MOOD_TABLE;
export const MOOD_NAMES = Object.keys(MOODS) as MoodName[];

/** Case-insensitive; spaces and underscores count as hyphens ("feel good" -> "feel-good"). */
export function normaliseMood(input: string): MoodName | null {
  const key = input.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (MOOD_NAMES as string[]).includes(key) ? (key as MoodName) : null;
}
