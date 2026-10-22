//! Built-in vocabulary packs (`src/wordPacks.ts`).

use std::sync::LazyLock;

use crate::types::{CustomWord, RuleKind};

string_enum! {
    pub enum WordPackId { Programming = "programming", Gaming = "gaming" }
}

/// A correct spelling, optionally followed by phrases it is often written as.
/// Listing the lowercase spelling also fixes its capitalization, which is only
/// safe for names that are not ordinary words.
pub type PackWord = &'static [&'static str];

#[derive(Debug, Clone, Copy)]
pub struct WordPack {
    pub id: WordPackId,
    pub name: &'static str,
    pub description: &'static str,
    pub words: &'static [PackWord],
}

pub const WORD_PACKS: &[WordPack] = &[
    WordPack {
        id: WordPackId::Programming,
        name: "Programming",
        description: "Languages, tools and terms for talking about code.",
        words: &[
        &["TypeScript", "typescript", "type script"],
        &["JavaScript", "javascript", "java script"],
        &["GitHub", "github", "git hub", "get hub"],
        &["GitLab", "gitlab", "git lab"],
        &["npm", "npm"],
        &["pnpm", "pnpm"],
        &["Bun"],
        &["Node.js", "node js", "nodejs"],
        &["Next.js", "next js", "nextjs"],
        &["Vite"],
        &["Tailwind"],
        &["Electron"],
        &["Docker"],
        &["Kubernetes", "kubernetes"],
        &["kubectl", "kubectl", "kubectle", "cube control", "kube control", "cube cuttle"],
        &["nginx", "nginx", "engine x"],
        &["PostgreSQL", "postgresql", "postgre SQL", "postgres QL"],
        &["SQLite", "sqlite", "SQL lite", "sequel lite"],
        &["Redis", "redis"],
        &["MongoDB", "mongodb", "mongo DB"],
        &["GraphQL", "graphql", "graph QL"],
        &["JSON", "json"],
        &["YAML", "yaml"],
        &["OAuth", "oauth", "o auth"],
        &["JWT", "jwt"],
        &["localhost", "local host"],
        &["CLI"],
        &["SDK"],
        &["pull request"],
        &["rebase"],
        &["merge conflict"],
        &["refactor"],
        &["async"],
        &["await"],
        &["boolean"],
        &["enum"],
        &["regex", "reg ex"],
        &["ESLint", "eslint", "es lint"],
        &["Prettier"],
        &["VS Code", "vs code"],
        &["Neovim", "neovim", "neo vim"],
        &["tmux", "tmux", "t mux"],
        &["SSH"],
        &["sudo"],
        &["systemd", "system d"],
        &["macOS", "macos", "mac OS"],
        &["CI/CD", "CI CD"],
        &["CUDA", "cuda"],
        &["PyTorch", "pytorch", "pie torch", "py torch"],
        &["LLM", "llm"],
        &["ChatGPT", "chatgpt", "chat GPT"],
        &["Hugging Face"],
        &["frontend"],
        &["backend"],
        ],
    },
    WordPack {
        id: WordPackId::Gaming,
        name: "Gaming",
        description: "Game slang and titles for voice chat, such as Discord.",
        words: &[
        &["GG", "gg", "gee gee", "g g"],
        &["noob"],
        &["nerf"],
        &["buff"],
        &["OP"],
        &["meta"],
        &["aggro"],
        &["respawn"],
        &["cooldown"],
        &["ult"],
        &["AFK", "afk", "a f k"],
        &["BRB", "brb", "b r b"],
        &["lag"],
        &["FPS", "fps", "f p s"],
        &["clutch"],
        &["one-shot"],
        &["headshot"],
        &["flank"],
        &["peek"],
        &["loot"],
        &["DPS", "dps", "d p s"],
        &["tank"],
        &["healer"],
        &["jungle"],
        &["gank"],
        &["crit"],
        &["hitbox", "hit box"],
        &["lobby"],
        &["ranked"],
        &["MMR", "mmr", "m m r"],
        &["Elo"],
        &["matchmaking"],
        &["speedrun", "speed run"],
        &["grind"],
        &["XP"],
        &["NPC", "npc", "n p c"],
        &["loadout"],
        &["battle pass"],
        &["smurf"],
        &["tryhard"],
        &["carry"],
        &["griefing"],
        &["Discord"],
        &["Steam"],
        &["Twitch"],
        &["Valorant", "valorant"],
        &["League of Legends", "league of legends"],
        &["Counter-Strike", "counter strike"],
        &["CS2", "cs2", "CS 2", "CS two"],
        &["Fortnite", "fortnite", "fort night"],
        &["Minecraft", "minecraft", "mine craft"],
        &["Overwatch", "overwatch", "over watch"],
        &["Elden Ring", "elden ring"],
        &["Rocket League", "rocket league"],
        ],
    },
];

pub fn is_word_pack_id(value: &str) -> bool {
    WordPackId::parse(value).is_some()
}

static PACK_RULES: LazyLock<Vec<(WordPackId, Vec<CustomWord>)>> = LazyLock::new(|| {
    WORD_PACKS
        .iter()
        .map(|pack| {
            let rules = pack
                .words
                .iter()
                .map(|words| CustomWord {
                    id: format!("pack:{}:{}", pack.id, words[0]),
                    kind: Some(RuleKind::Correction),
                    term: words[0].to_owned(),
                    sounds_like: String::new(),
                    aliases: Some(words[1..].iter().map(|alias| (*alias).to_owned()).collect()),
                    replacement: String::new(),
                    enabled: true,
                    ..CustomWord::default()
                })
                .collect();
            (pack.id, rules)
        })
        .collect()
});

/// The rules of one pack.
pub fn pack_rules(id: WordPackId) -> &'static [CustomWord] {
    PACK_RULES.iter().find(|(pack, _)| *pack == id).map_or(&[], |(_, rules)| rules)
}

/// Your own rules first, so they win any conflict and are sent as recognition
/// hints before pack words; then the words of each enabled pack.
pub fn active_rules(custom_words: &[CustomWord], word_packs: &[WordPackId]) -> Vec<CustomWord> {
    let mut rules = custom_words.to_vec();
    for id in word_packs {
        rules.extend_from_slice(pack_rules(*id));
    }
    rules
}
