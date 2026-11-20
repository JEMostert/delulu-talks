# Delulu FM mix: IPC for the page

The station no longer has one fixed direction. The listener keeps a **mix**: a pool of genres and a pool of moods, each entry on or off, a surprise chance, vocals and energy that may be "any", and a song-length range. For every new song the station draws one genre, one mood, a length within the range and a concrete value for every "any". It stores the draw on the song, so the page can show what each song is.

The backend lives in `crates/radio/src/mix.rs` (catalogue, draw, shuffle, stations) and `crates/radio/src/station.rs` (state, feedback, lock, saved songs). The Tauri commands are in `src-tauri/src/radio.rs`. The TypeScript types and wrappers are in `ui/src/ipc.ts`; `ui/src/mock.ts` mirrors all of them for `bun run dev`.

## How a song is drawn

- **Genre:** one enabled genre, weighted by likes and dislikes. With probability `surprise` % it comes instead from a genre that is off, and the song is marked `surprise`. With no genre on, any catalogue genre can come.
- **Repeats:** with two or more genres in the pool, never the same genre three songs in a row. With three or more, never the same genre twice in a row.
- **Mood:** one enabled mood (any mood when none is on).
- **"Any" choices:** vocals is instrumental about one time in three. Energy is uniform.
- **Length:** a length between `lengthMinSeconds` and `lengthMaxSeconds` (default 2:00–4:30, allowed 1:00–5:00), on a 5-second grid, every value equally likely. Equal bounds give a fixed length. ACE-Step makes exactly that length. The lyric writer sizes the words to it: about one sung line per 5–9 seconds, with writer tokens and the fallback form scaled to match. The item records the target as `provenance.targetSeconds`; `seconds` is the length actually made.
- **Lock:** while a genre lock holds, only that genre is drawn.
- **Request:** a request song draws no genre or mood. The request decides its style, and it has `request` set and `genre`/`mood` null.
- **Mix changes:** a change applies to songs not written yet. The song being written is drawn again. Ready songs keep their draw.
- **Engine tags:** the drawn genre and mood reach the lyric writer's prompt and the music engine's style tags, for both ACE-Step generators.

## Commands

Every command answers with the full `Radio` view and also emits it as the `radio` event. In daemon-client mode (`DELULU_DAEMON=1`) the radio is unavailable, as before. Every command there returns the "Delulu FM is not available…" error.

| Command (wrapper) | Arguments | Does |
|---|---|---|
| `radio_mix` (`radioMix`) | `mix: RadioMix` | Replaces the mix (toggles, custom names, surprise, choices, host, language, theme). It replaces `radio_direction`. |
| `radio_shuffle` (`radioShuffle`) | none | The station rolls a random mix: about 30 % of genres on (at least two), about 40 % of moods on (at least one), surprise 0–40 % in steps of 5. Everything else is kept. |
| `radio_station_save` (`radioStationSave`) | `name` | Saves the mix as a station. A station of the listener's with that name (any case) is updated. A built-in station's name is refused. At most 24 stations; names up to 24 characters. |
| `radio_station_rename` (`radioStationRename`) | `id, name` | Built-in stations and names already taken are refused. |
| `radio_station_delete` (`radioStationDelete`) | `id` | Built-in stations are refused. |
| `radio_station_activate` (`radioStationActivate`) | `id` | Tunes the mix to the station. Host and language stay. |
| `radio_feedback` (`radioFeedback`) | `id, feedback: "like" \| "dislike" \| null` | Sets the song's verdict. Like multiplies its genre's draw weight by 1.5 and dislike divides it, within 0.25–4. Changing or taking back a verdict undoes the earlier one, and pressing the same verdict twice changes nothing. **Disliking the song on air also skips it.** |
| `radio_reset_feedback` (`radioResetFeedback`) | `genre: string \| null` | Forgets the weights and verdicts of one genre, or of all genres with null. |
| `radio_lock` (`radioLock`) | `songs: number \| null` | Draws only the genre of the song on air: `null` for `lockSongs` (5) songs, `n` for n songs (1–50), `0` until unlocked. Refused when the song on air has no genre. Queued songs keep theirs. |
| `radio_unlock` (`radioUnlock`) | none | Ends the lock. |
| `radio_save` (`radioSave`) | `id` | Keeps a song (on air, queued, played, or a replay) out of clean-up. Its audio and words stay, and it is listed in `saved`. At most 100. |
| `radio_unsave` (`radioUnsave`) | `id` | Lets the song go again. Its audio is deleted once nothing else plays or lists it. |
| `radio_play_saved` (`radioPlaySaved`) | `id` (a `saved` item id) | Plays the saved song now, labelled as a replay. It starts the station like Play. |

