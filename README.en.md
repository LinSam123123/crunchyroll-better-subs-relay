# Crunchyroll Better Subs Relay

Experimental local translation: choose Browser local translation (no key) in translation settings, select source and target languages, save, then click Prepare local translation. The browser downloads its model on first use. Keep this settings tab open and return to the player to translate. Completed cues appear progressively; pause and resume are supported. Automatic source selection prepares English; prepare another pair for other source languages. Availability depends on the browser, device and language pair. No automatic paid fallback or work-context/glossary prompting is used. Existing cloud settings and keys are retained.

[中文](README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Agent guide](AGENTS.md) · [Download Beta](https://github.com/LinSam123123/crunchyroll-better-subs-relay/releases)

An unofficial Crunchyroll subtitle extension for choosing official tracks, finding external subtitles, and translating with your own API when no suitable subtitles are available. This is a **Beta preview**. Feedback is welcome, but never post API keys or complete subtitle files in public issues.

Based on [Better Subs for Crunchyroll](https://github.com/anitastic-pixel/Better-Subs-for-Crunchyroll), with thanks to its creator, anitastic-pixel. This fork is not an official release from Crunchyroll or the upstream author.

## New in 2.7.0.33

- Experimental browser-local translation without an API key. Download the model on first use and keep the translation settings tab open.
- Fixed the narrow toolbar popup and refreshed the multilingual feature guide.
- Local translation is a free reading aid: short dialogue and idioms can be mistranslated. It is not enabled by default and never automatically falls back to a paid service.

## Features

- Mix audio and official subtitle languages; adjust subtitle size, appearance, and timing.
- Search assrt, SubDL, and Jimaku, or import local ASS, SSA, SRT, and VTT files.
- Choose a release version and episode. Follow the selected subtitle collection across episodes, without silently switching to another release. Optionally inherit its timing offset.
- Translate with DeepL or an OpenAI-compatible provider of your choice. Batch processing, concurrency, streaming, partial playback, and resuming unfinished work are supported.
- Choose search names from official regional titles, saved aliases, and offline Simplified/Traditional Chinese conversion. Optional AI title and episode analysis produces candidates for you to confirm.
- Export subtitles for personal proofreading and maintain work information and terminology for translation.
- Use the interface in English, Japanese, Simplified Chinese, or Traditional Chinese. It follows your browser by default and can be changed independently of subtitle languages.

**A translation API is optional.** Official tracks and local files need no translation key. External subtitle services require their own keys. Jimaku mainly provides Japanese subtitles; availability of other languages is not guaranteed. Korean documentation is available, but the interface does not yet have a Korean language pack.

## Install in Edge or Chrome

1. Download `crunchyroll-better-subs-relay-VERSION-beta.zip` from [Releases](https://github.com/LinSam123123/crunchyroll-better-subs-relay/releases) and extract it to a folder you will keep.
2. Open `edge://extensions` or `chrome://extensions`, enable Developer mode, and choose Load unpacked. Select the folder **directly containing `manifest.json`**.
3. Disable the original Better Subs extension and competing subtitle extensions to avoid conflicts. You do not need to delete their settings.
4. Refresh the Crunchyroll playback page. Use your own account and content you are authorized to watch.

Source users can load this repository's `extension/` folder directly.

## Update Without Losing Settings

1. Stop translation and temporarily disable the extension in the extension manager.
2. Extract the new ZIP to a temporary folder. Copy all its contents over the **original loaded folder**, keeping its path and the position of `manifest.json` unchanged. Do not add an extra nested folder.
3. Enable and reload the extension, check its version, and refresh the playback page.

An in-place update in the same browser profile does not require uninstalling or entering your keys again. Do not use Remove to update, and do not install a second copy. If the background fails to start after an update, save any unsubmitted work, fully exit the browser including background processes, and reopen it. Do not clear extension storage or disable browser security protections.

## Getting Started

**Interface language:** Use the language selector in the extension popup or translation settings. Language packs are bundled and need no API. This does not change subtitle text, the translation target, or your provider settings.

**Official subtitles:** Check the player's Better Subs menu for a suitable official track first.

**External subtitles:** Open the external-subtitle page and configure the chosen service's key. Check the work, season, episode, and search name. Select a directory, release version, and episode file, preview it, and load it into the player. To continue with the same collection, enable collection following before loading. When using assrt, subtitle services are provided by assrt.net.

Adjust timing in 100ms steps when needed. BD, Netflix, AT-X, and Crunchyroll releases may have different edits; a single offset cannot always align the whole episode. Prefer a release that matches your video.

**Machine translation:** Choose DeepL or a custom compatible provider. For a custom provider, enter its Base URL, such as `https://relay.example/v1`, your key, model, and supported protocol. Models are supplied by your provider, not by this extension. Start with a small sample; 15 lines per batch, concurrency 1, and a 60-second timeout can be a cautious starting point. Streaming requires support from the provider.

**Unrecognized titles or episode filenames:** Try official, English, or Japanese names, offline Chinese conversion, or manual edits first. Use API analysis only when needed. DeepL cannot perform this analysis; it is optional, or you can configure a separate compatible analysis provider. Review AI candidates before confirming them.

## Keys and Privacy

- No usable keys are included in the repository or download. Use your own accounts. Keys are stored locally by the browser extension; this is **not an encrypted vault**.
- Cloud translation sends subtitle text to your selected DeepL or compatible provider. Local translation does not send subtitles to those services; the initial model download requires internet access. AI analysis sends the relevant work information or filenames to your configured analysis service.
- Subtitle searches send keywords to the selected service; downloads contact its file server. Work information queries contact Bangumi, and official regional title queries contact Crunchyroll. Chinese script conversion is offline.
- Opening a page, changing episodes, or failing to find subtitles does not automatically start paid translation or AI analysis. Check each provider's prices and privacy terms.
- Access to service domains is requested as needed. Do not give real keys to unknown providers. Redact keys, account information, and temporary download links before sharing screenshots.
- No anime videos or finished subtitle collections are distributed. The extension does not bypass subscriptions, regional restrictions, or DRM. Respect each subtitle source's availability and usage rights.

## Limitations

- Interface localization does not translate filenames, titles, subtitle text, or user-entered information. Third-party results may be in other languages.
- Official regional titles may be unavailable or redirected. Offline Chinese conversion does not necessarily produce a work's conventional local title.
- Specials, missing episodes, ambiguous filenames, and multiple revisions may need manual selection. Following is limited to the confirmed work, season, and release version.
- External subtitles are not guaranteed to align with the current video. Automatic cross-language timeline alignment is not implemented.
- Sources may be incomplete, rate-limited, or unavailable, and machine translation can be wrong. Other releases, local imports, and smaller batches remain useful fallbacks.
- Automated browser tests use isolated mock players and APIs, not every real account, title, or browser environment.

## Feedback and Development

Report your extension version, browser version, reproduction steps, and sanitized error in [Issues](https://github.com/LinSam123123/crunchyroll-better-subs-relay/issues). Never attach keys, cookies, complete subtitle files, or personal browser profiles.

Development requires Node.js 22 or newer and npm:

```sh
npm ci
npm run verify
npm run privacy
npm run package
```

See [AGENTS.md](AGENTS.md) for architecture and browser tests, [CONTRIBUTING.md](CONTRIBUTING.md) for contributions, and [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing and provenance. This fork starts from a local copy of store version 2.7.0; it is not equivalent to upstream version 2.8.2.
