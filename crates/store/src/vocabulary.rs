//! Vocabularies: named shelves of terms the speaker is likely to say, so cleanup can
//! fix names and jargon that Whisper mishears.
use serde::{Deserialize, Serialize};

use crate::StoreError;

pub const MAX_SHELVES: usize = 32;
pub const MAX_SHELF_TERMS: usize = 200;
pub const MAX_TERM_CHARS: usize = 48;
pub const MAX_SHELF_NAME_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vocabulary {
    pub version: u32,
    pub shelves: Vec<Shelf>,
}

impl Default for Vocabulary {
    fn default() -> Self {
        Self {
            version: 1,
            shelves: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: String,
    pub name: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub terms: Vec<String>,
}

/// A ready-made shelf the user can add with one click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preset {
    pub key: &'static str,
    pub name: &'static str,
    pub terms: &'static [&'static str],
}

/// Starter shelves: names and jargon speech recognition tends to mishear. Together they
/// stay within the cleanup prompt's term and length caps.
pub const PRESETS: &[Preset] = &[
    Preset {
        key: "programming",
        name: "Programming",
        terms: &[
            "T3 Code",
            "Claude Code",
            "Codex",
            "Cursor",
            "GitHub",
            "GitLab",
            "TypeScript",
            "JavaScript",
            "Rust",
            "Cargo",
            "Tauri",
            "React",
            "Vite",
            "Bun",
            "npm",
            "Node.js",
            "Next.js",
            "Tailwind",
            "PostgreSQL",
            "SQLite",
            "Docker",
            "Kubernetes",
            "Linux",
            "Wayland",
            "KDE",
            "Neovim",
            "VS Code",
            "localhost",
            "JSON",
            "YAML",
            "OAuth",
            "LLM",
        ],
    },
    Preset {
        key: "gaming-discord",
        name: "Gaming & Discord",
        terms: &[
            "Discord",
            "Discord Nitro",
            "Steam",
            "Steam Deck",
            "Valorant",
            "League of Legends",
            "Minecraft",
            "Fortnite",
            "Counter-Strike 2",
            "CS2",
            "Apex Legends",
            "Overwatch",
            "Elden Ring",
            "Baldur's Gate 3",
            "Helldivers 2",
            "Rocket League",
            "Roblox",
            "GTA",
            "PvP",
            "PvE",
            "MMO",
            "DPS",
            "NPC",
            "aggro",
            "nerf",
            "GG",
            "AFK",
            "noob",
            "VC",
            "DMs",
        ],
    },
    Preset {
        key: "twitch-streaming",
        name: "Twitch & Streaming",
        terms: &[
            "Twitch",
            "OBS",
            "Streamlabs",
            "StreamElements",
            "VOD",
            "raid",
            "gifted subs",
            "bits",
            "emote",
            "Prime Gaming",
            "Kick",
            "YouTube",
            "Pog",
            "PogChamp",
            "Kappa",
            "LUL",
            "KEKW",
            "OMEGALUL",
            "monkaS",
            "Sadge",
            "Copium",
            "Hopium",
            "hype train",
            "lurk",
            "BRB",
            "collab",
            "giveaway",
            "chatters",
            "mods",
            "VIP",
        ],
    },
];

fn enabled_default() -> bool {
    true
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Invalid(message.into())
}