These are unchanged: `get_radio`, `check_radio`, `radio_play`, `radio_pause`, `radio_off`, `radio_skip`, `radio_volume`, `radio_music`, `radio_request`. The events are unchanged too: `radio` (the view) and `radio-error`.

Mix edits, shuffle and station activation return an error if the new mix cannot be saved, keeping the previous mix and pending song draw. The page keeps an unsent edit and offers Retry after a failed write.

## Types (`ui/src/ipc.ts`)

- `RadioMix`: `{ genres: RadioChoice[]; moods: RadioChoice[]; surprise: number /* 0–100 */; vocals: "any"|"vocal"|"instrumental"; energy: "any"|"low"|"medium"|"high"; lengthMinSeconds: number; lengthMaxSeconds: number; host: "off"|"sometimes"|"often"; language: string; theme: string }`. Out-of-range or reversed bounds are clamped to `lengthLimits` and put in order.
- `RadioChoice`: `{ name; on; custom }`. The 18 catalogue genres and 8 catalogue moods are always present; a mix sent without one gets it back, turned off. To add a custom name, append `{ name, on: true, custom: true }`. To remove a custom name, leave it out. The station sets `custom`. Names are cleaned to one line of up to 32 characters, and duplicates are dropped regardless of case. At most 40 genres and 24 moods.
- `RadioStation`: `{ id; name; builtin; active }`. A station keeps the pools, surprise, vocals, energy, length range and theme. `active` marks the station the mix sounds like now (same pools and choices), so it goes off once the listener edits the mix. The built-in stations are `drift`, `groove` and `explore`; they replace the old presets in `ui/src/radio.ts`.
- `RadioLock`: `{ genre; left: number | null }`, where `left` null means until unlocked.
- `RadioFeedback`: `"like" | "dislike"`.
- `RadioItem` gains `genre`, `mood` (null for requests, host breaks and songs from before the mix), `surprise`, `feedback` and `saved`.
- `Radio` gains `mix` (it replaces `direction`), `stations` (built-in first), `saved` (newest first; their `lyrics` and `script` are left out to keep the event small), `lock`, `lockSongs`, `weights` (lowercase genre → weight; an absent genre weighs 1) and `lengthLimits` (`{ min: 60, max: 300 }`, the lengths both engines reach). `making` gains `genre`, `mood` and `surprise`.
- The proto mirror (`crates/proto`, `ui/src/generated/proto.ts`) has `RadioMix`, `RadioChoice` and `RadioStation`, and its `RadioItem` gains the same fields (`favourite` became `saved`). Only the daemon's demo mode fills it.

## Engine limits

ACE-Step accepts 10–600 s. Both Turbo and XL Turbo support the full station length range.

## Upgrading a station

A `station.json` from before the mix (schema 1, with `direction`) loads as a mix with exactly its old genres and mood on (unknown names are added as custom), surprise 0, and its energy, vocals, host, language and theme kept. Its old length becomes a range around it: short becomes 1:15–2:00, medium 2:30–3:30, and long 3:30–5:00. It sounds as before. The file is saved back as schema 2 without `direction`.

## Not included

The "Duck the radio" setting is not built. `delulu speak` plays through its own `pw-play` process, and nothing tells the app when it is speaking. The only shared signal is its job lock, which is also held during installs and while the radio's own host lines are made. Ducking needs `delulu speak` to announce playback (for example a marker file or a socket message) and a gain stage in the player.
