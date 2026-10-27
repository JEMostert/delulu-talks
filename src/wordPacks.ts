import type { CustomWord } from "./types";

export type WordPackId = "programming" | "gaming";

/**
 * A correct spelling, optionally followed by phrases it is often written as.
 * Listing the lowercase spelling also fixes its capitalization, which is only
 * safe for names that are not ordinary words.
 */
type PackWord = readonly [term: string, ...heardAs: string[]];

export type WordPack = {
  id: WordPackId;
  name: string;
  words: readonly PackWord[];
};

export const WORD_PACKS: readonly WordPack[] = [
  {
    id: "programming",
    name: "Programming",
    words: [
      ["TypeScript", "typescript", "type script"],
      ["JavaScript", "javascript", "java script"],
      ["GitHub", "github", "git hub", "get hub"],
      ["GitLab", "gitlab", "git lab"],
      ["npm", "npm"],
      ["pnpm", "pnpm"],
      ["Bun"],
      ["Node.js", "node js", "nodejs"],
      ["Next.js", "next js", "nextjs"],
      ["Vite"],
      ["Tailwind"],
      ["Electron"],
      ["Docker"],
      ["Kubernetes", "kubernetes"],
      [
        "kubectl",
        "kubectl",
        "kubectle",
        "cube control",
        "kube control",
        "cube cuttle",
      ],
      ["nginx", "nginx", "engine x"],
      ["PostgreSQL", "postgresql", "postgre SQL", "postgres QL"],
      ["SQLite", "sqlite", "SQL lite", "sequel lite"],
      ["Redis", "redis"],
      ["MongoDB", "mongodb", "mongo DB"],
      ["GraphQL", "graphql", "graph QL"],
      ["JSON", "json"],
      ["YAML", "yaml"],
      ["OAuth", "oauth", "o auth"],
      ["JWT", "jwt"],
      ["localhost", "local host"],
      ["CLI"],
      ["SDK"],
      ["pull request"],
      ["rebase"],
      ["merge conflict"],
      ["refactor"],
      ["async"],
      ["await"],
      ["boolean"],
      ["enum"],
      ["regex", "reg ex"],
      ["ESLint", "eslint", "es lint"],
      ["Prettier"],
      ["VS Code", "vs code"],
      ["Neovim", "neovim", "neo vim"],
      ["tmux", "tmux", "t mux"],
      ["SSH"],
      ["sudo"],
      ["systemd", "system d"],
      ["macOS", "macos", "mac OS"],
      ["CI/CD", "CI CD"],
      ["CUDA", "cuda"],
      ["PyTorch", "pytorch", "pie torch", "py torch"],
      ["LLM", "llm"],
      ["ChatGPT", "chatgpt", "chat GPT"],
      ["Hugging Face"],
      ["frontend"],
      ["backend"],
    ],
  },
  {
    id: "gaming",
    name: "Gaming",
    words: [
      ["GG", "gg", "gee gee", "g g"],
      ["noob"],
      ["nerf"],
      ["buff"],
      ["OP"],
      ["meta"],
      ["aggro"],
      ["respawn"],
      ["cooldown"],
      ["ult"],
      ["AFK", "afk", "a f k"],
      ["BRB", "brb", "b r b"],
      ["lag"],
      ["FPS", "fps", "f p s"],
      ["clutch"],
      ["one-shot"],
      ["headshot"],
      ["flank"],
      ["peek"],
      ["loot"],
      ["DPS", "dps", "d p s"],
      ["tank"],
      ["healer"],
      ["jungle"],
      ["gank"],
      ["crit"],
      ["hitbox", "hit box"],
      ["lobby"],
      ["ranked"],
      ["MMR", "mmr", "m m r"],
      ["Elo"],
      ["matchmaking"],
      ["speedrun", "speed run"],
      ["grind"],
      ["XP"],
      ["NPC", "npc", "n p c"],
      ["loadout"],
      ["battle pass"],
      ["smurf"],
      ["tryhard"],
      ["carry"],
      ["griefing"],
      ["Discord"],
      ["Steam"],
      ["Twitch"],
      ["Valorant", "valorant"],
      ["League of Legends", "league of legends"],
      ["Counter-Strike", "counter strike"],
      ["CS2", "cs2", "CS 2", "CS two"],
      ["Fortnite", "fortnite", "fort night"],
      ["Minecraft", "minecraft", "mine craft"],
      ["Overwatch", "overwatch", "over watch"],
      ["Elden Ring", "elden ring"],
      ["Rocket League", "rocket league"],
    ],
  },
];

export const isWordPackId = (value: unknown): value is WordPackId =>
  WORD_PACKS.some((pack) => pack.id === value);

const packRules = new Map(
  WORD_PACKS.map((pack) => [
    pack.id,
    pack.words.map(([term, ...heardAs]): CustomWord => ({
      id: `pack:${pack.id}:${term}`,
      kind: "correction",
      term,
      soundsLike: "",
      aliases: heardAs,
      replacement: "",
      enabled: true,
    })),
  ]),
);

/**
 * Your own rules first, so they win any conflict and are sent as recognition
 * hints before pack words; then the words of each enabled pack.
 */
export function activeRules(settings: {
  customWords: readonly CustomWord[];
  wordPacks: readonly WordPackId[];
}): CustomWord[] {
  return [
    ...settings.customWords,
    ...settings.wordPacks.flatMap((id) => packRules.get(id) ?? []),
  ];
}