/// Control characters become spaces, runs of whitespace one space, ends trimmed.
fn tidy(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Angle brackets could form chat-template tokens like `<turn|>` in the cleanup prompt.
/// Control characters never survive `tidy`.
fn safe_term(term: &str) -> bool {
    !term.contains(['<', '>'])
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// A comma- or newline-separated list as tidy, non-empty terms.
pub fn split_terms(text: &str) -> Vec<String> {
    text.split([',', '\n', '\r'])
        .map(tidy)
        .filter(|term| !term.is_empty())
        .collect()
}

impl Vocabulary {
    fn shelf_mut(&mut self, id: &str) -> Result<&mut Shelf, StoreError> {
        self.shelves
            .iter_mut()
            .find(|shelf| shelf.id == id)
            .ok_or_else(|| invalid("That shelf no longer exists."))
    }

    fn check_name(&self, name: &str, except: Option<&str>) -> Result<String, StoreError> {
        let name = tidy(name);
        if name.is_empty() {
            return Err(invalid("Give the shelf a name."));
        }
        if name.chars().count() > MAX_SHELF_NAME_CHARS {
            return Err(invalid(format!(
                "Shelf names can be at most {MAX_SHELF_NAME_CHARS} characters."
            )));
        }
        let taken = self
            .shelves
            .iter()
            .any(|shelf| Some(shelf.id.as_str()) != except && same(&shelf.name, &name));
        if taken {
            return Err(invalid(format!(
                "There is already a shelf called “{name}”."
            )));
        }
        Ok(name)
    }

    /// A new, enabled, empty shelf at the end.
    pub fn add_shelf(&mut self, name: &str) -> Result<&Shelf, StoreError> {
        if self.shelves.len() >= MAX_SHELVES {
            return Err(invalid(format!(
                "You can have at most {MAX_SHELVES} shelves."
            )));
        }
        let name = self.check_name(name, None)?;
        self.shelves.push(Shelf {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            enabled: true,
            terms: Vec::new(),
        });
        Ok(&self.shelves[self.shelves.len() - 1])
    }

    /// Adds the starter shelf `key` with its terms, all or nothing.
    pub fn add_preset(&mut self, key: &str) -> Result<&Shelf, StoreError> {
        let preset = PRESETS
            .iter()
            .find(|p| p.key == key)
            .ok_or_else(|| invalid("That starter shelf doesn’t exist."))?;
        let mut next = self.clone();
        let id = next.add_shelf(preset.name)?.id.clone();
        next.add_terms(&id, &preset.terms.join("\n"))?;
        *self = next;
        Ok(&self.shelves[self.shelves.len() - 1])
    }

    /// Starter shelves not on the list yet (matched by name).
    pub fn available_presets(&self) -> Vec<&'static Preset> {
        PRESETS
            .iter()
            .filter(|p| !self.shelves.iter().any(|shelf| same(&shelf.name, p.name)))
            .collect()
    }

    pub fn rename_shelf(&mut self, id: &str, name: &str) -> Result<(), StoreError> {
        let name = self.check_name(name, Some(id))?;
        self.shelf_mut(id)?.name = name;
        Ok(())
    }

    /// Deleting a shelf that is already gone is fine.
    pub fn delete_shelf(&mut self, id: &str) {
        self.shelves.retain(|shelf| shelf.id != id);
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), StoreError> {
        self.shelf_mut(id)?.enabled = enabled;
        Ok(())
    }

    /// Adds every term in a comma- or newline-separated `text`, skipping ones already
    /// on the shelf (case-insensitive). All or nothing: a term that is too long or holds
    /// `<` or `>`, or a full shelf, adds none. Returns how many were added.
    pub fn add_terms(&mut self, id: &str, text: &str) -> Result<usize, StoreError> {
        let shelf = self.shelf_mut(id)?;
        let mut new: Vec<String> = Vec::new();
        for term in split_terms(text) {
            if term.chars().count() > MAX_TERM_CHARS {
                return Err(invalid(format!(
                    "“{term}” is too long; terms can be at most {MAX_TERM_CHARS} characters."
                )));
            }
            if !safe_term(&term) {
                return Err(invalid(format!("“{term}” can’t contain < or >.")));
            }
            if !shelf.terms.iter().chain(&new).any(|t| same(t, &term)) {
                new.push(term);
            }
        }
        if shelf.terms.len() + new.len() > MAX_SHELF_TERMS {
            return Err(invalid(format!(
                "A shelf can hold at most {MAX_SHELF_TERMS} terms."
            )));
        }
        shelf.terms.extend_from_slice(&new);
        Ok(new.len())
    }

    /// Removes `term` (exact match first, else case-insensitive). A missing term is fine.
    pub fn remove_term(&mut self, id: &str, term: &str) -> Result<(), StoreError> {
        let shelf = self.shelf_mut(id)?;
        let at = shelf
            .terms
            .iter()
            .position(|t| t == term)
            .or_else(|| shelf.terms.iter().position(|t| same(t, term)));
        if let Some(at) = at {
            shelf.terms.remove(at);
        }
        Ok(())
    }

    /// Terms of the enabled shelves in order, without case-insensitive duplicates.
    /// Uncapped; the cleanup prompt applies its own limits.
    pub fn active_terms(&self) -> Vec<String> {
        let mut terms: Vec<String> = Vec::new();
        for term in self
            .shelves
            .iter()
            .filter(|shelf| shelf.enabled)
            .flat_map(|shelf| &shelf.terms)
        {
            if !terms.iter().any(|t| same(t, term)) {
                terms.push(term.clone());
            }
        }
        terms
    }

    /// Bring a file from disk (maybe hand-edited) within the limits.
    pub(crate) fn normalized(self) -> Self {
        let mut out = Vocabulary {
            version: self.version,
            shelves: Vec::new(),
        };
        for shelf in self.shelves {
            if out.shelves.len() >= MAX_SHELVES {
                break;
            }
            let name: String = tidy(&shelf.name)
                .chars()
                .take(MAX_SHELF_NAME_CHARS)
                .collect();
            let duplicate = out
                .shelves
                .iter()
                .any(|s| s.id == shelf.id || same(&s.name, &name));
            if name.is_empty() || shelf.id.trim().is_empty() || duplicate {
                log::warn!("vocabulary: dropping shelf {:?}", shelf.name);
                continue;
            }
            let mut terms: Vec<String> = Vec::new();
            for term in shelf.terms.iter().flat_map(|t| split_terms(t)) {
                let fits = term.chars().count() <= MAX_TERM_CHARS && safe_term(&term);
                if fits && terms.len() < MAX_SHELF_TERMS && !terms.iter().any(|t| same(t, &term)) {
                    terms.push(term);
                }
            }
            out.shelves.push(Shelf {
                id: shelf.id,
                name,
                enabled: shelf.enabled,
                terms,
            });
        }
        out
    }
}
