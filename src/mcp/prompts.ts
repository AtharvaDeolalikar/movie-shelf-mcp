import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MOOD_NAMES } from "../shelf/moods.js";

const SHOW_RESULTS =
  "Present only titles the tool returned, with rating, year, language and IMDb link. Never invent titles or ratings.";

function userPrompt(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Slash-command style shortcuts; clients list them (Claude Code: /mcp__movie-shelf__<name>). */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "pick-something",
    {
      title: "Help me pick something to watch",
      description: "Asks a few quick questions (movie or series, mood, language, time) and then recommends.",
    },
    () =>
      userPrompt(
        "Help me pick something to watch",
        `Help me choose something to watch. First ask me these quick questions in a single message and wait for my answers:
1. Movie, series, or either?
2. What mood? (${MOOD_NAMES.join(", ")}, or something else)
3. Any language preference?
4. How much time do I have (e.g. under 2 hours)? Anything to avoid (genres)?
Tell me any can be skipped. Then call \`recommend\` with my answers (use mood, genre, exclude_genres, language and type; use year filters only if I mention them) and suggest 3 to 5 titles. ${SHOW_RESULTS} Offer to add any to my watchlist.`,
      ),
  );

  server.registerPrompt(
    "tonight",
    {
      title: "Tonight's pick",
      description: "Three random good unwatched picks, no questions asked.",
      argsSchema: {
        type: z.enum(["movie", "series", "any"]).optional().describe('"movie" (default), "series" or "any".'),
      },
    },
    ({ type }) =>
      userPrompt(
        "Tonight's pick",
        `Don't ask me anything. Call \`recommend\` with sort="shuffle", limit=3 and type="${type ?? "movie"}", then give me the three picks with a one-line pitch each. ${SHOW_RESULTS}`,
      ),
  );

  server.registerPrompt(
    "from-watchlist",
    {
      title: "Pick from my watchlist",
      description: "Chooses what to watch next from the saved watchlist.",
      argsSchema: {
        mood: z.string().optional().describe("Optional mood or genre to lean towards."),
      },
    },
    ({ mood }) =>
      userPrompt(
        "Pick from my watchlist",
        `Call \`list_watchlist\` (sort="rating") and pick the best 3 titles to watch next${mood ? `, leaning towards "${mood}"` : ""}. If the watchlist is empty, say so and offer to run \`recommend\` instead. ${SHOW_RESULTS}`,
      ),
  );

  server.registerPrompt(
    "binge-series",
    {
      title: "Find a series to binge",
      description: "Top unwatched series, optionally by language or genre.",
      argsSchema: {
        language: z.string().optional().describe('Original language, e.g. "Korean".'),
        genre: z.string().optional().describe('IMDb genre, e.g. "Crime".'),
      },
    },
    ({ language, genre }) =>
      userPrompt(
        "Find a series to binge",
        `Call \`recommend\` with type="series", limit=5${language ? `, language="${language}"` : ""}${genre ? `, genre="${genre}"` : ""}. Mention whether each is a miniseries and whether it is still running (end_year is null). ${SHOW_RESULTS}`,
      ),
  );
}
